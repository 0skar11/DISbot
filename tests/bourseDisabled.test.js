import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { botConfig } from '../src/config/bot.js';
import { isBourseEnabled, BOURSE_DISABLED_NOTICE } from '../src/config/bourseFeature.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import bourse from '../src/commands/Games/bourse.js';
import storeCommand from '../src/commands/Games/store.js';
import messageCreate from '../src/events/messageCreate.js';
import interactionCreate from '../src/events/interactionCreate.js';
import tradeButtons from '../src/interactions/buttons/store/bourse.js';
import storeButtons from '../src/interactions/buttons/store/storePanel.js';
import { getMarket, getHoldings, getWealthLeaderboard, forecastMarket, invest, sell } from '../src/services/cc/bourseService.js';
import { buyItem, storeCatalog } from '../src/services/cc/ccStoreService.js';
import { ccStoreItems, luckBoxPrizes } from '../src/config/store/ccStoreItems.js';
import { ensureTraderRole } from '../src/services/cc/traderRoleService.js';
import { ccTopEmbed } from '../src/commands/Games/cctop.js';
import { getEconomyKey, getEconomyPrefix, getBourseKey } from '../src/utils/database/keys.js';
import { getProfile } from '../src/services/cc/ccService.js';

const USER = '200000000000000001';
const OPEN = { open: true, trial: false, maxQuantity: 10 };
const forbiddenDb = { get: () => assert.fail('database read while disabled'), set: () => assert.fail('database write while disabled'), list: () => assert.fail('database listing while disabled') };

describe('main bot stock kill switch', () => {
    test('production defaults to disabled while ordinary economy remains enabled', () => {
        assert.equal(botConfig.features.bourse, false);
        assert.equal(isBourseEnabled(), false);
        assert.equal(botConfig.features.economy, true);
    });

    test('every slash or typed subcommand stops before prices, profile or trade access', async () => {
        for (const sub of bourse.data.toJSON().options.map((option) => option.name)) {
            for (const typed of [false, true]) {
                const replies = [];
                await bourse.execute({ id: '1', guildId: HOME_GUILD_ID, user: { id: USER },
                    _sourceMessage: typed ? {} : undefined,
                    options: { getSubcommand: () => assert.fail('subcommand read before disable check') },
                    reply: async (payload) => { replies.push(payload); },
                }, {}, { db: forbiddenDb });
                assert.equal(replies.length, 0, `${sub}/${typed}`);
            }
        }
    });

    test('typed bourse aliases are silent while ordinary store purchases still dispatch', async () => {
        const lookups = [];
        const executions = [];
        const replies = [];
        const prefix = '!!';
        const guild = { id: '100000000000000001' };
        const channel = { id: '100000000000000002', send: async (payload) => replies.push(payload) };
        const client = {
            db: { get: async (_key, fallback) => ({ ...fallback, prefix }) },
            commands: {
                get(name) {
                    lookups.push(name);
                    if (name === 'bourse') return bourse;
                    if (name === 'store') return {
                        ...storeCommand,
                        category: 'Games',
                        execute: async (interaction) => executions.push(interaction.options.getSubcommand()),
                    };
                },
            },
        };
        const send = (content, index) => messageCreate.execute({
            id: String(300000000000000001n + BigInt(index)),
            content, guild, channel, channelId: channel.id, client,
            author: { id: String(200000000000000001n + BigInt(index)), bot: false },
            reply: async (payload) => replies.push(payload),
        }, client);
        const commands = [
            'بورصة', 'بورصه', 'البورصة', 'البورصه', 'اسعار', 'أسعار', 'الاسعار', 'الأسعار',
            'ممتلكاتي', 'ممتلكاتى', 'ممتلكات', 'استثمار عربية', 'استثمر عربية',
            'شراء ٣ ٢', 'اشتري عربية كلو', 'بيع سبيكة دهب 2', 'بيع كلو', 'بيع عربية كلو',
            '!!bourse', '!!bourse invest', '!!بيع', 'prices', 'holdings', 'sell 1',
        ];
        for (const [index, content] of commands.entries()) await send(content, index);
        assert.deepEqual(replies, []);
        assert.deepEqual(lookups, []);
        assert.deepEqual(executions, []);

        await send('!!buy 1', commands.length);
        assert.deepEqual(lookups, ['store']);
        assert.deepEqual(executions, ['buy']);
    });

    test('stale slash requests return before accessing the registry or replying', async () => {
        let calls = 0;
        const unexpected = () => { calls++; };
        await interactionCreate.execute(
            { commandName: 'bourse', isChatInputCommand: () => true, reply: unexpected },
            { commands: { get: unexpected }, db: forbiddenDb },
        );
        assert.equal(calls, 0);
    });
    test('old buy/sell/sellall and cancel buttons cannot touch stored financial data', async () => {
        for (const action of ['buy', 'sell', 'sellall', 'cancel']) {
            const replies = [];
            await tradeButtons.execute({ inGuild: () => true, guildId: HOME_GUILD_ID, user: { id: USER }, reply: async (payload) => replies.push(payload), deferUpdate: () => assert.fail('trade deferred'), update: () => assert.fail('trade updated') }, { db: forbiddenDb }, [action, 'car', '1', '1300', USER]);
            assert.equal(replies[0].content, BOURSE_DISABLED_NOTICE);
        }
    });

    test('market, holdings, valuation, forecasts and trade services reject before all storage access', async () => {
        const client = { db: forbiddenDb };
        const calls = [() => getMarket(client, HOME_GUILD_ID), () => getHoldings(client, HOME_GUILD_ID, USER), () => getWealthLeaderboard(client, HOME_GUILD_ID), () => forecastMarket(client, HOME_GUILD_ID), () => invest(client, HOME_GUILD_ID, USER, 'car', 1), () => sell(client, HOME_GUILD_ID, USER, 'car', 1)];
        for (const call of calls) await assert.rejects(call(), { code: 'BOURSE_DISABLED' });
    });

    test('stock store items are hidden and stale purchases return before any debit or role access', async () => {
        const catalog = storeCatalog(OPEN, { guildId: HOME_GUILD_ID });
        assert.ok(catalog.some((item) => item.id === 'luck_box'));
        assert.ok(catalog.some((item) => item.id === 'xp_boost'));
        assert.ok(!catalog.some((item) => ['trader_role', 'bourse_forecast'].includes(item.id)));
        assert.doesNotMatch(catalog.find((item) => item.id === 'luck_box').description, /بورصة|تاجر/u);
        for (const itemId of ['bourse_forecast', 'trader_role']) {
            const member = new Proxy({}, { get: () => assert.fail('member access before purchase denial') });
            assert.deepEqual(await buyItem({ db: forbiddenDb }, member, itemId, 1, { settings: OPEN }), { ok: false, reason: 'bourse_disabled' });
        }
    });

    test('old general-store confirmation buttons cannot buy stock perks or charge CC', async () => {
        for (const [index, itemId] of ['bourse_forecast', 'trader_role'].entries()) {
            const userId = `20000000000000001${index}`; const edits = [];
            const member = { id: userId, guild: { id: HOME_GUILD_ID }, roles: { cache: new Map(), add: () => assert.fail('role grant') } };
            await storeButtons.execute({ inGuild: () => true, guildId: HOME_GUILD_ID, user: { id: userId }, member, deferUpdate: async () => {}, editReply: async (payload) => edits.push(payload), reply: async () => {}, }, { db: forbiddenDb }, ['confirm', itemId, '1', userId]);
            assert.match(edits[0].content, /متوقفين/u);
        }
    });

    test('startup trader setup returns before guild role/config reads or mutation', async () => {
        const guild = new Proxy({}, { get: () => assert.fail('startup role access') });
        assert.deepEqual(await ensureTraderRole({ db: forbiddenDb }, guild), { status: 'disabled', roleId: null });
    });

    test('CC leaderboard stays usable without reading or updating the market or existing holdings', async () => {
        const row = { cc: 123, ccBourse: { car: { qty: 4, cost: 5000 } }, ccStats: { earned: 0 } };
        const before = structuredClone(row); const prefix = getEconomyPrefix(HOME_GUILD_ID);
        const client = { db: { list: async (key) => { assert.equal(key, prefix); return [`${prefix}${USER}`]; }, get: async (key) => { assert.equal(key, `${prefix}${USER}`); return row; }, set: () => assert.fail('leaderboard wrote') } };
        const embed = await ccTopEmbed(client, { id: HOME_GUILD_ID, name: 'Main' }, USER);
        assert.match(embed.description, /\*\*123\*\* CC/u);
        assert.doesNotMatch(embed.description, /بعد الضريبة|📈/u);
        assert.deepEqual(row, before);
    });

    test('luck boxes keep ordinary prizes but never produce forecast/trader rewards or consume saved stock inventory', async () => {
        const stock = { car: { qty: 2, cost: 2600 } };
        const inventory = { bourse_forecast: 2, trader_role: 1 };
        const economyKey = getEconomyKey(HOME_GUILD_ID, USER);
        const marketKey = getBourseKey(HOME_GUILD_ID);
        const store = new Map([[economyKey, { cc: 1_000_000, ccBourse: stock, ccInventory: inventory }], [marketKey, { hour: 17, assets: { car: { price: 1300 } } }]]);
        const marketBefore = structuredClone(store.get(marketKey));
        const client = { db: { get: async (key, fallback) => { assert.notEqual(key, marketKey); return store.has(key) ? structuredClone(store.get(key)) : fallback; }, set: async (key, value) => { assert.notEqual(key, marketKey); store.set(key, structuredClone(value)); return true; } } };
        const member = { id: USER, guild: { id: HOME_GUILD_ID }, roles: { cache: new Map(), add: () => assert.fail('stock role reward') } };
        // Probe the midpoint of every original prize bucket, including the removed stock buckets.
        const total = luckBoxPrizes.reduce((sum, prize) => sum + prize.weight, 0); let before = 0; let ordinary = 0;
        for (const prize of luckBoxPrizes) {
            const random = (before + prize.weight / 2) / total; before += prize.weight;
            const result = await buyItem(client, member, 'luck_box', 1, { settings: OPEN, rng: () => random });
            assert.equal(result.ok, true);
            for (const drawn of [result.prize, result.bonusPrize].filter(Boolean)) {
                assert.equal(Boolean(drawn.forecast), false); assert.notEqual(drawn.role, 'trader_role');
                if (drawn.cc) ordinary += 1;
            }
            assert.equal(result.forecast, undefined);
        }
        assert.ok(ordinary > 0);
        assert.deepEqual(store.get(economyKey).ccBourse, stock);
        assert.equal(store.get(economyKey).ccInventory.bourse_forecast, 2);
        assert.equal(store.get(economyKey).ccInventory.trader_role, 1);
        assert.deepEqual(store.get(marketKey), marketBefore);
        assert.ok((await getProfile(client, HOME_GUILD_ID, USER)).cc > 0);
        assert.equal(ccStoreItems.find((item) => item.id === 'bourse_forecast').price, 7800, 'catalog source data is preserved');
    });
});
