import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { storeCatalog, storeMode, buyItem, hasRealStore } from '../src/services/cc/ccStoreService.js';
import { zenithStoreItems, zenithLuckBoxPrizes, ZENITH_GUILD_ID } from '../src/config/store/ccStoreItems.js';
import { getEconomyKey } from '../src/utils/database/keys.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';

const USER = '200000000000000001';
const OPEN = { open: true, trial: false, maxQuantity: 10 };

describe('Zenith store', () => {
  test('its own catalog: luck box, custom roles; nothing about XP, the trader role or the bourse', () => {
    const items = storeCatalog(OPEN, { guildId: ZENITH_GUILD_ID });
    assert.deepEqual(items.map((item) => [item.id, item.price]), [['luck_box', 1500], ['custom_role', 3000], ['friends_role', 8000]]);
    for (const item of items) assert.ok(!['boost', 'forecast'].includes(item.type) && item.id !== 'trader_role', item.id);
    assert.equal(storeMode(OPEN, ZENITH_GUILD_ID), 'open');
    assert.equal(hasRealStore(ZENITH_GUILD_ID), true);
    assert.equal(hasRealStore(HOME_GUILD_ID), true);
    assert.equal(hasRealStore('1'), false);
    // Another server still gets the old samples as a preview, and the home server keeps its own catalog.
    assert.equal(storeMode(OPEN, '1'), 'trial');
    assert.ok(storeCatalog(OPEN, { guildId: HOME_GUILD_ID }).some((item) => item.id === 'xp_boost'));
  });

  test('the luck box gives CC only and returns less than it costs on average', () => {
    const total = zenithLuckBoxPrizes.reduce((sum, prize) => sum + prize.weight, 0);
    const expected = zenithLuckBoxPrizes.reduce((sum, prize) => sum + prize.cc * prize.weight, 0) / total;
    const box = zenithStoreItems.find((item) => item.id === 'luck_box');
    assert.ok(expected < box.price, `${expected} < ${box.price}`);
    assert.ok(zenithLuckBoxPrizes.every((prize) => Number.isSafeInteger(prize.cc) && !prize.boost && !prize.forecast && !prize.role));
  });

  test('buying a luck box in Zenith takes 1500 and pays the drawn CC prize; too little CC is refused', async () => {
    const key = getEconomyKey(ZENITH_GUILD_ID, USER);
    const store = new Map([[key, { cc: 2000, ccStats: { earned: 0, spent: 0 } }]]);
    const client = { db: { get: async (k, fallback) => (store.has(k) ? structuredClone(store.get(k)) : fallback), set: async (k, v) => { store.set(k, structuredClone(v)); return true; } } };
    const member = { id: USER, guild: { id: ZENITH_GUILD_ID }, roles: { cache: new Map() } };
    const bought = await buyItem(client, member, 'luck_box', 1, { settings: OPEN, rng: () => 0 });
    assert.equal(bought.ok, true);
    assert.equal(bought.prize.cc, 300);
    assert.equal(bought.balance, 2000 - 1500 + 300);
    const poor = await buyItem(client, member, 'luck_box', 1, { settings: OPEN, rng: () => 0 });
    assert.equal(poor.ok, false);
    assert.equal(poor.reason, 'no_cc');
    // An item that is not sold in Zenith.
    assert.equal((await buyItem(client, member, 'xp_boost', 1, { settings: OPEN })).reason, 'not_found');
  });
});
