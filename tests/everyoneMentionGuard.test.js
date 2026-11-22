import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { handleEveryoneMention, canMentionEveryone, BLOCKED_NOTICE } from '../src/services/everyoneMentionGuardService.js';
import { DUPLICATE_MESSAGES } from '../src/services/moderation/antiSpamService.js';

const BOT_ID = 'bot';
const OWNER_ID = '1159601661392715906';
const TRUSTED_ROLE_ID = '400000000000000077';

function mentionMessage({ authorId, guildId = 'g', guildOwnerId = 'guild-owner', webhookId = null, applicationId = null, content = '@everyone', trusted = false, trustedRole = false }) {
  const state = { deleted: false, notices: [] };
  // Staff holding Administrator; with `trustedRole` they also hold the server's trusted role.
  const roleCache = new Map(trustedRole ? [[TRUSTED_ROLE_ID, { id: TRUSTED_ROLE_ID }]] : []);
  const member = {
    id: authorId,
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    // Like discord.js's Collection.
    roles: { cache: Object.assign(roleCache, { some: (fn) => [...roleCache.values()].some(fn) }) },
  };
  const config = { antiNukeTrustedUsers: trusted ? [authorId] : [], antiNukeTrustedRoles: [TRUSTED_ROLE_ID] };
  const message = {
    content,
    mentions: { everyone: content.includes('@everyone') || content.includes('@here') },
    author: { id: authorId, bot: Boolean(webhookId) || authorId === BOT_ID },
    webhookId,
    applicationId,
    client: { user: { id: BOT_ID } },
    member,
    guild: {
      id: guildId,
      ownerId: guildOwnerId,
      client: { user: { id: BOT_ID }, db: { get: async (key, fallback) => (String(key).includes('config') ? config : fallback) } },
      members: { fetch: async (id) => (id === authorId ? member : null) },
    },
    delete: async () => { state.deleted = true; },
    channel: { send: async (payload) => { state.notices.push(payload); return { delete: async () => {} }; } },
  };
  return { message, state };
}

describe('@everyone guard', () => {
  test('never deletes this bot\'s own @everyone ping', async () => {
    const { message, state } = mentionMessage({ authorId: BOT_ID });
    assert.equal(await handleEveryoneMention(message), false);
    assert.equal(state.deleted, false);
  });

  for (const guildId of ['1155236281706627173', '1569932761471524874']) {
    test(`an ordinary staff member / admin @everyone or @here is still deleted (server ${guildId})`, async () => {
      for (const content of ['@everyone hi', '@here hi']) {
        const { message, state } = mentionMessage({ authorId: 'staff', guildId, content });
        assert.equal(await handleEveryoneMention(message), true);
        assert.equal(state.deleted, true);
        assert.equal(state.notices.length, 1);
        assert.match(state.notices[0].content, /للأونر والتراستد بس/u);
        assert.equal(state.notices[0].content, `🚫 <@staff> ${BLOCKED_NOTICE}`);
      }
    });

    test(`owner's decision after GH #320: a trusted member (trusted list or trusted role) may mention @everyone / @here (server ${guildId})`, async () => {
      for (const content of ['@everyone hi', '@here hi']) {
        for (const fixture of [{ trusted: true }, { trustedRole: true }]) {
          const { message, state } = mentionMessage({ authorId: 'trusted-staff', guildId, content, ...fixture });
          assert.equal(await canMentionEveryone(message), true);
          assert.equal(await handleEveryoneMention(message), false);
          assert.equal(state.deleted, false);
          assert.equal(state.notices.length, 0);
        }
      }
    });

    test(`the owners and the server owner may still mention @everyone (server ${guildId})`, async () => {
      for (const authorId of [OWNER_ID, 'guild-owner']) {
        const { message, state } = mentionMessage({ authorId, guildId });
        assert.equal(await handleEveryoneMention(message), false);
        assert.equal(state.deleted, false);
      }
    });
  }

  test('GH #320: a webhook @everyone is deleted unless the webhook is this bot\'s', async () => {
    const foreign = mentionMessage({ authorId: 'hook', webhookId: 'hook', applicationId: null });
    assert.equal(await handleEveryoneMention(foreign.message), true);
    assert.equal(foreign.state.deleted, true);
    assert.equal(foreign.state.notices.length, 0);

    // A webhook is never trusted, even with the id of a trusted member.
    const trustedHook = mentionMessage({ authorId: 'hook', webhookId: 'hook', applicationId: null, trusted: true });
    assert.equal(await handleEveryoneMention(trustedHook.message), true);

    const own = mentionMessage({ authorId: 'hook', webhookId: 'hook', applicationId: BOT_ID });
    assert.equal(await handleEveryoneMention(own.message), false);
    assert.equal(own.state.deleted, false);
  });

  test('a message without @everyone / @here is left alone', async () => {
    const { message, state } = mentionMessage({ authorId: 'staff', content: 'hello' });
    assert.equal(await handleEveryoneMention(message), false);
    assert.equal(state.deleted, false);
  });
});

describe('GH #323: a flood of @everyone through messageCreate', () => {
  for (const guildId of ['1155236281706627173', '1569932761471524874']) {
    test(`each copy is deleted by the guard, and the ${DUPLICATE_MESSAGES}th in 10 s is swept by the spam handler (no timeout) (server ${guildId})`, async () => {
      const { default: messageCreate } = await import('../src/events/messageCreate.js');
      const timeouts = [];
      const deletedByGuard = [];
      const bulkDeleted = [];
      const userId = `30000000000000${guildId.slice(-4)}`;
      const member = { id: userId, moderatable: true, user: { id: userId, bot: false }, permissions: new PermissionsBitField(), roles: { cache: new Map() }, timeout: async (ms, reason) => timeouts.push([ms, reason]) };
      const db = { get: async (_key, fallback) => fallback, set: async () => true };
      const client = { user: { id: BOT_ID }, db, commands: new Map() };
      const channel = { id: '700000000000000001', name: 'general', send: async () => ({ delete: async () => {} }), bulkDelete: async (ids) => { bulkDeleted.push(...ids); }, messages: { delete: async () => {} } };
      const guild = {
        id: guildId, ownerId: 'guild-owner', client, channels: { cache: new Map([[channel.id, channel]]), fetch: async () => null },
        members: { me: null, cache: new Map(), fetch: async () => member },
        roles: { cache: new Map() },
      };
      const start = Date.now();
      for (let i = 0; i < DUPLICATE_MESSAGES; i += 1) {
        const id = `80000000000000${String(i).padStart(4, '0')}`;
        await messageCreate.execute({
          id, content: '@everyone', channelId: channel.id, channel, guild, member, client,
          author: { id: userId, bot: false, tag: 'spammer' },
          attachments: new Map(), embeds: [], stickers: new Map(),
          mentions: { everyone: true, users: new Map(), roles: new Map(), has: () => false },
          createdTimestamp: start + i,
          delete: async () => { deletedByGuard.push(id); },
        }, client);
      }
      assert.equal(deletedByGuard.length, DUPLICATE_MESSAGES - 1, 'the guard deletes each copy until the flood');
      assert.equal(bulkDeleted.length, DUPLICATE_MESSAGES, 'the spam handler sweeps them all');
      assert.deepEqual(timeouts, [], 'deleted and warned only, no timeout');
    });
  }
});
