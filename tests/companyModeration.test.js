import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { HOME_GUILD_ID as GUILD } from '../src/config/homeGuild.js';
import { GAMES_BOTS_CHANNEL_ID as CHANNEL } from '../src/config/games.js';
import { COMPANY, COMPANY_DAY_MS as DAY } from '../src/config/store/companies.js';
import { getEconomyKey, getGuildConfigKey } from '../src/utils/database/keys.js';
import { companyAction, companyLeaderboard, getCompany, validateCompany } from '../src/services/cc/companyService.js';
import { canModerateCompanies, moderateCompany } from '../src/services/cc/companyModeration.js';
import { companyNameIssue, forbiddenCompanyName, normalizeCompanyName } from '../src/services/cc/companyNames.js';
import { companyPanel, companiesPanel, quoteCompanyAction, quoteCompanyModeration, getCompanyQuote, companyConfirmation } from '../src/services/cc/companyUi.js';
import buttons from '../src/interactions/buttons/store/company.js';
import command from '../src/commands/Games/company.js';
import { applyWordAliases } from '../src/config/commands/commandAliases.js';
import { botConfig } from '../src/config/bot.js';
import { createMockInteraction } from '../src/utils/messageAdapter.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';
import { checkText } from '../src/services/moderation/chatFilterRules.js';
import { checkText as chatRule } from '../src/services/moderation/chatFilterService.js';

const OWNER = '200000000000000261';
const ACTOR = '200000000000000262';
const OTHER = '200000000000000263';
const START = Date.UTC(2026, 0, 1, 12);
const ABUSE = ['سكس', 'أطفال'].join(' ');
const key = getEconomyKey(GUILD, OWNER);
const options = (now, values = {}) => ({ now, expiresAt: now + COMPANY.quoteMs, ...values });

function fixture() {
    const records = new Map([[key, { cc: 1_000_000, keep: { role: 'untouched' }, ccStats: { spent: 0 } }]]);
    const client = { records, manager: true, freshChecks: 0, failSave: false, db: {
        isAvailable: () => true, isDegraded: () => false,
        getStrict: async (k, fallback = null) => structuredClone(records.get(k) ?? fallback),
        set: async (k, data) => { if (client.failSave) return false; records.set(k, structuredClone(data)); return true; },
        getEconomyRowsStrict: async () => [...records].filter(([k]) => k.includes(':economy:'))
            .map(([k, record]) => ({ userId: k.split(':').at(-1), record: structuredClone(record) })),
    }, guilds: { fetch: async (guildId) => {
        assert.equal(guildId, GUILD);
        return { ownerId: OTHER, members: { fetch: async ({ user, force }) => {
            client.freshChecks += 1; assert.equal(force, true);
            return { permissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild && client.manager && user === ACTOR } };
        } } };
    } } };
    return client;
}

async function create(client, now = START) {
    return companyAction(client, GUILD, OWNER, 'create', options(now, { name: 'مطعم عائلي', cost: COMPANY.createCost, version: 0 }));
}

const quoteId = (payload) => payload.components[0].components[0].data.custom_id.split(':').at(-1);
function clickInteraction(actor = ACTOR) {
    const outputs = [];
    return { outputs, user: { id: actor }, guildId: GUILD, channel: { id: CHANNEL }, inGuild: () => true,
        deferUpdate: async () => {}, reply: async (p) => outputs.push(p), editReply: async (p) => outputs.push(p) };
}

test('blocked-name normalization catches spacing, accents, presentation forms and invisible marks without banning family restaurants', () => {
    const names = [ABUSE, ABUSE.replace(' ', '_'), ABUSE.replace(' ', ' . - '), ['سَـكْس', 'أطفال'].join(' '),
        ['س\u200dكس', 'اط\u200bفال'].join(' '), 'اسم ' + ABUSE, ['سكس', 'للأطفال'].join(' '),
        'child-porn', 'porn with kids', 'children porn', 'kids porn', 'child p0rn', 'children s3x'];
    for (const name of names) assert.equal(forbiddenCompanyName(name), true);
    assert.equal(normalizeCompanyName('أ . طـْفَا ل'), 'اطفال');
    for (const name of ['مطعم أطفال', 'مطعم العائلة', 'Kids Restaurant', 'جنسن للمأكولات']) assert.equal(companyNameIssue(name), null);
});

test('company names share server word rules and reject explicit adult names without substring false positives', () => {
    assert.equal(chatRule, checkText, 'chat and company use one pure rule implementation');
    const blockedNames = ['مطعم الدعارة', 'دار د ع ا ر ة', 'دار د.ع.ا.ر.ة', 'ﺩﻋﺎﺭﺓ', 'دَعاَرة',
        'مؤسسة سكس', 's3x restaurant', 'p0rn cafe', 'b r o t h e l', 'مطعم شرموطه', 'شركة الحفره', 'a3ars cafe',
        'دع اره', 'دع.اره', 'دعا-ره', 'pro stitution', 'por n', 'مطعم دع.اره', 'مطعم الدع.اره',
        'my s e x', 'my p0r n cafe', 'مطعم شر موطه', 'مطعم شر.موطه', 'kha wal cafe', 'kh awal cafe', 'شركة الح فره'];
    for (const name of blockedNames) assert.equal(companyNameIssue(name), 'forbidden_name', name);
    for (const name of ['Essex Restaurant', 'Middlesex Meals', 'Sussex Diner', 'مطعم أطفال', 'مطعم العائلة', 'Kids Restaurant',
        'جنسن للمأكولات', 'خوله للمأكولات', 'ابن العم', 'ابن ال عم', 'مطعم ابن الحلال', 'Nick Restaurant', 'نيكول للمأكولات']) {
        assert.equal(companyNameIssue(name), null, name);
    }
    assert.equal(companyNameIssue('a'.repeat(33)), 'name');
    assert.equal(companyNameIssue('a'.repeat(32)), null);
    assert.equal(companyNameIssue('شر موطه '.repeat(1000)), 'name', 'oversized input is rejected before bounded policy work');
});

test('ordinary, Trusted and privileged owners get identical name rejection in prefix, slash and old confirmations', async () => {
    const originalOwners = botConfig.commands.owners;
    try {
        for (const role of ['member', 'trusted', 'manager', 'guild-owner', 'bot-owner']) {
            const client = fixture();
            client.records.set(getGuildConfigKey(GUILD), { antiNukeTrustedUsers: role === 'trusted' ? [OWNER] : [] });
            botConfig.commands.owners = role === 'bot-owner' ? [OWNER] : [];
            const guild = { id: GUILD, ownerId: role === 'guild-owner' ? OWNER : OTHER };
            const member = { id: OWNER, roles: { cache: new Map(role === 'trusted' ? [['trusted-role', { name: 'Trusted' }]] : []) },
                permissions: { has: () => role === 'manager' } };
            const before = structuredClone(client.records.get(key));
            for (const prefix of [false, true]) {
                const outputs = [];
                let interaction;
                if (prefix) {
                    const parsed = parseTypedCommand('شركة إنشاء مطعم الدعارة', '!');
                    const args = command.normalizePrefixArgs(applyWordAliases(parsed.commandName, parsed.args, parsed.prefixed).args);
                    interaction = createMockInteraction({ id: OWNER, author: { id: OWNER, bot: false }, member, guild,
                        channel: { id: CHANNEL, send: async (p) => { outputs.push(p); return { id: 'reply' }; } } }, command.data, args);
                } else {
                    interaction = { id: OWNER, user: { id: OWNER }, member, guild, guildId: GUILD, channel: { id: CHANNEL }, channelId: CHANNEL,
                        deferred: false, replied: false, options: { getSubcommand: () => 'create', getString: () => 'مطعم الدعارة' },
                        deferReply: async function () { this.deferred = true; },
                        editReply: async (p) => outputs.push(p), reply: async (p) => outputs.push(p) };
                }
                await command.execute(interaction, {}, client);
                assert.match(outputs[0].content, /ممنوع/, `${role}/${prefix ? 'prefix' : 'slash'}`);
                assert.deepEqual(outputs[0].components, []);
            }
            const oldQuote = companyConfirmation(GUILD, OWNER, { action: 'create', name: 'مطعم الدعارة', cost: COMPANY.createCost, version: 0 });
            const click = clickInteraction(OWNER);
            await buttons.execute(click, client, ['confirm', quoteId(oldQuote)]);
            assert.match(click.outputs[0].content, /ممنوع/, role);
            assert.deepEqual(client.records.get(key), before, role);
        }
    } finally { botConfig.commands.owners = originalOwners; }
});

test('manager, guild owner and bot owner cannot restore an adult forbidden name even from an old quote', async () => {
    const originalOwners = botConfig.commands.owners;
    try {
        for (const role of ['manager', 'guild-owner', 'bot-owner']) {
            botConfig.commands.owners = [];
            const client = fixture(); await create(client);
            await moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(START, { version: 1 }));
            if (role === 'guild-owner') client.guilds.fetch = async () => ({ ownerId: ACTOR });
            if (role === 'bot-owner') botConfig.commands.owners = [ACTOR];
            const before = structuredClone(client.records.get(key));
            const preview = await quoteCompanyModeration(client, GUILD, ACTOR, OWNER, 'restore', 'مطعم الدعارة');
            assert.match(preview.content, /ممنوع/, role);
            const oldQuote = companyConfirmation(GUILD, ACTOR, { action: 'restore', targetId: OWNER, name: 'مطعم الدعارة', version: 2 });
            const click = clickInteraction();
            await buttons.execute(click, client, ['confirm', quoteId(oldQuote)]);
            assert.match(click.outputs[0].content, /ممنوع/, role);
            assert.deepEqual(client.records.get(key), before, role);
        }
    } finally { botConfig.commands.owners = originalOwners; }
});

test('company holds also block old moderation confirmations without preventing owner cancellation', async () => {
    const client = fixture(); await create(client);
    const preview = await quoteCompanyModeration(client, GUILD, ACTOR, OWNER, 'archive', undefined);
    client.records.set(getGuildConfigKey(GUILD), { disabledCommands: { 'company archive': true } });
    const before = structuredClone(client.records.get(key));
    const click = clickInteraction();
    await buttons.execute(click, client, ['confirm', quoteId(preview)]);
    assert.match(click.outputs[0].content, /متوقفة/);
    assert.deepEqual(client.records.get(key), before);
    const next = await quoteCompanyModeration(client, GUILD, ACTOR, OWNER, 'archive', undefined);
    await buttons.execute(click, client, ['cancel', quoteId(next)]);
    assert.match(click.outputs.at(-1).content, /اتلغت/);
    assert.deepEqual(client.records.get(key), before);
});

test('creation checks the policy before quoting and again under the monetary lock', async () => {
    const client = fixture();
    const before = structuredClone(client.records.get(key));
    const preview = await quoteCompanyAction(client, GUILD, OWNER, { action: 'create', name: ABUSE }, { now: START });
    assert.match(preview.content, /ممنوع/); assert.deepEqual(preview.components, []);
    assert.equal((await companyAction(client, GUILD, OWNER, 'create', options(START, { name: ABUSE, cost: COMPANY.createCost, version: 0 }))).reason, 'forbidden_name');
    assert.deepEqual(client.records.get(key), before);
});

test('old unsafe names remain structurally readable but never reappear in panels, rankings or confirmations', async () => {
    const client = fixture(); await create(client);
    client.records.get(key).ccCompany.name = ABUSE;
    assert.doesNotThrow(() => validateCompany(client.records.get(key).ccCompany));
    for (const output of [await companyPanel(client, GUILD, OWNER, { now: START }), await companiesPanel(client, GUILD, { now: START })]) {
        assert.equal(JSON.stringify(output).includes(ABUSE), false);
        assert.match(JSON.stringify(output), /محجوب/);
    }
    assert.equal((await companyAction(client, GUILD, OWNER, 'upgrade', options(START + DAY, { version: 1, kind: 'quality', cost: COMPANY.qualityCosts[0] }))).reason, 'forbidden_name');
});

test('archive preserves every wallet field and accrued treasury, freezes earning and hides active rankings', async () => {
    const client = fixture(); await create(client);
    const original = structuredClone(client.records.get(key));
    const archivedAt = START + 2 * DAY;
    assert.equal((await moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(archivedAt, { version: 1 }))).ok, true);
    const saved = client.records.get(key);
    const { ccCompany: ignored, ...wallet } = original;
    const { ccCompanyArchive: archive, ...after } = saved;
    assert.deepEqual(after, wallet);
    assert.equal(archive.company.treasury, 800);
    assert.equal(archive.archivedAt, archivedAt);
    assert.equal(archive.company.version, 2);
    const panel = await getCompany(client, GUILD, OWNER, { now: START + 100 * DAY });
    assert.equal(panel.archived, true); assert.equal(panel.company, null);
    const board = await companyLeaderboard(client, GUILD, { now: START + 100 * DAY });
    assert.equal(board.value.length, 0); assert.equal(board.monthly.length, 0);
    assert.equal(board.seasons['2026-01'].profit, 800, 'only historical earned profit participates');
    assert.equal(client.records.get(key).ccCompanyArchive.company.treasury, 800);
    for (const action of ['create', 'withdraw', 'upgrade']) assert.equal((await companyAction(client, GUILD, OWNER, action, options(START + 100 * DAY, { version: 0 }))).reason, 'archived');
});

test('restoration requires a safe name and resumes future cycles without archived-time profits or wallet changes', async () => {
    const client = fixture(); await create(client);
    await moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(START + DAY, { version: 1 }));
    const before = structuredClone(client.records.get(key));
    const now = START + 10 * DAY;
    assert.equal((await moderateCompany(client, GUILD, ACTOR, OWNER, 'restore', options(now, { name: ABUSE, version: 2 }))).reason, 'forbidden_name');
    assert.deepEqual(client.records.get(key), before);
    assert.equal((await moderateCompany(client, GUILD, ACTOR, OWNER, 'restore', options(now, { name: 'مطعم الأسرة', version: 2 }))).ok, true);
    const restored = client.records.get(key);
    assert.equal(restored.ccCompanyArchive, undefined);
    assert.equal(restored.cc, before.cc);
    assert.deepEqual(restored.ccStats, before.ccStats);
    assert.equal(restored.ccCompany.treasury, 400);
    assert.deepEqual(restored.ccCompany.monthlyNet, before.ccCompanyArchive.company.monthlyNet);
    assert.equal(restored.ccCompany.nextPayoutAt, now + DAY);
    assert.equal(restored.ccCompany.upgradeAt, now + DAY);
    assert.equal(restored.ccCompany.version, 3);
    assert.equal((await getCompany(client, GUILD, OWNER, { now: now + DAY })).company.treasury, 800);
});

test('service authorization is checked at mutation time and never trusts quote permission booleans', async () => {
    const client = fixture(); await create(client);
    assert.equal(await canModerateCompanies(client, GUILD, ACTOR), true);
    client.manager = false;
    const result = await moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(START, { version: 1, authorized: true }));
    assert.equal(result.reason, 'permission');
    assert.ok(client.records.get(key).ccCompany);
    assert.equal(await canModerateCompanies(client, '100000000000000001', ACTOR), false);
    assert.equal((await moderateCompany(client, GUILD, OWNER, OWNER, 'archive', options(START, { version: 1 }))).reason, 'permission');
    assert.ok(client.freshChecks >= 3);
});

test('parallel, expired and stale moderation cannot repeat or change the wrong company', async () => {
    const client = fixture(); await create(client);
    const results = await Promise.all([1, 2].map(() => moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(START, { version: 1 }))));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const before = structuredClone(client.records.get(key));
    assert.equal((await moderateCompany(client, GUILD, ACTOR, OWNER, 'restore', { version: 2, name: 'مطعم الأسرة', now: START, expiresAt: START })).reason, 'expired');
    assert.equal((await moderateCompany(client, GUILD, ACTOR, OWNER, 'restore', options(START, { version: 1, name: 'مطعم الأسرة' }))).reason, 'stale');
    assert.deepEqual(client.records.get(key), before);
});

test('archive save failure keeps the whole original company and wallet intact', async () => {
    const client = fixture(); await create(client);
    const before = structuredClone(client.records.get(key)); client.failSave = true;
    await assert.rejects(moderateCompany(client, GUILD, ACTOR, OWNER, 'archive', options(START, { version: 1 })), /Failed to save/);
    assert.deepEqual(client.records.get(key), before);
});

test('moderation confirmations bind acting manager, target, guild, version and recheck revoked permissions', async () => {
    const client = fixture(); await create(client);
    const preview = await quoteCompanyModeration(client, GUILD, ACTOR, OWNER, 'archive', undefined);
    const id = quoteId(preview);
    assert.equal(getCompanyQuote(id).targetId, OWNER);
    assert.equal(getCompanyQuote(id).userId, ACTOR);
    assert.match(preview.embeds[0].description, /مفيش رد أو خصم/);
    const intruder = clickInteraction(OWNER);
    await buttons.execute(intruder, client, ['confirm', id]);
    assert.equal(intruder.outputs[0].flags, MessageFlags.Ephemeral);
    assert.ok(client.records.get(key).ccCompany);
    client.manager = false;
    const manager = clickInteraction();
    await buttons.execute(manager, client, ['confirm', id]);
    assert.match(manager.outputs[0].content, /صلاحية/);
    assert.ok(client.records.get(key).ccCompany);
    client.manager = true;
    const next = await quoteCompanyModeration(client, GUILD, ACTOR, OWNER, 'archive', undefined);
    await buttons.execute(manager, client, ['confirm', quoteId(next)]);
    assert.match(manager.outputs.at(-1).content, /اتوقفت/);
    assert.ok(client.records.get(key).ccCompanyArchive);
});

test('admin prefix and slash parsing are explicit without interpreting casual chat', () => {
    const mention = `<@${OWNER}>`;
    assert.deepEqual(command.normalizePrefixArgs(['إيقاف', mention]), ['archive', mention]);
    assert.deepEqual(command.normalizePrefixArgs(['استرجاع', mention, 'مطعم', 'الأسرة']), ['restore', mention, 'مطعم الأسرة']);
    assert.equal(applyWordAliases('شركة', ['ايقاف', mention], false).commandName, 'شركة');
    assert.equal(applyWordAliases('شركة', ['جميلة'], false), null);
    const options = command.data.toJSON().options;
    assert.equal(options.find((sub) => sub.name === 'archive').options[0].type, 6);
    assert.equal(options.find((sub) => sub.name === 'restore').options[1].name, 'name');
});

test('sensitive slash previews are deferred privately before any storage or manager check', async () => {
    const client = fixture(); await create(client);
    for (const sub of ['create', 'archive', 'restore']) {
        let acknowledged = false;
        const originalRead = client.db.getStrict;
        client.db.getStrict = async (...args) => { assert.equal(acknowledged, true); return originalRead(...args); };
        const interaction = {
            id: '200000000000000264', user: { id: ACTOR }, guildId: GUILD, channelId: CHANNEL, channel: { id: CHANNEL },
            deferred: false, replied: false,
            options: { getSubcommand: () => sub, getString: () => 'مطعم الأسرة', getUser: () => ({ id: OWNER }) },
            deferReply: async function (options) { assert.equal(options.flags, MessageFlags.Ephemeral); acknowledged = true; this.deferred = true; },
            editReply: async () => {}, reply: async () => { throw new Error('must defer before reply'); },
        };
        await command.execute(interaction, {}, client);
        assert.equal(acknowledged, true);
        client.db.getStrict = originalRead;
    }
});
