import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database/wrapper.js';
import { hotKeyRule } from '../src/utils/database/hotKeyCache.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { getGuildConfig, updateGuildConfig } from '../src/services/config/guildConfig.js';

// The server settings were read from the database several times before every command. They are now
// kept in memory for a few seconds (our server only) and dropped on every write.
const OTHER_GUILD_ID = '999999999999999999';
const configKey = (guildId) => `guild:${guildId}:config`;

function backend() {
  const store = new Map();
  const reads = [];
  return {
    store,
    reads,
    get: async (key, fallback = null) => { reads.push(key); return store.has(key) ? structuredClone(store.get(key)) : fallback; },
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    delete: async (key) => store.delete(key),
  };
}

describe('hot key cache (server settings read on every message)', () => {
  let saved;
  let pg;
  beforeEach(() => {
    saved = { db: db.db, useFallback: db.useFallback, initialized: db.initialized };
    pg = backend();
    Object.assign(db, { db: pg, useFallback: false, initialized: true });
    db.hotCache.clear();
  });
  afterEach(() => {
    Object.assign(db, saved);
    db.hotCache.clear();
    delete process.env.DB_HOT_CACHE_TTL_MS;
  });

  test('only our server\'s settings and counting game keys are cached', () => {
    assert.ok(hotKeyRule(configKey(HOME_GUILD_ID)));
    assert.ok(hotKeyRule(`countingGame:${HOME_GUILD_ID}`));
    assert.equal(hotKeyRule(configKey(OTHER_GUILD_ID)), null);
    assert.equal(hotKeyRule(`guild:${HOME_GUILD_ID}:economy:1`), null);
    assert.equal(hotKeyRule(`guild:${HOME_GUILD_ID}:leveling:users:1`), null);
  });

  test('repeated reads of the settings hit the database once', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { prefix: '!' });
    for (let i = 0; i < 5; i += 1) assert.equal((await db.get(configKey(HOME_GUILD_ID))).prefix, '!');
    assert.equal(pg.reads.length, 1);
  });

  test('reads at the same moment share one database read', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { prefix: '!' });
    const values = await Promise.all([1, 2, 3].map(() => db.get(configKey(HOME_GUILD_ID))));
    assert.equal(pg.reads.length, 1);
    assert.notEqual(values[0], values[1], 'each caller gets its own copy');
  });

  test('changing a returned object does not change what the next reader gets', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { list: ['a'] });
    (await db.get(configKey(HOME_GUILD_ID))).list.push('b');
    assert.deepEqual((await db.get(configKey(HOME_GUILD_ID))).list, ['a']);
  });

  test('a write is seen by the very next read', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { prefix: '!' });
    await db.get(configKey(HOME_GUILD_ID));
    await db.set(configKey(HOME_GUILD_ID), { prefix: '?' });
    assert.equal((await db.get(configKey(HOME_GUILD_ID))).prefix, '?');
    await db.delete(configKey(HOME_GUILD_ID));
    assert.equal(await db.get(configKey(HOME_GUILD_ID), null), null);
  });

  test('a read that started before a write is not kept', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { prefix: 'old' });
    let release;
    const slow = pg.get;
    pg.get = async (key, fallback) => {
      const value = await slow(key, fallback);
      if (release === undefined) await new Promise((resolve) => { release = resolve; });
      return value;
    };
    const early = db.get(configKey(HOME_GUILD_ID));
    await new Promise((resolve) => setImmediate(resolve));
    await db.set(configKey(HOME_GUILD_ID), { prefix: 'new' });
    release();
    await early;
    assert.equal((await db.get(configKey(HOME_GUILD_ID))).prefix, 'new');
  });

  test('missing settings are not remembered (a failed read must not turn into defaults), a missing counting game is', async () => {
    assert.equal(await db.get(configKey(HOME_GUILD_ID), null), null);
    assert.equal(await db.get(configKey(HOME_GUILD_ID), null), null);
    assert.equal(pg.reads.length, 2);
    assert.deepEqual(await db.get(`countingGame:${HOME_GUILD_ID}`, { enabled: false }), { enabled: false });
    assert.deepEqual(await db.get(`countingGame:${HOME_GUILD_ID}`, { enabled: false }), { enabled: false });
    assert.equal(pg.reads.length, 3);
  });

  test('the settings expire after a few seconds, and DB_HOT_CACHE_TTL_MS=0 turns the cache off', async () => {
    pg.store.set(configKey(HOME_GUILD_ID), { prefix: '!' });
    process.env.DB_HOT_CACHE_TTL_MS = '20';
    await db.get(configKey(HOME_GUILD_ID));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await db.get(configKey(HOME_GUILD_ID));
    assert.equal(pg.reads.length, 2);
    process.env.DB_HOT_CACHE_TTL_MS = '0';
    await db.get(configKey(HOME_GUILD_ID));
    await db.get(configKey(HOME_GUILD_ID));
    assert.equal(pg.reads.length, 4);
  });

  test('another server reads the database every time, as before', async () => {
    pg.store.set(configKey(OTHER_GUILD_ID), { prefix: '!' });
    await db.get(configKey(OTHER_GUILD_ID));
    await db.get(configKey(OTHER_GUILD_ID));
    assert.equal(pg.reads.length, 2);
  });

  test('getGuildConfig uses the cache; updateGuildConfig reads the database fresh before saving', async () => {
    const client = { db };
    await updateGuildConfig(client, HOME_GUILD_ID, { prefix: '$' });
    pg.reads.length = 0;
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).prefix, '$');
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).prefix, '$');
    assert.equal(pg.reads.length, 1);
    // Changed behind the bot's back (another process): the update must not save over it from a stale copy.
    pg.store.set(configKey(HOME_GUILD_ID), { ...pg.store.get(configKey(HOME_GUILD_ID)), antiNukeTrustedUsers: ['123456789012345678'] });
    await updateGuildConfig(client, HOME_GUILD_ID, { prefix: '%' });
    const savedConfig = pg.store.get(configKey(HOME_GUILD_ID));
    assert.equal(savedConfig.prefix, '%');
    assert.deepEqual(savedConfig.antiNukeTrustedUsers, ['123456789012345678']);
  });
});
