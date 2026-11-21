import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleImageOnlyChannelMessage, isRevealRoom, IMAGE_ONLY_CHANNEL_ID } from '../src/services/imageOnlyChannelService.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

function makeMessage({ channelId = IMAGE_ONLY_CHANNEL_ID, attachments = [], authorId = 'member' } = {}) {
  const state = { deleted: false };
  const message = {
    channelId,
    content: 'hello',
    attachments: new Map(attachments.map((attachment, index) => [String(index), attachment])),
    author: { id: authorId, bot: false },
    guild: {
      id: 'g',
      ownerId: 'owner',
      client: {
        user: { id: 'bot' },
      },
      members: { fetch: async () => null },
    },
    delete: async () => { state.deleted = true; },
    channel: { send: async () => null },
  };
  return { message, state };
}

describe('image-only channel', () => {
  test('deletes a text-only message', async () => {
    const { message, state } = makeMessage();
    assert.equal(await handleImageOnlyChannelMessage(message), true);
    assert.equal(state.deleted, true);
  });

  test('keeps an image with text', async () => {
    const { message, state } = makeMessage({ attachments: [{ name: 'a.png', contentType: 'image/png' }] });
    assert.equal(await handleImageOnlyChannelMessage(message), false);
    assert.equal(state.deleted, false);
  });

  test('deletes a message whose only attachment is not an image', async () => {
    const { message, state } = makeMessage({ attachments: [{ name: 'notes.txt', contentType: 'text/plain' }] });
    assert.equal(await handleImageOnlyChannelMessage(message), true);
    assert.equal(state.deleted, true);
  });

  test('lets the server owner write without an image', async () => {
    const { message, state } = makeMessage({ authorId: 'owner' });
    assert.equal(await handleImageOnlyChannelMessage(message), false);
    assert.equal(state.deleted, false);
  });

  test('ignores other channels', async () => {
    const { message, state } = makeMessage({ channelId: 'other' });
    assert.equal(await handleImageOnlyChannelMessage(message), false);
    assert.equal(state.deleted, false);
  });
});

describe('reveal room (silent image-only)', () => {
  test('deletes a text-only message without sending anything', async () => {
    const { message, state } = makeMessage({ channelId: '1569932762125705323' });
    let sent = 0;
    message.channel.send = async () => { sent += 1; return null; };
    assert.equal(await handleImageOnlyChannelMessage(message), true);
    assert.equal(state.deleted, true);
    assert.equal(sent, 0);
  });

  test('keeps an image', async () => {
    const { message, state } = makeMessage({ channelId: '1569932762125705323', attachments: [{ name: 'a.png', contentType: 'image/png' }] });
    assert.equal(await handleImageOnlyChannelMessage(message), false);
    assert.equal(state.deleted, false);
  });
});

describe('GH #318: reveal rooms in every server, for everyone', () => {
  const REVEAL = '1569932762125705323';

  test('the owner and staff are not exempt in the reveal room', async () => {
    // The guild owner (trusted) and a bot owner (SERVER_OWNER_IDS) could write without an image before.
    for (const authorId of ['owner', SERVER_OWNER_IDS[0]]) {
      const { message, state } = makeMessage({ channelId: REVEAL, authorId });
      assert.equal(await handleImageOnlyChannelMessage(message), true, authorId);
      assert.equal(state.deleted, true);
    }
  });

  test('text with an image stays; text-only, link-only, sticker-only and non-image files go', async () => {
    const keep = makeMessage({ channelId: REVEAL, attachments: [{ name: 'shot.JPG' }] });
    keep.message.content = 'my reveal';
    assert.equal(await handleImageOnlyChannelMessage(keep.message), false);
    assert.equal(keep.state.deleted, false);

    const cases = [
      { content: 'https://example.com/pic.png' },
      { content: '', stickers: new Map([['s', { id: 's' }]]) },
      { attachments: [{ name: 'clip.mp4', contentType: 'video/mp4' }] },
    ];
    for (const extra of cases) {
      const { message, state } = makeMessage({ channelId: REVEAL, attachments: extra.attachments || [] });
      if ('content' in extra) message.content = extra.content;
      if (extra.stickers) message.stickers = extra.stickers;
      assert.equal(await handleImageOnlyChannelMessage(message), true);
      assert.equal(state.deleted, true);
    }
  });

  test('a room named reveal in a second server works the same, silently', async () => {
    for (const name of ['reveal', '📸・reveal', 'ريفيل']) {
      const { message, state } = makeMessage({ channelId: '777000000000000001' });
      message.guild.id = '888000000000000001';
      let sent = 0;
      message.channel = { id: '777000000000000001', name, send: async () => { sent += 1; return null; } };
      assert.equal(isRevealRoom(message.channel), true, name);
      assert.equal(await handleImageOnlyChannelMessage(message), true, name);
      assert.equal(state.deleted, true);
      assert.equal(sent, 0);
    }
  });

  test('other rooms in a second server are left alone', async () => {
    const { message, state } = makeMessage({ channelId: '777000000000000002' });
    message.guild.id = '888000000000000001';
    message.channel = { id: '777000000000000002', name: 'general', send: async () => null };
    assert.equal(await handleImageOnlyChannelMessage(message), false);
    assert.equal(state.deleted, false);
  });

  test('messageCreate removes a text-only message in the reveal room', async () => {
    const { default: messageCreate } = await import('../src/events/messageCreate.js');
    const { message, state } = makeMessage({ channelId: REVEAL });
    message.channel = { id: REVEAL, name: 'reveal', send: async () => null };
    message.member = { id: 'member', roles: { cache: new Map() }, permissions: { has: () => false } };
    message.mentions = { users: new Map(), roles: new Map(), everyone: false, has: () => false };
    await messageCreate.execute(message, { user: { id: 'bot' }, db: { get: async (_key, fallback) => fallback, set: async () => true } });
    assert.equal(state.deleted, true);
  });
});
