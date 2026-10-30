import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../../config/bot.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { COMPANY, COMPANY_DAY_MS, companyDaily } from '../../config/store/companies.js';
import { getEconomyKey } from '../../utils/database/keys.js';
import { Mutex } from '../../utils/mutex.js';
import { settleCompany, validateCompany } from './companyService.js';
import { companyNameIssue } from './companyNames.js';

const denied = (reason) => ({ ok: false, reason });
const snowflake = (id) => typeof id === 'string' && /^\d{16,22}$/u.test(id);

export async function canModerateCompanies(client, guildId, actorId) {
    if (!isHomeGuild(guildId) || !snowflake(actorId)) return false;
    if (isBotOwner(actorId)) return true;
    const guild = await client.guilds?.fetch(guildId);
    if (!guild) return false;
    if (guild.ownerId === actorId) return true;
    // Force a fresh permissions read at confirmation, rather than trusting a cached
    // slash interaction or a boolean supplied by a quote.
    const member = await guild.members.fetch({ user: actorId, force: true });
    return !!member?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

async function readRecord(client, guildId, targetId) {
    if (!snowflake(targetId) || !client?.db?.getStrict || client.db.isAvailable?.() === false || client.db.isDegraded?.()) {
        throw new Error('Persistent company storage unavailable');
    }
    const record = await client.db.getStrict(getEconomyKey(guildId, targetId), {});
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid company record');
    if (record.ccCompany && record.ccCompanyArchive) throw new Error('Conflicting company state');
    if (record.ccCompany) validateCompany(record.ccCompany);
    if (record.ccCompanyArchive) {
        const archive = record.ccCompanyArchive;
        validateCompany(archive.company);
        if (!Number.isSafeInteger(archive.archivedAt) || archive.archivedAt < 0 || !snowflake(archive.actorId)) {
            throw new Error('Invalid company archive');
        }
    }
    return record;
}

export async function companyModerationState(client, guildId, actorId, targetId) {
    if (!await canModerateCompanies(client, guildId, actorId)) return denied('permission');
    const record = await readRecord(client, guildId, targetId);
    return { ok: true, company: record.ccCompany || null, archive: record.ccCompanyArchive || null,
        version: record.ccCompany?.version ?? record.ccCompanyArchive?.company.version ?? 0 };
}

/** Reversible removal, never a refund/charge. The same member lock protects normal CC
 * changes, and the entire unmodified wallet plus company/archive is written once. */
export async function moderateCompany(client, guildId, actorId, targetId, action, {
    version, name, expiresAt, now = Date.now(),
} = {}) {
    if (!isHomeGuild(guildId) || !snowflake(targetId)) return denied('permission');
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)
        || expiresAt <= now || expiresAt > now + COMPANY.quoteMs) return denied('expired');
    return Mutex.runExclusive(`cc:${guildId}:${targetId}`, async () => {
        if (!await canModerateCompanies(client, guildId, actorId)) return denied('permission');
        const record = structuredClone(await readRecord(client, guildId, targetId));
        const current = record.ccCompany || record.ccCompanyArchive?.company;
        if (!current) return denied('missing');
        if (!Number.isSafeInteger(version) || current.version !== version) return denied('stale');
        if (current.version >= Number.MAX_SAFE_INTEGER) throw new Error('Company version overflow');
        if (action === 'archive') {
            if (!record.ccCompany) return denied('archived');
            const company = settleCompany(record.ccCompany, now);
            company.version += 1;
            record.ccCompanyArchive = { company, archivedAt: now, actorId };
            delete record.ccCompany;
        } else if (action === 'restore') {
            if (!record.ccCompanyArchive) return denied('not_archived');
            const issue = companyNameIssue(name);
            if (issue) return denied(issue);
            const company = record.ccCompanyArchive.company;
            company.name = name.trim();
            company.version += 1;
            company.nextPayoutAt = now + COMPANY_DAY_MS;
            company.upgradeAt = now + COMPANY.cooldownMs;
            company.rate = companyDaily(company);
            record.ccCompany = company;
            delete record.ccCompanyArchive;
        } else return denied('invalid');
        if (await client.db.set(getEconomyKey(guildId, targetId), record) === false) throw new Error('Failed to save company moderation');
        return { ok: true, action, targetId };
    });
}
