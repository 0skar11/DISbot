import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleEveryoneMention } from '../src/services/everyoneMentionGuardService.js';

describe('@everyone guard', () => {
  test('never deletes this bot\'s own @everyone ping', async () => {
    let deleted = false;
    const message = {
      content: '@everyone',
      mentions: { everyone: true },
      author: { id: 'bot', bot: true },
      client: { user: { id: 'bot' } },
      guild: { id: 'g' },
      delete: async () => { deleted = true; },
      channel: { send: async () => null },
    };
    assert.equal(await handleEveryoneMention(message), false);
    assert.equal(deleted, false);
  });
});

describe('@everyone guard: roles are removed from members who are not trusted (report #247)', () => {
  const role = (id, position, managed = false) => ({ id, position, managed });
  function setup(guildId) {
    const removed = [];
    const sent = [];
    const roles = [role(guildId, 0), role('r1', 3), role('r2', 5), role('boost', 2, true), role('high', 20)];
    const store = new Map();
    const client = { user: { id: 'bot' }, db: { get: async (k, f) => (store.has(k) ? store.get(k) : f), set: async (k, v) => { store.set(k, v); return true; } } };
    const member = { id: '555', roles: { cache: new Map(roles.map((r) => [r.id, r])), remove: async (list) => { removed.push(...list.map((r) => r.id)); } } };
    const message = {
      content: 'hello @everyone', mentions: { everyone: true }, author: { id: '555', bot: false }, client, member,
      guild: { id: guildId, client, members: { me: { roles: { highest: role('bot', 10) } }, fetch: async () => member } },
      delete: async () => {},
      channel: { send: async (p) => { sent.push(p.content); return { delete: async () => {} }; } },
    };
    return { message, removed, sent };
  }

  test('our server: the roles the bot can remove are taken, others are kept', async () => {
    const { HOME_GUILD_ID } = await import('../src/config/homeGuild.js');
    const { message, removed, sent } = setup(HOME_GUILD_ID);
    assert.equal(await handleEveryoneMention(message), true);
    assert.deepEqual(removed.sort(), ['r1', 'r2']);
    assert.match(sent[0], /رولاتك اتشالت/);
  });

  test('another server: the message goes but nobody loses roles', async () => {
    const { message, removed } = setup('100000000000000099');
    assert.equal(await handleEveryoneMention(message), true);
    assert.deepEqual(removed, []);
  });
});

describe('@everyone guard: الحفرة lets anyone mention @everyone', () => {
  test('a normal member\'s @everyone / @here is left alone and keeps their roles', async () => {
    let touched = false;
    const message = {
      content: '@everyone شوفوا ده',
      mentions: { everyone: true },
      author: { id: '200000000000000001', bot: false },
      client: { user: { id: 'bot' } },
      guild: { id: '1472405236000751778' },
      member: { roles: { cache: new Map(), remove: async () => { touched = true; } } },
      delete: async () => { touched = true; },
      channel: { send: async () => { touched = true; } },
    };
    assert.equal(await handleEveryoneMention(message), false);
    assert.equal(touched, false);
  });
});

