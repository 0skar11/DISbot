import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import bourse from '../src/commands/Games/bourse.js';
import storeCommand from '../src/commands/Games/store.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { GAMES_BOTS_CHANNEL_ID } from '../src/config/games.js';
import { applyWordAliases, resolveCommandAlias } from '../src/config/commands/commandAliases.js';
import { ccStoreItems } from '../src/config/store/ccStoreItems.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';
import { createMockInteraction } from '../src/utils/messageAdapter.js';
import { adjustCC, getProfile } from '../src/services/cc/ccService.js';
import { getMarket, getHoldings, invest, hourOf, sellFee } from '../src/services/cc/bourseService.js';
import { bourseTradePayload, sellAllPayload } from '../src/services/cc/bourseTransactions.js';
import { clearXpBoostCache, getXpBoosts } from '../src/services/leveling/xpBoostService.js';
import { buildGuideEmbeds } from '../src/services/cc/guideUi.js';

const MEMBER = '200000000000000240';
const OTHER_GUILD = '100000000000000240';
let nextMessage = 0;
beforeEach(() => clearXpBoostCache());

function fakeClient() {
    const records = new Map();
    return { records, db: {
        get: async (key, fallback = null) => records.has(key) ? structuredClone(records.get(key)) : fallback,
        set: async (key, value) => { records.set(key, structuredClone(value)); return true; },
    } };
}

function typedOptions(text) {
    const parsed = parseTypedCommand(text, '!');
    const aliased = applyWordAliases(parsed.commandName, parsed.args, parsed.prefixed);
    assert.ok(aliased, `Expected a command: ${text}`);
    const command = resolveCommandAlias(aliased.commandName) === 'bourse' ? bourse : storeCommand;
    return { command, args: command.normalizePrefixArgs(aliased.args) };
}

async function runTyped(client, text, { guildId = HOME_GUILD_ID, channelId = GAMES_BOTS_CHANNEL_ID, member: providedMember } = {}) {
    const { command, args } = typedOptions(text);
    const payloads = [];
    const user = { id: MEMBER, bot: false, toString: () => `<@${MEMBER}>`, send: async () => { throw new Error('DMs closed'); } };
    const guild = { id: guildId, roles: { cache: new Map() } };
    const member = providedMember || { id: MEMBER, user, guild, roles: { cache: new Map(), add: async () => {} } };
    guild.members = { cache: new Map([[MEMBER, member]]), fetch: async () => member };
    const sentMessage = { id: String(++nextMessage), edit: async (payload) => { payloads.push(payload); return sentMessage; } };
    const message = {
        id: String(++nextMessage), content: text, author: user, member, guild, client,
        channel: { id: channelId, send: async (payload) => { payloads.push(payload); return sentMessage; } },
    };
    const interaction = createMockInteraction(message, command.data, args);
    assert.equal(interaction.options.validateRequired().valid, true, text);
    await command.execute(interaction, {}, client);
    return { payload: payloads[0], payloads, interaction };
}

async function carPrice(client, guildId = HOME_GUILD_ID) {
    return (await getMarket(client, guildId)).quotes.find((quote) => quote.asset.id === 'car').price;
}
const cc = async (client, guildId = HOME_GUILD_ID) => (await getProfile(client, guildId, MEMBER)).cc;
const holdings = async (client, guildId = HOME_GUILD_ID) => (await getHoldings(client, guildId, MEMBER)).rows;

test('typed Arabic confirmation reaches the correct options, including names, numbers and all forms', () => {
    const cases = [
        ['شراء عربية ٢ تأكيد', ['invest', 'عربية', '2', 'true']],
        ['استثمار سبيكة دهب 2 تاكيد', ['invest', 'سبيكة دهب', '2', 'true']],
        ['بيع 3 2 تأكيد', ['sell', '3', '2', 'true']],
        ['شراء 3 تأكيد', ['invest', '3', '1', 'true']],
        ['بيع كلو تأكيد', ['sellall', '', 'true']],
        ['بيع عربية كلو تأكيد', ['sellall', 'عربية', 'true']],
        ['شراء عربية كلو تأكيد', ['buymax', 'عربية', 'true']],
        ['متجر 1 3 تأكيد', ['buy', '1', '3', 'true']],
        ['متجر بوست XP ×2 تأكيد', ['buy', 'بوست XP ×2', '1', 'true']],
        ['!store buy xp_boost 2 تأكيد', ['buy', 'xp_boost', '2', 'true']],
    ];
    for (const [text, expected] of cases) assert.deepEqual(typedOptions(text).args, expected, text);
    assert.equal(applyWordAliases('شراء', ['العربية', 'دي', 'تأكيد'], false), null);
    assert.equal(applyWordAliases('متجر', ['الحاجات', 'دي', 'تأكيد'], false), null);
    assert.equal(applyWordAliases('بيع', ['تأكيد'], false), null);
});

test('explicit buy and sell execute once and return receipts, with the normal sale fee', async () => {
    const client = fakeClient();
    const price = await carPrice(client);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, price * 3);
    const bought = await runTyped(client, 'شراء عربية 2 تأكيد');
    assert.match(bought.payload.embeds[0].title, /تم الاستثمار/u);
    assert.deepEqual(bought.payload.components, []);
    assert.equal(bought.payloads.length, 1);
    assert.equal(await cc(client), price);
    assert.equal((await holdings(client))[0].qty, 2);
    const sold = await runTyped(client, 'بيع عربية 1 تاكيد');
    assert.match(sold.payload.embeds[0].title, /تم البيع/u);
    assert.deepEqual(sold.payload.components, []);
    assert.equal(await cc(client), price * 2 - sellFee(price));
    assert.equal((await holdings(client))[0].qty, 1);
});

test('omitting confirmation preserves both prompts and makes no purchase or sale', async () => {
    const client = fakeClient();
    const price = await carPrice(client);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, price * 3);
    const bought = await runTyped(client, 'شراء عربية 2');
    assert.ok(bought.payload.components.length);
    assert.equal(await cc(client), price * 3);
    assert.deepEqual(await holdings(client), []);
    await invest(client, HOME_GUILD_ID, MEMBER, 'car', 1);
    const before = await cc(client);
    const sold = await runTyped(client, 'بيع عربية 1');
    assert.ok(sold.payload.components.length);
    assert.equal(await cc(client), before);
    assert.equal((await holdings(client))[0].qty, 1);
});

test('direct purchases preserve funds, holding limits, ownership and zero-quantity checks', async () => {
    const client = fakeClient();
    assert.match((await runTyped(client, 'شراء عربية 1 تأكيد')).payload.content, /مش كفاية/u);
    assert.match((await runTyped(client, 'بيع عربية 1 تأكيد')).payload.content, /معندكش/u);
    assert.match((await runTyped(client, 'شراء عربية 0 تأكيد')).payload.content, /العدد/u);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 2_000_000);
    await invest(client, HOME_GUILD_ID, MEMBER, 'palace', 5);
    const before = await cc(client);
    assert.match((await runTyped(client, 'شراء قصر 1 تأكيد')).payload.content, /أقصى حاجة 5/u);
    assert.equal(await cc(client), before);
});

test('concurrent direct purchases cannot spend the same funds twice', async () => {
    const client = fakeClient();
    const price = await carPrice(client);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, price * 2);
    const results = await Promise.all([runTyped(client, 'شراء عربية 2 تأكيد'), runTyped(client, 'شراء عربية 2 تأكيد')]);
    assert.equal(results.filter(({ payload }) => payload.embeds?.[0]?.title.includes('تم الاستثمار')).length, 1);
    assert.equal(await cc(client), 0);
    assert.equal((await holdings(client))[0].qty, 2);
});

test('the explicit shortcut also supports buy-max and selling one or all asset types', async () => {
    const client = fakeClient();
    const price = await carPrice(client);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, price * 3 + 1);
    assert.match((await runTyped(client, 'شراء عربية كلو تأكيد')).payload.embeds[0].title, /تم الاستثمار/u);
    assert.equal((await holdings(client))[0].qty, 3);
    assert.match((await runTyped(client, 'بيع عربية كلو تأكيد')).payload.embeds[0].title, /تم البيع/u);
    assert.deepEqual(await holdings(client), []);
    await invest(client, HOME_GUILD_ID, MEMBER, 'motorcycle', 1);
    await invest(client, HOME_GUILD_ID, MEMBER, 'gold', 1);
    assert.match((await runTyped(client, 'بيع كلو تأكيد')).payload.embeds[0].title, /اتباع كله/u);
    assert.deepEqual(await holdings(client), []);
});

test('stale prices and stale sell-all hours require another confirmation without any mutation', async () => {
    const client = fakeClient();
    const price = await carPrice(client);
    await adjustCC(client, HOME_GUILD_ID, MEMBER, price * 3);
    const user = { id: MEMBER };
    const staleBuy = await bourseTradePayload(client, HOME_GUILD_ID, user, 'buy', 'car', 1, price + 1);
    assert.match(staleBuy.embeds[0].description, /السعر اتغير/u);
    assert.deepEqual(await holdings(client), []);
    assert.equal(await cc(client), price * 3);
    await invest(client, HOME_GUILD_ID, MEMBER, 'car', 1);
    const before = await cc(client);
    const staleSale = await bourseTradePayload(client, HOME_GUILD_ID, user, 'sell', 'car', 1, price + 1);
    const staleAll = await sellAllPayload(client, HOME_GUILD_ID, user, hourOf() - 1);
    assert.match(staleSale.embeds[0].description, /السعر اتغير/u);
    assert.match(staleAll.embeds[0].description, /السعر اتغير/u);
    assert.equal(await cc(client), before);
    assert.equal((await holdings(client))[0].qty, 1);
});

test('another guild keeps its confirmation prompts and unchanged balance', async () => {
    const client = fakeClient();
    await adjustCC(client, OTHER_GUILD, MEMBER, 50_000);
    const result = await runTyped(client, 'شراء عربية 2 تأكيد', { guildId: OTHER_GUILD });
    assert.ok(result.payload.components.length);
    assert.equal(await cc(client, OTHER_GUILD), 50_000);
    assert.deepEqual(await holdings(client, OTHER_GUILD), []);
    const store = await runTyped(client, 'متجر 1 1 تأكيد', { guildId: OTHER_GUILD });
    assert.match(store.payload.embeds[0].title, /تأكيد/u);
    assert.ok(store.payload.components.length);
    assert.equal(await cc(client, OTHER_GUILD), 50_000);
});

test('the bourse channel restriction also applies to explicitly confirmed commands', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 50_000);
    const result = await runTyped(client, 'شراء عربية 2 تأكيد', { channelId: '100000000000000099' });
    assert.match(result.payload.content, /البورصة في/u);
    assert.equal(await cc(client), 50_000);
    assert.deepEqual(await holdings(client), []);
});

test('direct store purchase deducts once, delivers the quantity, and returns no confirmation buttons', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 10_000);
    const result = await runTyped(client, 'متجر 1 2 تأكيد');
    assert.match(result.payload.embeds[0].title, /تم الشراء/u);
    assert.deepEqual(result.payload.components, []);
    assert.equal(result.payloads.length, 1);
    assert.equal(await cc(client), 10_000 - ccStoreItems[0].price * 2);
    const until = (await getXpBoosts(client, HOME_GUILD_ID, MEMBER)).chat;
    assert.ok(until > Date.now() + 119 * 60_000 && until < Date.now() + 121 * 60_000);
});

test('store without confirmation, insufficient funds and invalid quantities do not deliver or charge', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 100);
    assert.ok((await runTyped(client, 'متجر 1 1')).payload.components.length);
    assert.match((await runTyped(client, 'متجر 1 1 تأكيد')).payload.content, /مش كفاية/u);
    assert.match((await runTyped(client, 'متجر 1 0 تأكيد')).payload.content, /العدد/u);
    assert.match((await runTyped(client, 'متجر 1 11 تأكيد')).payload.content, /العدد/u);
    assert.equal(await cc(client), 100);
    assert.equal((await getXpBoosts(client, HOME_GUILD_ID, MEMBER)).chat, 0);
});

test('prefix custom roles retain their form without charging', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 100_000);
    const result = await runTyped(client, '!store buy custom_role 1 تأكيد');
    assert.match(result.payload.embeds[0].title, /تأكيد/u);
    assert.ok(result.payload.components.length);
    assert.equal(result.payloads.length, 1);
    assert.equal(await cc(client), 100_000);
});

test('the reported `متجر 2 تأكيد` buys and opens the luck box immediately, exactly once', async (t) => {
    t.mock.method(Math, 'random', () => 0); // A 500 CC prize, without private forecast delivery.
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 100_000);
    const result = await runTyped(client, 'متجر 2 تأكيد');
    assert.match(result.payload.embeds[0].title, /تم الشراء/u);
    assert.deepEqual(result.payload.components, []);
    assert.equal(result.payloads.length, 1);
    assert.equal(await cc(client), 100_000 - ccStoreItems.find((item) => item.id === 'luck_box').price + 500);
});

test('slash direct forecast still keeps a closed-DM fallback ephemeral', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, MEMBER, 100_000);
    const payloads = [];
    const followUps = [];
    const user = { id: MEMBER, send: async () => { throw new Error('DMs closed'); } };
    await storeCommand.execute({
        id: 'slash-240', guildId: HOME_GUILD_ID, user,
        member: { id: MEMBER, user, guild: { id: HOME_GUILD_ID }, roles: { cache: new Map() } },
        options: { getSubcommand: () => 'buy', getString: () => 'bourse_forecast', getInteger: () => 1, getBoolean: () => true },
        reply: async (payload) => { payloads.push(payload); }, followUp: async (payload) => { followUps.push(payload); },
    }, {}, client);
    assert.equal(payloads.length, 1);
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0].flags, MessageFlags.Ephemeral);
    assert.equal(await cc(client), 100_000 - ccStoreItems.find((item) => item.id === 'bourse_forecast').price);
    assert.ok(!JSON.stringify(payloads).includes('الأسعار الجاية'));
});

test('the guide documents the home-only shortcut and its private/form exceptions', () => {
    const home = JSON.stringify(buildGuideEmbeds({ guildId: HOME_GUILD_ID }));
    const other = JSON.stringify(buildGuideEmbeds({ guildId: OTHER_GUILD }));
    assert.ok(home.includes('متجر 1 3 تأكيد') && home.includes('شراء عربية 2 تأكيد'));
    assert.ok(home.includes('بتظهر ليك بس') && home.includes('5 دقايق') && home.includes('الرتب المميزة'));
    assert.ok(!other.includes('تأكيد`') && other.includes('قبل أي شراء بيجيلك زرار'));
});
