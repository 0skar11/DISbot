import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBirthdayGreeting,
  formatBirthdayReplyDm,
  reconcileDeletedBirthdayGreetings,
  REPLIED_USERS_DB_KEY,
} from '../src/services/birthdayGreetingService.js';
import { handleImageOnlyChannelMessage, IMAGE_ONLY_CHANNEL_ID } from '../src/services/imageOnlyChannelService.js';
import { handleReportChannelMessage, REPORT_CHANNEL_ID } from '../src/services/reportChannelService.js';
import { handleMediaMessage } from '../src/services/mediaRoleService.js';
import { handleProtectedChannelMessage } from '../src/services/protectedChannelsService.js';
import messageDeleteEvent from '../src/events/messageDelete.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

describe('Birthday greeting DM replies for already deleted messages', () => {
  test('isBirthdayGreeting detects various birthday greetings and rejects normal text', () => {
    assert.equal(isBirthdayGreeting('كل سنه وانت طيب'), true);
    assert.equal(isBirthdayGreeting('كل سنة وانت طيب يا اوسكار'), true);
    assert.equal(isBirthdayGreeting('كل سنه وانتي طيبه'), true);
    assert.equal(isBirthdayGreeting('كل عام وانت بخير يا غالي'), true);
    assert.equal(isBirthdayGreeting('كل سنة وانت سالم وبصحة وسلامة'), true);
    assert.equal(isBirthdayGreeting('happy birthday oskar'), true);
    assert.equal(isBirthdayGreeting('hbd bro'), true);

    assert.equal(isBirthdayGreeting('صباح الخير'), false);
    assert.equal(isBirthdayGreeting('صورة عادية بدون تهنئة'), false);
    assert.equal(isBirthdayGreeting(''), false);
    assert.equal(isBirthdayGreeting(null), false);
  });

  test('formatBirthdayReplyDm formats direct message from oskar', () => {
    const text = formatBirthdayReplyDm();
    assert.ok(text.includes('الرسالة وصلت متقلقش'));
    assert.ok(text.includes('وانت طيب وبألف خير'));
    assert.ok(text.includes('— by oskar ✨'));
  });

  test('reconcileDeletedBirthdayGreetings finds deleted birthday messages in audit log and sends DM', async () => {
    const dmsSent = [];
    const store = new Map();

    const user1 = { id: '300000000000000001', tag: 'Friend1#0001', bot: false, send: async (p) => { dmsSent.push({ to: '300000000000000001', ...p }); } };
    const user2 = { id: '300000000000000002', tag: 'Friend2#0002', bot: false, send: async (p) => { dmsSent.push({ to: '300000000000000002', ...p }); } };
    const ownerUser = { id: SERVER_OWNER_IDS[0], tag: 'Owner#0000', bot: false, send: async () => {} };

    const auditRoom = {
      id: 'c_msg_audit',
      isTextBased: () => true,
      messages: {
        fetch: async () => new Map([
          ['log-1', {
            embeds: [{
              title: '❌ Message deleted',
              description: 'Channel: <#1569932762125705323>\nMessage author: <@300000000000000001>\n\n### Message\n> كل سنه وانت طيب يا أوسكار وعقبال 100 سنة يا غالي',
            }],
          }],
          ['log-2', {
            embeds: [{
              title: '❌ Message deleted',
              description: 'Channel: <#1569932762125705323>\nMessage author: <@300000000000000002>\n\n### Message\n> Happy Birthday Oskar!! 🎉',
            }],
          }],
          ['log-3', { // Normal deleted message without greeting
            embeds: [{
              title: '❌ Message deleted',
              description: 'Channel: <#1569932762125705323>\nMessage author: <@300000000000000003>\n\n### Message\n> مين موجود يا شباب',
            }],
          }],
          ['log-4', { // Deleted message by owner (should be skipped)
            embeds: [{
              title: '❌ Message deleted',
              description: `Channel: <#1569932762125705323>\nMessage author: <@${SERVER_OWNER_IDS[0]}>\n\n### Message\n> كل سنه وانتم طيبين`,
            }],
          }],
        ]),
      },
    };

    const client = {
      db: {
        get: async (k, fb) => (store.has(k) ? store.get(k) : fb),
        set: async (k, v) => { store.set(k, v); return true; },
      },
      guilds: { cache: new Map() },
      users: {
        fetch: async (id) => {
          if (id === user1.id) return user1;
          if (id === user2.id) return user2;
          if (id === ownerUser.id) return ownerUser;
          return null;
        },
      },
      user: { id: 'bot-id' },
    };

    const guild = {
      id: '1569932761471524874',
      client,
      channels: {
        cache: new Map([[auditRoom.id, auditRoom]]),
        fetch: async (id) => (id === auditRoom.id ? auditRoom : null),
      },
    };
    client.guilds.cache.set(guild.id, guild);

    // Set guild audit channel in config
    store.set(`guild:${guild.id}:config`, { auditChannels: { message: auditRoom.id } });

    const stats = await reconcileDeletedBirthdayGreetings(client);
    assert.equal(stats.sent, 2);
    assert.equal(dmsSent.length, 2);
    assert.match(dmsSent[0].content, /الرسالة وصلت متقلقش/);
    assert.match(dmsSent[0].content, /— by oskar ✨/);
    assert.match(dmsSent[1].content, /الرسالة وصلت متقلقش/);

    // Verify replied users are saved to DB
    const saved = store.get(REPLIED_USERS_DB_KEY);
    assert.ok(Array.isArray(saved));
    assert.ok(saved.includes(user1.id));
    assert.ok(saved.includes(user2.id));

    // Running second time should send 0 new DMs
    const stats2 = await reconcileDeletedBirthdayGreetings(client);
    assert.equal(stats2.sent, 0);
    assert.equal(dmsSent.length, 2); // No new DMs
  });

  test('future deleted messages do NOT receive auto-replies', async () => {
    let sent = false;
    const channel = {
      id: '1569932762125705323', // Reveal room
      send: async () => { sent = true; return { delete: async () => {} }; },
    };
    const message = {
      id: 'msg-future-del',
      guild: {
        id: '1569932761471524874',
        ownerId: 'owner-id',
        client: { user: { id: 'bot-id' } },
        members: { fetch: async () => null },
      },
      channel,
      channelId: channel.id,
      author: { id: '444555666777888', bot: false, tag: 'Fan#0001' },
      content: 'كل سنه وانت طيب يا معلم',
      attachments: new Map(),
      delete: async () => {},
    };

    // Reveal room deletes silently without replying to future messages
    const res = await handleImageOnlyChannelMessage(message);
    assert.equal(res, true);
    assert.equal(sent, false); // No auto-reply sent in channel or future listener
  });
});
