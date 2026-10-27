import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { COMPANY, COMPANY_DAY_MS as DAY, companyDaily, companyUpgradeCost } from '../src/config/store/companies.js';
import { getEconomyKey } from '../src/utils/database/keys.js';
import { adjustCC, getProfile, spendCC } from '../src/services/cc/ccService.js';
import { companyAction, getCompany, companyLeaderboard, settleCompany, validCompanyName } from '../src/services/cc/companyService.js';

const GUILD = HOME_GUILD_ID;
const USER = '200000000000000250';
const START = Date.UTC(2026, 0, 30, 12);
const key = (userId = USER) => getEconomyKey(GUILD, userId);

function clientWith(balance = 10_000_000) {
    const records = new Map([[key(), { cc: balance, ccInventory: { keepsake: 3 }, ccBourse: { car: { qty: 2, cost: 2600 } }, ccStreak: { count: 7 } }]]);
    const client = { records, failRead: false, failWrite: false, writes: 0, db: {
        isAvailable: () => true, isDegraded: () => false,
        get: async (key, fallback = null) => records.has(key) ? structuredClone(records.get(key)) : structuredClone(fallback),
        getStrict: async (key, fallback = null) => {
            if (client.failRead) throw new Error('read failed');
            return records.has(key) ? structuredClone(records.get(key)) : structuredClone(fallback);
        },
        set: async (key, value) => {
            client.writes += 1;
            if (client.failWrite) return false;
            records.set(key, structuredClone(value)); return true;
        },
        getEconomyRowsStrict: async () => {
            if (client.failRead) throw new Error('scan failed');
            return [...records].filter(([id]) => id.startsWith(`guild:${GUILD}:economy:`))
                .map(([id, record]) => ({ userId: id.split(':').at(-1), record: structuredClone(record) }));
        },
    } };
    return client;
}

const options = (now, extra = {}) => ({ now, expiresAt: now + COMPANY.quoteMs, ...extra });
const create = (client, userId = USER, now = START) => companyAction(client, GUILD, userId, 'create', options(now, { name: 'مطعم أوسكار', version: 0, cost: COMPANY.createCost }));
async function upgrade(client, kind, now, userId = USER) {
    const { company, version } = await getCompany(client, GUILD, userId, { now });
    return companyAction(client, GUILD, userId, 'upgrade', options(now, { kind, version, cost: companyUpgradeCost(company, kind) }));
}

test('creation charges exactly once and preserves unrelated member data in one record commit', async () => {
    const client = clientWith();
    const result = await create(client);
    assert.equal(result.ok, true);
    assert.equal(result.balance, 10_000_000 - COMPANY.createCost);
    assert.equal(client.writes, 1);
    const record = client.records.get(key());
    assert.deepEqual(record.ccBourse, { car: { qty: 2, cost: 2600 } });
    assert.deepEqual(record.ccInventory, { keepsake: 3 });
    assert.equal(record.ccStreak.count, 7);
    assert.equal(record.ccCompany.nextPayoutAt, START + DAY);
    assert.equal(record.ccCompany.treasury, 0);
    assert.equal((await create(client)).ok, false);
    assert.equal(client.writes, 1);
});

test('parallel creation and repeated confirmations cannot duplicate a company or charge', async () => {
    const client = clientWith();
    const results = await Promise.all([create(client), create(client), create(client)]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(client.writes, 1);
});

test('name validation excludes mentions, control characters and formatting while supporting Arabic', async () => {
    for (const name of ['مطعم أوسكار', 'OSKAR Foods', 'مطعم-2']) assert.equal(validCompanyName(name), true);
    for (const name of ['a', '', '@everyone', '<@123>', '**test**', 'a\nb', 'a'.repeat(33)]) assert.equal(validCompanyName(name), false, name);
    const client = clientWith();
    const result = await companyAction(client, GUILD, USER, 'create', options(START, { version: 0, cost: COMPANY.createCost, name: '@everyone' }));
    assert.equal(result.reason, 'name');
    assert.equal(client.writes, 0);
});

test('insufficient funds and wrong guild never modify a wallet', async () => {
    const client = clientWith(COMPANY.createCost - 1);
    assert.equal((await create(client)).reason, 'no_cc');
    await assert.rejects(companyAction(client, '100000000000000250', USER, 'create', options(START)), /home guild/);
    await assert.rejects(getCompany(client, '100000000000000250', USER), /home guild/);
    assert.equal(client.writes, 0);
});

test('no payout before a full 24h; exact boundary pays once through restart and repeated reads', async () => {
    const client = clientWith();
    await create(client);
    const rate = companyDaily({ branches: 1, quality: 1, marketing: 1 }).profit;
    assert.equal((await getCompany(client, GUILD, USER, { now: START + DAY - 1 })).company.treasury, 0);
    assert.equal((await getCompany(client, GUILD, USER, { now: START + DAY })).company.treasury, rate);
    assert.equal(client.writes, 1, 'view is read-only');
    const persisted = client.records.get(key());
    const restarted = clientWith();
    restarted.records.set(key(), structuredClone(persisted));
    for (let i = 0; i < 3; i += 1) assert.equal((await getCompany(restarted, GUILD, USER, { now: START + DAY })).company.treasury, rate);
    const result = await companyAction(restarted, GUILD, USER, 'withdraw', options(START + DAY, { version: 1, amount: rate }));
    assert.equal(result.ok, true);
    assert.equal(result.company.treasury, 0);
    assert.equal((await getCompany(restarted, GUILD, USER, { now: START + DAY })).company.treasury, 0);
    assert.equal(result.balance, persisted.cc + rate);
});

test('shared cooldown persists and upgrades affect only the next full payout cycle', async () => {
    const client = clientWith();
    await create(client);
    assert.equal((await upgrade(client, 'quality', START + DAY - 1)).reason, 'cooldown');
    const first = await upgrade(client, 'quality', START + DAY + DAY / 2);
    assert.equal(first.ok, true);
    assert.equal(first.company.quality, 2);
    assert.equal(first.company.rate.profit, 400);
    assert.equal((await upgrade(client, 'marketing', START + 2 * DAY)).reason, 'cooldown');
    const atSecond = (await getCompany(client, GUILD, USER, { now: START + 2 * DAY })).company;
    assert.equal(atSecond.treasury, 400, 'second payout uses old current-cycle rate');
    assert.equal(atSecond.rate.profit, 450);
    const atThird = (await getCompany(client, GUILD, USER, { now: START + 3 * DAY })).company;
    assert.equal(atThird.treasury, 850, 'third payout uses upgraded rate');
});

test('upgrade reinvests treasury first then takes only remaining amount from wallet', async () => {
    const client = clientWith();
    await create(client);
    const before = client.records.get(key()).cc;
    const upgraded = await upgrade(client, 'quality', START + 10 * DAY);
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.company.treasury, 0);
    assert.equal(upgraded.balance, before - (COMPANY.qualityCosts[0] - 4000));
    assert.equal(upgraded.company.invested, COMPANY.createCost + COMPANY.qualityCosts[0]);
    assert.equal(upgraded.company.monthlyNet['2026-01'], 400);
    assert.equal(upgraded.company.monthlyNet['2026-02'], 3600);
});

test('all upgrades cap at five, prices rise and daily returns stay bounded with capacity-limited demand', async () => {
    const client = clientWith(20_000_000);
    await create(client);
    let now = START;
    for (const kind of ['branches', 'quality', 'marketing']) {
        let last = 0;
        for (let level = 2; level <= 5; level += 1) {
            now += DAY;
            const current = (await getCompany(client, GUILD, USER, { now })).company;
            const cost = companyUpgradeCost(current, kind);
            assert.ok(cost > last); last = cost;
            assert.equal((await upgrade(client, kind, now)).ok, true);
        }
        assert.equal((await upgrade(client, kind, now + DAY)).reason, 'max');
    }
    const final = (await getCompany(client, GUILD, USER, { now: now + 2 * DAY })).company;
    assert.deepEqual([final.branches, final.quality, final.marketing], [5, 5, 5]);
    assert.equal(final.rate.profit, 4000);
    assert.ok(final.rate.profit <= COMPANY.maxDailyProfit);
    assert.equal(companyDaily({ branches: 1, quality: 1, marketing: 5 }).profit, 400);
});

test('withdrawals reject invalid amounts and stale or expired quotes with no changes', async () => {
    const client = clientWith(); await create(client);
    const before = structuredClone(client.records.get(key()));
    for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal((await companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { version: 1, amount }))).reason, 'amount');
    }
    assert.equal((await companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { version: 1, amount: 401 }))).reason, 'treasury');
    assert.equal((await companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { version: 0, amount: 1 }))).reason, 'stale');
    assert.equal((await companyAction(client, GUILD, USER, 'withdraw', { now: START + DAY, expiresAt: START + DAY, version: 1, amount: 1 })).reason, 'expired');
    assert.deepEqual(client.records.get(key()), before);
});

test('concurrent withdrawals, upgrades and existing CC spend share the member mutex', async () => {
    const client = clientWith(COMPANY.createCost + 40_000); await create(client);
    const now = START + DAY;
    const results = await Promise.all([
        companyAction(client, GUILD, USER, 'withdraw', options(now, { version: 1, amount: 400 })),
        companyAction(client, GUILD, USER, 'withdraw', options(now, { version: 1, amount: 400 })),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(client.records.get(key()).cc, 40_400);
    const both = await Promise.all([spendCC(client, GUILD, USER, 40_000), upgrade(client, 'quality', now)]);
    assert.equal(both.filter((result) => result.ok).length, 1);
    assert.equal(client.records.get(key()).cc, 400);
});

test('failed read, degraded database or failed write cannot reset member data or confirm success', async () => {
    const client = clientWith(); await create(client);
    const before = structuredClone(client.records.get(key()));
    client.failRead = true;
    await assert.rejects(companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { amount: 400, version: 1 })), /read failed/);
    client.failRead = false; client.failWrite = true;
    await assert.rejects(companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { amount: 400, version: 1 })), /Failed to save CC/);
    client.failWrite = false; client.db.isDegraded = () => true;
    await assert.rejects(companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { amount: 400, version: 1 })), /Persistent/);
    assert.deepEqual(client.records.get(key()), before);
});

test('corrupt company and numeric overflow fail closed', async () => {
    const client = clientWith(); await create(client);
    const good = structuredClone(client.records.get(key()));
    client.records.get(key()).ccCompany.branches = 10;
    await assert.rejects(getCompany(client, GUILD, USER, { now: START + DAY }), /Invalid saved company/);
    assert.throws(() => settleCompany({ ...good.ccCompany, treasury: Number.MAX_SAFE_INTEGER }, START + DAY), /overflow/);
    client.records.set(key(), { ...good, cc: Number.MAX_SAFE_INTEGER });
    await assert.rejects(companyAction(client, GUILD, USER, 'withdraw', options(START + DAY, { amount: 400, version: 1 })), /overflow/);
    assert.equal(client.records.get(key()).cc, Number.MAX_SAFE_INTEGER);
});

test('month-end payout attribution, durable cups, tie breaks and reset preserve companies and CC', async () => {
    const client = clientWith(); await create(client);
    const second = '200000000000000251';
    await adjustCC(client, GUILD, second, COMPANY.createCost);
    await create(client, second);
    const before = structuredClone([...client.records]);
    const feb = await companyLeaderboard(client, GUILD, { now: Date.UTC(2026, 1, 2, 12) });
    assert.equal(feb.month, '2026-02');
    assert.equal(feb.seasons['2026-01'].userId, USER);
    assert.equal(feb.seasons['2026-01'].profit, 400);
    assert.equal(feb.monthly[0].company.monthlyNet['2026-02'], 800);
    assert.deepEqual([...client.records].filter(([id]) => id.includes(':economy:')), before);
    const writes = client.writes;
    const again = await companyLeaderboard(client, GUILD, { now: Date.UTC(2026, 1, 2, 12) });
    assert.deepEqual(again.seasons, feb.seasons);
    assert.equal(client.writes, writes, 'immutable season archive is not rewritten');
    client.failRead = true;
    await assert.rejects(companyLeaderboard(client, GUILD, { now: Date.UTC(2026, 2, 1) }), /scan failed/);
    assert.equal(client.writes, writes);
});

test('years of missed payouts settle by calendar month, preserving exact profit and repeatability', async () => {
    const client = clientWith(); await create(client);
    const saved = client.records.get(key()).ccCompany;
    const elapsedDays = 365 * 10;
    const end = START + elapsedDays * DAY;
    const result = settleCompany(saved, end);
    assert.equal(result.treasury, elapsedDays * 400);
    assert.equal(Object.values(result.monthlyNet).reduce((a, b) => a + b, 0), elapsedDays * 400);
    assert.deepEqual(settleCompany(result, end), result);
    assert.equal(result.nextPayoutAt, end + DAY);
});

test('company sale and transfer are unavailable; ordinary CC changes retain company state', async () => {
    const client = clientWith(); await create(client);
    const saved = structuredClone(client.records.get(key()).ccCompany);
    assert.equal((await companyAction(client, GUILD, USER, 'sell', options(START, { version: 1 }))).reason, 'invalid');
    await spendCC(client, GUILD, USER, 100);
    assert.deepEqual(client.records.get(key()).ccCompany, saved);
    assert.equal((await getProfile(client, GUILD, USER)).cc, 10_000_000 - COMPANY.createCost - 100);
});
