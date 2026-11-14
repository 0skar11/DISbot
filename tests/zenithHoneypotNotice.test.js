import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishZenithHoneypotNotice, buildZenithHoneypotNotice } from '../src/services/security/honeypotNotice.js';

function setup(guildId) {
  const store = new Map();
  const messages = new Map();
  const db = { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } };
  const client = { user: { id: 'bot' }, db, guilds: { cache: new Map() } };
  const guild = { id: guildId, client };
  const channel = {
    name: 'honeypot', client, guild, isTextBased: () => true, sent: 0,
    send: async (payload) => {
      channel.sent += 1;
      const message = { id: 'm1', author: { id: 'bot' }, embeds: payload.embeds, pinned: false, pin: async () => { message.pinned = true; }, edit: async (next) => { message.embeds = next.embeds; } };
      messages.set(message.id, message);
      return message;
    },
    messages: { fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) || null : new Map(messages)) },
  };
  guild.channels = { cache: { find: (fn) => [channel].find(fn) } };
  client.guilds.cache.set(guildId, guild);
  return { client, channel, messages };
}

test('Zenith #honeypot: notice posted and pinned once, then edited in place', async () => {
  const { client, channel, messages } = setup('1569932761471524874');
  assert.equal((await publishZenithHoneypotNotice(client)).status, 'sent');
  assert.equal([...messages.values()][0].pinned, true);
  assert.equal((await publishZenithHoneypotNotice(client)).status, 'updated');
  assert.equal(channel.sent, 1);
  assert.match(buildZenithHoneypotNotice().description, /instant kick/u);
});

test('other servers: nothing is posted', async () => {
  const { client, channel } = setup('1155236281706627173');
  assert.equal((await publishZenithHoneypotNotice(client)).status, 'skipped');
  assert.equal(channel.sent, 0);
});
