import { isHomeGuild } from '../../config/homeGuild.js';
import { COMPANY, COMPANY_DAY_MS, companyDaily, companyUpgradeCost } from '../../config/store/companies.js';
import { getEconomyKey } from '../../utils/database/keys.js';
import { Mutex } from '../../utils/mutex.js';
import { readCC, updatePersistentCCState } from './ccService.js';

const monthOf = (time) => new Date(time).toISOString().slice(0, 7);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const add = (left, right) => {
    const next = left + right;
    if (!integer(next)) throw new Error('Company value overflow');
    return next;
};
const blocked = (reason, extra = {}) => ({ ok: false, reason, skipSave: true, ...extra });

function requireHome(guildId) {
    if (!isHomeGuild(guildId)) throw new Error('Companies are available in the home guild only');
}

export function validCompanyName(name) {
    return typeof name === 'string' && /^[\p{L}\p{N} _.-]{2,32}$/u.test(name.trim());
}

export function validateCompany(company) {
    if (!company || company.schema !== 1 || !validCompanyName(company.name)
        || !['branches', 'quality', 'marketing'].every((key) => Number.isInteger(company[key]) && company[key] >= 1 && company[key] <= COMPANY.maxLevel)
        || !['treasury', 'invested', 'version', 'createdAt', 'nextPayoutAt', 'upgradeAt'].every((key) => integer(company[key]))
        || !company.rate || !['revenue', 'expenses', 'profit'].every((key) => integer(company.rate[key]))
        || company.rate.profit > COMPANY.maxDailyProfit || company.rate.profit !== company.rate.revenue - company.rate.expenses
        || !company.monthlyNet || typeof company.monthlyNet !== 'object'
        || Object.entries(company.monthlyNet).some(([month, amount]) => !/^\d{4}-\d{2}$/u.test(month) || !integer(amount))) {
        throw new Error('Invalid saved company; no data was changed');
    }
    return company;
}

/** Pure lazy settlement: one old-rate payout completes the running cycle. Upgrades become active
 * for the next full 24h cycle. Catch-up groups by UTC month, so years offline never loop per day. */
export function settleCompany(saved, now = Date.now()) {
    if (!integer(now)) throw new Error('Invalid company time');
    const company = structuredClone(validateCompany(saved));
    const pay = (count, rate) => {
        const profit = rate.profit * count;
        company.treasury = add(company.treasury, profit);
        const month = monthOf(company.nextPayoutAt);
        company.monthlyNet[month] = add(company.monthlyNet[month] || 0, profit);
        company.nextPayoutAt += count * COMPANY_DAY_MS;
    };
    if (company.nextPayoutAt <= now) {
        pay(1, company.rate);
        company.rate = companyDaily(company);
    }
    while (company.nextPayoutAt <= now) {
        const date = new Date(company.nextPayoutAt);
        const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
        const throughMonth = Math.ceil((nextMonth - company.nextPayoutAt) / COMPANY_DAY_MS);
        const throughNow = Math.floor((now - company.nextPayoutAt) / COMPANY_DAY_MS) + 1;
        pay(Math.min(throughMonth, throughNow), company.rate);
    }
    return company;
}

function snapshot(record, now) {
    const company = record?.ccCompany ? settleCompany(record.ccCompany, now) : null;
    return { company, balance: readCC(record || {}).cc, version: company?.version || 0 };
}

export async function getCompany(client, guildId, userId, { now = Date.now() } = {}) {
    requireHome(guildId);
    if (!client?.db?.getStrict || client.db.isAvailable?.() === false || client.db.isDegraded?.()) throw new Error('Persistent database unavailable');
    return snapshot(await client.db.getStrict(getEconomyKey(guildId, userId), {}), now);
}

/** All monetary state is in ONE member record, committed once under the existing CC mutex.
 * A failed authoritative read/write never becomes a new empty wallet or a successful receipt. */
export async function companyAction(client, guildId, userId, action, {
    name, kind, amount, version, cost, now = Date.now(), expiresAt,
} = {}) {
    requireHome(guildId);
    if (!integer(now)) return blocked('invalid');
    if (!integer(expiresAt) || expiresAt <= now || expiresAt > now + COMPANY.quoteMs) return blocked('expired');
    return updatePersistentCCState(client, guildId, userId, (state, record) => {
        let company = record.ccCompany ? settleCompany(record.ccCompany, now) : null;
        if (!integer(version) || version !== (company?.version || 0)) return blocked('stale');
        if (action === 'create') {
            if (company) return blocked('owned');
            if (!validCompanyName(name)) return blocked('name');
            if (cost !== COMPANY.createCost) return blocked('stale');
            if (state.cc < cost) return blocked('no_cc');
            state.cc -= cost;
            state.stats.spent = add(state.stats.spent, cost);
            company = {
                schema: 1, name: name.trim(), branches: 1, quality: 1, marketing: 1,
                treasury: 0, invested: cost, version: 1, createdAt: now,
                nextPayoutAt: now + COMPANY_DAY_MS, upgradeAt: now + COMPANY.cooldownMs, monthlyNet: {},
            };
            company.rate = companyDaily(company);
        } else {
            if (!company) return blocked('missing');
            if (action === 'upgrade') {
                const price = companyUpgradeCost(company, kind);
                if (price === null) return blocked('max');
                if (price !== cost) return blocked('stale');
                if (company.upgradeAt > now) return blocked('cooldown', { until: company.upgradeAt });
                if (company.treasury + state.cc < price) return blocked('no_cc');
                const reinvested = Math.min(company.treasury, price);
                company.treasury -= reinvested;
                state.cc -= price - reinvested;
                state.stats.spent = add(state.stats.spent, price - reinvested);
                company.invested = add(company.invested, price);
                company[kind] += 1;
                company.upgradeAt = now + COMPANY.cooldownMs;
            } else if (action === 'withdraw') {
                if (!Number.isSafeInteger(amount) || amount <= 0) return blocked('amount');
                if (company.treasury < amount) return blocked('treasury');
                company.treasury -= amount;
                state.cc = add(state.cc, amount);
                state.stats.earned = add(state.stats.earned, amount);
            } else return blocked('invalid');
            company.version += 1;
        }
        record.ccCompany = company;
        return { ok: true, company, action };
    });
}

export const companyValue = (company) => add(company.invested, company.treasury);

/** Read-only projection of member rows; only the decorative season archive is written.
 * A full strict scan must succeed before a month can be finalized. No rewards/roles/CC are granted. */
export async function companyLeaderboard(client, guildId, { now = Date.now() } = {}) {
    requireHome(guildId);
    if (!client?.db?.getEconomyRowsStrict || client.db.isAvailable?.() === false || client.db.isDegraded?.()) throw new Error('Persistent database unavailable');
    return Mutex.runExclusive(`company-seasons:${guildId}`, async () => {
        const records = await client.db.getEconomyRowsStrict(guildId);
        const rows = records.filter(({ record }) => record?.ccCompany).map(({ userId, record }) => ({
            userId, company: settleCompany(record.ccCompany, now),
        }));
        const currentMonth = monthOf(now);
        const seasonKey = `guild:${guildId}:company-seasons`;
        const seasons = structuredClone(await client.db.getStrict(seasonKey, {}));
        if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons)) throw new Error('Invalid company seasons');
        let changed = false;
        const months = new Set(rows.flatMap(({ company }) => Object.keys(company.monthlyNet)).filter((month) => month < currentMonth));
        for (const month of [...months].sort()) {
            if (seasons[month]) continue;
            const winners = [...rows].sort((a, b) => (b.company.monthlyNet[month] || 0) - (a.company.monthlyNet[month] || 0) || a.userId.localeCompare(b.userId));
            const winner = winners[0];
            if (!(winner?.company.monthlyNet[month] > 0)) continue;
            seasons[month] = { userId: winner.userId, name: winner.company.name, profit: winner.company.monthlyNet[month], title: 'ملك المطاعم' };
            changed = true;
        }
        if (changed && await client.db.set(seasonKey, seasons) === false) throw new Error('Failed to save company seasons');
        return {
            month: currentMonth, seasons,
            value: [...rows].sort((a, b) => companyValue(b.company) - companyValue(a.company) || a.userId.localeCompare(b.userId)),
            monthly: [...rows].sort((a, b) => (b.company.monthlyNet[currentMonth] || 0) - (a.company.monthlyNet[currentMonth] || 0) || a.userId.localeCompare(b.userId)),
        };
    });
}
