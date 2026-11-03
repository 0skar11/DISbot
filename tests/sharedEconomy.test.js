import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { BOURSE_GUILD_ID } from '../src/config/bourseGuild.js';
import { economyScope } from '../src/config/sharedEconomy.js';
import { adjustCC, getProfile, getLeaderboard } from '../src/services/cc/ccService.js';
import { getMarket, getHoldings, invest, sell } from '../src/services/cc/bourseService.js';

const OTHER = '100000000000000099';
const USER = '200000000000000001';
const NOW = Date.UTC(2026, 8, 25, 17, 20);

function fakeClient() {
  const store = new Map();
  return {
    store,
    db: {
      get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
      list: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
}

describe('CC and the bourse are shared by every server', () => {
  test('every server maps to the home server\'s keys', () => {
    for (const id of [HOME_GUILD_ID, BOURSE_GUILD_ID, OTHER]) assert.equal(economyScope(id), HOME_GUILD_ID);
  });

  test('the same balance in every server, and nothing saved under another server\'s keys', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, USER, 1000, 'staff');
    assert.equal((await getProfile(client, BOURSE_GUILD_ID, USER)).cc, 1000);
    assert.equal((await getProfile(client, OTHER, USER)).cc, 1000);
    await adjustCC(client, BOURSE_GUILD_ID, USER, -400, 'staff');
    assert.equal((await getProfile(client, HOME_GUILD_ID, USER)).cc, 600);
    assert.deepEqual([...client.store.keys()].filter((key) => !key.startsWith(`guild:${HOME_GUILD_ID}:`)), []);
    assert.deepEqual((await getLeaderboard(client, OTHER)).map((row) => [row.userId, row.cc]), [[USER, 600]]);
  });

  test('the same prices and holdings: buy in one server, sell in another', async () => {
    const client = fakeClient();
    const options = { now: NOW, rng: () => 0.5 };
    await adjustCC(client, HOME_GUILD_ID, USER, 100_000, 'staff');
    const [first, second] = await Promise.all([getMarket(client, OTHER, options), getMarket(client, BOURSE_GUILD_ID, options)]);
    assert.deepEqual(first.quotes.map((entry) => entry.price), second.quotes.map((entry) => entry.price));

    const bought = await invest(client, BOURSE_GUILD_ID, USER, 'car', 2, options);
    assert.equal(bought.ok, true);
    assert.equal((await getHoldings(client, OTHER, USER, options)).rows[0].qty, 2);
    assert.equal((await getHoldings(client, HOME_GUILD_ID, USER, options)).rows[0].qty, 2);
    const sold = await sell(client, OTHER, USER, 'car', 2, options);
    assert.equal(sold.ok, true);
    assert.equal((await getProfile(client, BOURSE_GUILD_ID, USER)).cc, sold.balance);
  });
});
