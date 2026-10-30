import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import command from '../src/commands/Games/company.js';
import button from '../src/interactions/buttons/store/company.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { GAMES_BOTS_CHANNEL_ID } from '../src/config/games.js';
import { COMPANY, COMPANY_DAY_MS } from '../src/config/store/companies.js';
import { companyAction } from '../src/services/cc/companyService.js';
import { companyPanel, companiesPanel, quoteCompanyAction, getCompanyQuote, companyConfirmation } from '../src/services/cc/companyUi.js';
import { applyWordAliases, resolveCommandAlias } from '../src/config/commands/commandAliases.js';
import { createMockInteraction } from '../src/utils/messageAdapter.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';
import { getEconomyKey, getGuildConfigKey } from '../src/utils/database/keys.js';
import { buildGuideEmbeds } from '../src/services/cc/guideUi.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { db } from '../src/utils/database/wrapper.js';

const USER = '200000000000000252';
const GUILD = HOME_GUILD_ID;
const KEY = getEconomyKey(GUILD, USER);
function fakeClient() {
    const records = new Map([[KEY, { cc: 1_000_000 }]]);
    return { records, db: {
        isAvailable: () => true,
        getStrict: async (key, fallback = null) => records.has(key) ? structuredClone(records.get(key)) : structuredClone(fallback),
        set: async (key, value) => { records.set(key, structuredClone(value)); return true; },
        getEconomyRowsStrict: async () => [...records].filter(([key]) => key.includes(':economy:')).map(([key, record]) => ({ userId: key.split(':').at(-1), record })),
    } };
}
function typed(text) {
    const parsed = parseTypedCommand(text, '!');
    const alias = applyWordAliases(parsed.commandName, parsed.args, parsed.prefixed);
    assert.ok(alias);
    assert.equal(resolveCommandAlias(alias.commandName), 'company');
    return command.normalizePrefixArgs(alias.args);
}
async function runTyped(client, text, { guildId = GUILD, channelId = GAMES_BOTS_CHANNEL_ID } = {}) {
    const outputs = [];
    const message = { id: '1', author: { id: USER, bot: false }, guild: { id: guildId },
        channel: { id: channelId, send: async (payload) => { outputs.push(payload); return { id: '2' }; } } };
    const interaction = createMockInteraction(message, command.data, typed(text));
    assert.equal(interaction.options.validateRequired().valid, true);
    await command.execute(interaction, {}, client);
    return outputs[0];
}
const quoteId = (payload) => payload.components[0].components[0].data.custom_id.split(':').at(-1);
function interactionFor(args = {}) {
    const outputs = [];
    return { outputs, user: { id: USER }, guildId: GUILD, channel: { id: GAMES_BOTS_CHANNEL_ID },
        inGuild: () => true, deferUpdate: async () => {},
        reply: async (payload) => outputs.push(payload), editReply: async (payload) => outputs.push(payload), ...args };
}

test('Arabic and slash company command data parses every promised command', () => {
    for (const [text, expected] of [
        ['شركة', ['view']], ['شركه', ['view']], ['شركة إنشاء مطعم أوسكار', ['create', 'مطعم أوسكار']],
        ['شركة انشاء مطعم جديد', ['create', 'مطعم جديد']], ['شركة تطوير', ['upgrade']],
        ['شركة خزنة', ['treasury']], ['شركة سحب ٥٠٠٠', ['withdraw', '5000']], ['شركات', ['leaderboard']],
        ['!company create My Restaurant', ['create', 'My Restaurant']],
    ]) assert.deepEqual(typed(text), expected, text);
    assert.equal(applyWordAliases('شركة', ['صاحبي', 'شغالة'], false), null);
    assert.equal(applyWordAliases('شركات', ['كتير'], false), null);
    assert.equal(command.data.toJSON().name, 'company');
});

test('creation command previews cost, performs no charge, and confirmation commits exactly once', async () => {
    const client = fakeClient();
    const preview = await runTyped(client, 'شركة إنشاء مطعم أوسكار');
    assert.match(preview.embeds[0].description, /100,000/);
    assert.equal(client.records.get(KEY).cc, 1_000_000);
    const id = quoteId(preview);
    assert.equal(getCompanyQuote(id).userId, USER);
    const press = interactionFor();
    await button.execute(press, client, ['confirm', id]);
    assert.equal(client.records.get(KEY).cc, 900_000);
    assert.match(press.outputs[0].embeds[0].description, /اتحفظت/);
    await button.execute(press, client, ['confirm', id]);
    assert.equal(client.records.get(KEY).cc, 900_000);
    assert.equal(press.outputs.at(-1).flags, MessageFlags.Ephemeral);
});

test('buttons are owner/guild/channel-bound and cancel never spends', async () => {
    const client = fakeClient();
    const preview = await runTyped(client, 'شركة إنشاء مطعم أوسكار');
    const id = quoteId(preview);
    for (const changed of [
        { user: { id: '200000000000000253' } }, { guildId: '100000000000000250' }, { channel: { id: '100000000000000251' } },
    ]) {
        const press = interactionFor(changed);
        await button.execute(press, client, ['confirm', id]);
        assert.equal(press.outputs[0].flags, MessageFlags.Ephemeral);
        assert.equal(client.records.get(KEY).cc, 1_000_000);
    }
    await button.execute(interactionFor(), client, ['cancel', id]);
    assert.equal(getCompanyQuote(id), undefined);
    assert.equal(client.records.get(KEY).cc, 1_000_000);
});

test('a failed panel read after a durable purchase still returns a success receipt', async () => {
    const client = fakeClient();
    const preview = await runTyped(client, 'شركة إنشاء مطعم أوسكار');
    const id = quoteId(preview);
    const save = client.db.set;
    client.db.set = async (...args) => {
        const result = await save(...args);
        client.db.getStrict = async () => { throw new Error('post-commit read unavailable'); };
        return result;
    };
    const press = interactionFor();
    await button.execute(press, client, ['confirm', id]);
    assert.equal(client.records.get(KEY).cc, 900_000);
    assert.ok(client.records.get(KEY).ccCompany);
    assert.match(press.outputs[0].content, /اتحفظت بنجاح/);
    assert.match(press.outputs[0].content, /متكررش/);
    assert.deepEqual(press.outputs[0].components, []);
    await button.execute(press, client, ['confirm', id]);
    assert.equal(client.records.get(KEY).cc, 900_000);
});

test('expired quotes and independent duplicate quotes cannot charge twice', async () => {
    const client = fakeClient();
    const first = await runTyped(client, 'شركة إنشاء مطعم أوسكار');
    const second = await runTyped(client, 'شركة إنشاء مطعم أوسكار');
    await Promise.all([button.execute(interactionFor(), client, ['confirm', quoteId(first)]), button.execute(interactionFor(), client, ['confirm', quoteId(second)])]);
    assert.equal(client.records.get(KEY).cc, 900_000);
    const expired = companyConfirmation(GUILD, USER, { action: 'withdraw', amount: 1, version: 1 }, { now: 1000 });
    const press = interactionFor();
    await button.execute(press, client, ['confirm', quoteId(expired)]);
    assert.match(press.outputs[0].content, /انتهى/);
    assert.equal(client.records.get(KEY).cc, 900_000);
});

test('old confirmations cannot spend while company, its category or its subcommand is disabled', async () => {
    for (const config of [
        { disabledCommands: { company: true } },
        { disabledCategories: { games: true } },
        { disabledCommands: { 'company create': true } },
    ]) {
        const client = fakeClient();
        const preview = await runTyped(client, 'شركة إنشاء مطعم عائلي');
        const id = quoteId(preview);
        client.records.set(getGuildConfigKey(GUILD), config);
        const press = interactionFor();
        await button.execute(press, client, ['confirm', id]);
        assert.equal(client.records.get(KEY).cc, 1_000_000);
        assert.equal(client.records.get(KEY).ccCompany, undefined);
        assert.match(press.outputs[0].content, /متوقفة/);
        assert.equal(getCompanyQuote(id), undefined);
    }
});

test('company buttons respect subcommand holds, fail closed on config errors, and still allow cancellation', async () => {
    const client = fakeClient();
    const now = Date.now() - 2 * COMPANY_DAY_MS;
    await companyAction(client, GUILD, USER, 'create', { name: 'مطعم عائلي', cost: COMPANY.createCost, version: 0, now, expiresAt: now + COMPANY.quoteMs });
    const before = structuredClone(client.records.get(KEY));
    client.records.set(getGuildConfigKey(GUILD), { disabledCommands: { 'company upgrade': true } });
    const held = interactionFor();
    await button.execute(held, client, ['upgrade', 'quality', USER]);
    assert.match(held.outputs[0].content, /متوقفة/);
    const readable = interactionFor();
    await button.execute(readable, client, ['refresh', USER]);
    assert.ok(readable.outputs[0].embeds.length);
    assert.deepEqual(client.records.get(KEY), before);

    const other = fakeClient();
    const preview = await runTyped(other, 'شركة إنشاء مطعم عائلي');
    const id = quoteId(preview);
    const getStrict = other.db.getStrict;
    other.db.getStrict = async (key, ...rest) => {
        if (key === getGuildConfigKey(GUILD)) throw new Error('config read failed');
        return getStrict(key, ...rest);
    };
    await assert.rejects(button.execute(interactionFor(), other, ['confirm', id]), /config read failed/);
    assert.equal(other.records.get(KEY).cc, 1_000_000);
    const cancelled = interactionFor();
    await button.execute(cancelled, other, ['cancel', id]);
    assert.match(cancelled.outputs[0].content, /اتلغت/);
    assert.equal(getCompanyQuote(id), undefined);
});

test('wrong guild/channel commands do not touch storage', async () => {
    const client = { db: { getStrict: async () => { throw new Error('must not query'); } } };
    assert.match((await runTyped(client, 'شركة', { guildId: '100000000000000250' })).content, /مش متاحة/);
    assert.match((await runTyped(client, 'شركة', { channelId: '100000000000000251' })).content, /بس/);
});

test('company panel and upgrade/withdraw prompts disclose current and next-cycle economics', async () => {
    const client = fakeClient();
    const now = Date.UTC(2026, 0, 1, 12);
    await companyAction(client, GUILD, USER, 'create', { name: 'مطعم أوسكار', cost: COMPANY.createCost, version: 0, now, expiresAt: now + COMPANY.quoteMs });
    const when = now + COMPANY_DAY_MS;
    const panel = await companyPanel(client, GUILD, USER, { now: when });
    assert.match(panel.embeds[0].description, /مبيعات/);
    assert.match(panel.embeds[0].description, /تشغيل/);
    assert.match(panel.embeds[0].description, /400/);
    assert.equal(panel.components[0].components.length, 5);
    const upgrade = await quoteCompanyAction(client, GUILD, USER, { action: 'upgrade', kind: 'quality' }, { now: when });
    assert.match(upgrade.embeds[0].description, /39,600/);
    assert.match(upgrade.embeds[0].description, /بعد الدفعة الجاية/);
    const withdraw = await quoteCompanyAction(client, GUILD, USER, { action: 'withdraw', amount: 'all' }, { now: when });
    assert.equal(getCompanyQuote(quoteId(withdraw)).amount, 400);
    assert.equal(client.records.get(KEY).cc, 900_000);
});

test('typed withdrawals reject partial numbers instead of silently quoting a different amount', async () => {
    const client = fakeClient();
    const now = Date.now() - 3 * COMPANY_DAY_MS;
    await companyAction(client, GUILD, USER, 'create', { name: 'مطعم عائلي', cost: COMPANY.createCost, version: 0, now, expiresAt: now + COMPANY.quoteMs });
    const before = structuredClone(client.records.get(KEY));
    for (const value of ['1.5', '1e3', '12CC', '5000abc', '1,000', '-1', '9007199254740992']) {
        const output = await runTyped(client, `شركة سحب ${value}`);
        assert.match(output.content, /مبلغ صحيح/, value);
        assert.deepEqual(output.components, [], value);
    }
    const valid = await runTyped(client, 'شركة سحب ١٢');
    assert.equal(getCompanyQuote(quoteId(valid)).amount, 12);
    assert.deepEqual(client.records.get(KEY), before);
});

test('leaderboard sends no mentions and guide only exposes companies in home server', async () => {
    const payload = await companiesPanel(fakeClient(), GUILD);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.embeds.length, 3);
    assert.ok(buildGuideEmbeds({ guildId: GUILD }).some((embed) => /شركات/.test(embed.title)));
    assert.ok(!buildGuideEmbeds({ guildId: '100000000000000250' }).some((embed) => /شركات/.test(embed.title)));
});

test('PostgreSQL strict economy reads propagate query errors while legacy get remains compatible', async () => {
    const persistent = new pgDb.constructor();
    persistent.isConnected = true;
    persistent.pool = { query: async () => { throw new Error('database unavailable'); } };
    await assert.rejects(persistent.getStrict(KEY, {}), /database unavailable/);
    assert.deepEqual(await persistent.get(KEY, {}), {});
    await assert.rejects(persistent.getEconomyRowsStrict(GUILD), /database unavailable/);
    persistent.isConnected = false;
    await assert.rejects(persistent.getStrict(KEY), /Persistent/);
});

test('strict storage distinguishes missing rows, returns full economy JSON, and never uses fallback', async () => {
    const persistent = new pgDb.constructor(); persistent.isConnected = true;
    const row = { cc: 123, ccCompany: { keep: true }, ccInventory: { keep: 4 } };
    persistent.pool = { query: async () => ({ rows: [{ data: row, user_id: USER }] }) };
    assert.deepEqual(await persistent.getStrict(KEY), row);
    assert.deepEqual(await persistent.getEconomyRowsStrict(GUILD), [{ userId: USER, record: row }]);
    persistent.pool = { query: async () => ({ rows: [] }) };
    assert.deepEqual(await persistent.getStrict(KEY, {}), {});
    const wrapper = new db.constructor(); wrapper.useFallback = true; wrapper.db = persistent;
    await assert.rejects(wrapper.getStrict(KEY), /Persistent/);
    await assert.rejects(wrapper.getEconomyRowsStrict(GUILD), /Persistent/);
});

test('strict guild access reads return stored configuration and propagate database errors', async () => {
    const persistent = new pgDb.constructor(); persistent.isConnected = true;
    const config = { disabledCommands: { company: true } };
    persistent.pool = { query: async (sql, values) => {
        assert.match(sql, /SELECT config/);
        assert.deepEqual(values, [GUILD]);
        return { rows: [{ config }] };
    } };
    assert.deepEqual(await persistent.getStrict(getGuildConfigKey(GUILD), {}), config);
    persistent.pool = { query: async () => ({ rows: [] }) };
    assert.deepEqual(await persistent.getStrict(getGuildConfigKey(GUILD), {}), {});
    persistent.pool = { query: async () => { throw new Error('config read failed'); } };
    await assert.rejects(persistent.getStrict(getGuildConfigKey(GUILD), {}), /config read failed/);
    assert.deepEqual(await persistent.get(getGuildConfigKey(GUILD), {}), {}, 'legacy reads retain existing fallback behavior');
});
