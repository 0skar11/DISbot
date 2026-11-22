import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isBirthdayGreeting, formatBirthdayReply, handleBirthdayGreetingOnDelete } from '../src/services/birthdayGreetingService.js';
import { handleImageOnlyChannelMessage, IMAGE_ONLY_CHANNEL_ID } from '../src/services/imageOnlyChannelService.js';
import { handleReportChannelMessage, REPORT_CHANNEL_ID } from '../src/services/reportChannelService.js';
import { handleMediaMessage } from '../src/services/mediaRoleService.js';
import { handleProtectedChannelMessage } from '../src/services/protectedChannelsService.js';
import messageDeleteEvent from '../src/events/messageDelete.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

describe('Birthday greeting reply on message deletion', () => {
  test('isBirthdayGreeting detects various Arabic and English birthday/holiday greetings', () => {
    assert.equal(isBirthdayGreeting('كل سنه وانت طيب'), true);
    assert.equal(isBirthdayGreeting('كل سنة وانت طيب يا اوسكار'), true);
    assert.equal(isBirthdayGreeting('كل سنه وانتي طيبه'), true);
    assert.equal(isBirthdayGreeting('كل عام وانت بخير'), true);
    assert.equal(isBirthdayGreeting('كل عام وانتم بخير يا غالي'), true);
    assert.equal(isBirthdayGreeting('كل سنة وانت سالم وبصحة وسلامة'), true);
    assert.equal(isBirthdayGreeting('happy birthday oskar'), true);
    assert.equal(isBirthdayGreeting('hbd my friend'), true);

    // Negative cases
    assert.equal(isBirthdayGreeting('صباح الخير'), false);
    assert.equal(isBirthdayGreeting('عامل ايه'), false);
    assert.equal(isBirthdayGreeting('صورة عادية بدون تهنئة'), false);
    assert.equal(isBirthdayGreeting(''), false);
    assert.equal(isBirthdayGreeting(null), false);
  });

  test('formatBirthdayReply formats the reassurance from oskar', () => {
    const text = formatBirthdayReply('123456789012345678');
    assert.ok(text.includes('<@123456789012345678>'));
    assert.ok(text.includes('الرسالة وصلت متقلقش'));
    assert.ok(text.includes('وانت طيب'));
    assert.ok(text.includes('by oskar'));
  });

  test('handleBirthdayGreetingOnDelete sends channel reply and forwards to owner DM', async () => {
    const sentInChannel = [];
    const sentToOwner = [];
    const mockChannel = {
      id: '999888777666',
      name: 'general',
      send: async (payload) => {
        sentInChannel.push(payload);
        return { id: 'reply-1', delete: async () => {} };
      },
    };
    const mockMessage = {
      id: 'msg-birthday-1',
      content: 'كل سنه وانت طيب يا أوسكار وعقبال 100 سنة',
      author: { id: '333444555666777', tag: 'User#1234', bot: false },
      channel: mockChannel,
      channelId: mockChannel.id,
      client: {
        users: {
          fetch: async (id) => ({
            id,
            send: async (payload) => { sentToOwner.push({ id, ...payload }); },
          }),
        },
      },
    };

    const handled = await handleBirthdayGreetingOnDelete(mockMessage);
    assert.equal(handled, true);
    assert.equal(sentInChannel.length, 1);
    assert.match(sentInChannel[0].content, /الرسالة وصلت متقلقش/);
    assert.match(sentInChannel[0].content, /by oskar/);
    assert.ok(sentToOwner.length > 0);
    assert.match(sentToOwner[0].content, /تهنئة عيد ميلاد/);
    assert.match(sentToOwner[0].content, /User#1234/);
  });

  test('image-only and reveal room replies to deleted birthday greeting', async () => {
    const sent = [];
    let deleted = false;
    const channel = {
      id: '1569932762125705323', // Reveal room
      send: async (p) => { sent.push(p); return { delete: async () => {} }; },
    };
    const client = {
      user: { id: 'bot-id' },
      users: { fetch: async () => ({ send: async () => {} }) },
    };
    const message = {
      id: 'msg-reveal-bday',
      guild: {
        id: '1569932761471524874',
        ownerId: 'owner-id',
        client,
        members: { fetch: async () => null },
      },
      channel,
      channelId: channel.id,
      author: { id: '444555666777888', bot: false, tag: 'Fan#0001' },
      content: 'كل سنه وانت طيب يا معلم',
      attachments: new Map(),
      delete: async () => { deleted = true; },
      client,
    };

    const res = await handleImageOnlyChannelMessage(message);
    assert.equal(res, true);
    assert.equal(deleted, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /الرسالة وصلت متقلقش/);
    assert.match(sent[0].content, /by oskar/);
  });

  test('report channel replies to deleted birthday greeting', async () => {
    const sent = [];
    let deleted = false;
    const channel = {
      id: REPORT_CHANNEL_ID,
      send: async (p) => { sent.push(p); return { delete: async () => {} }; },
    };
    const message = {
      id: 'msg-report-bday',
      guild: { id: '1155236281706627173' }, // home guild
      channel,
      channelId: channel.id,
      author: { id: '555666777888999', bot: false, tag: 'BugsFan#0001' },
      content: 'كل سنة وانت طيب يا ريس',
      attachments: new Map(),
      delete: async () => { deleted = true; },
      client: { users: { fetch: async () => ({ send: async () => {} }) } },
    };

    const res = await handleReportChannelMessage(message);
    assert.equal(res, true);
    assert.equal(deleted, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /الرسالة وصلت متقلقش/);
    assert.match(sent[0].content, /by oskar/);
  });

  test('messageDelete event catches general deleted birthday greetings', async () => {
    const sent = [];
    const channel = {
      id: '999111222333',
      send: async (p) => { sent.push(p); return { delete: async () => {} }; },
    };
    const message = {
      id: 'msg-external-delete-bday',
      guild: { id: '1569932761471524874' },
      channel,
      author: { id: '666777888999000', bot: false, tag: 'Friend#0001' },
      content: 'Happy Birthday Oskar!!',
      createdTimestamp: Date.now() - 5000,
      client: {
        db: { get: async () => null },
        users: { fetch: async () => ({ send: async () => {} }) },
      },
    };

    await messageDeleteEvent.execute(message);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /الرسالة وصلت متقلقش/);
    assert.match(sent[0].content, /by oskar/);
  });
});
