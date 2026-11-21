import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { handleEveryoneMention } from '../src/services/everyoneMentionGuardService.js';

const BOT_ID = 'bot';
const OWNER_ID = '1159601661392715906';

function mentionMessage({ authorId, guildId = 'g', guildOwnerId = 'guild-owner', webhookId = null, applicationId = null, content = '@everyone', trusted = false }) {
  const state = { deleted: false, notices: [] };
  const message = {
    content,
    mentions: { everyone: content.includes('@everyone') || content.includes('@here') },
    author: { id: authorId, bot: Boolean(webhookId) || authorId === BOT_ID },
    webhookId,
    applicationId,
    client: { user: { id: BOT_ID } },
    // Staff holding Administrator and anti-nuke trust (the old rule let trusted members through).
    member: { permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) },
    guild: {
      id: guildId,
      ownerId: guildOwnerId,
      client: { db: { get: async (_key, fallback) => (trusted ? { antiNukeTrustedUsers: [authorId] } : fallback) } },
      members: { fetch: async () => null },
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
    test(`GH #320: an admin / trusted staff @everyone or @here is deleted (server ${guildId})`, async () => {
      for (const content of ['@everyone hi', '@here hi']) {
        const { message, state } = mentionMessage({ authorId: 'staff', guildId, content, trusted: true });
        assert.equal(await handleEveryoneMention(message), true);
        assert.equal(state.deleted, true);
        assert.equal(state.notices.length, 1);
      }
    });

    test(`GH #320: the owners and the server owner may still mention @everyone (server ${guildId})`, async () => {
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
