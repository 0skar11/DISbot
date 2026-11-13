import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits, Events } from 'discord.js';
import {
  ROOM_KEYS,
  normalizeRoomName,
  matchesRoomKey,
  detectAuditRooms,
  getEnvAuditChannels,
  resolveAuditRoomId,
  resolveAuditRoom,
  postAuditRoom,
  clearAuditRoomCache,
  AUDIT_LOG_SETTINGS,
} from '../src/services/logging/auditRooms.js';
import { ensureAuditLogChannels } from '../src/services/auditLogChannelsService.js';
import { logEvent, getAuditRoomKeyForEvent, EVENT_TYPES } from '../src/services/loggingService.js';
import channelCreateEvent from '../src/events/channelCreate.js';
import channelDeleteEvent from '../src/events/channelDelete.js';
import channelUpdateEvent from '../src/events/channelUpdate.js';
import guildBanAddEvent from '../src/events/guildBanAdd.js';
import guildBanRemoveEvent from '../src/events/guildBanRemove.js';
import guildMemberRemoveEvent from '../src/events/guildMemberRemove.js';
import guildMemberUpdateEvent from '../src/events/guildMemberUpdate.js';
import autoModEvent from '../src/events/autoModerationActionExecution.js';
import messageBulkDeleteEvent from '../src/events/messageBulkDelete.js';

describe('Zenith Radar audit rooms', () => {
  beforeEach(() => {
    clearAuditRoomCache();
    delete process.env.AUDIT_CHANNELS_JSON;
    AUDIT_LOG_SETTINGS.auditRetryMs = 0;
  });

  test('normalizes room names and matches loose patterns with middle dots, casing and punctuation', () => {
    assert.equal(normalizeRoomName('Timeout · Untimeout'), 'timeoutuntimeout');
    assert.equal(normalizeRoomName('BAN · KICK'), 'bankick');
    assert.equal(normalizeRoomName('join · leave'), 'joinleave');
    assert.equal(normalizeRoomName('auto-mode'), 'automode');

    // Matching Zenith room names as shown in Discord
    assert.equal(matchesRoomKey('message', 'message'), true);
    assert.equal(matchesRoomKey('Message', 'message'), true);

    assert.equal(matchesRoomKey('channels', 'channels'), true);
    assert.equal(matchesRoomKey('Channels', 'channels'), true);

    assert.equal(matchesRoomKey('timeout · untimeout', 'timeout'), true);
    assert.equal(matchesRoomKey('Timeout · Untimeout', 'timeout'), true);
    assert.equal(matchesRoomKey('timeout', 'timeout'), true);

    assert.equal(matchesRoomKey('ban · kick', 'ban'), true);
    assert.equal(matchesRoomKey('BAN · KICK', 'ban'), true);
    assert.equal(matchesRoomKey('ban', 'ban'), true);

    assert.equal(matchesRoomKey('voice', 'voice'), true);
    assert.equal(matchesRoomKey('Voice', 'voice'), true);

    assert.equal(matchesRoomKey('join · leave', 'join'), true);
    assert.equal(matchesRoomKey('Join · Leave', 'join'), true);
    assert.equal(matchesRoomKey('join', 'join'), true);

    assert.equal(matchesRoomKey('invite', 'invites'), true);
    assert.equal(matchesRoomKey('Invite', 'invites'), true);
    assert.equal(matchesRoomKey('invites', 'invites'), true);

    assert.equal(matchesRoomKey('roles', 'roles'), true);
    assert.equal(matchesRoomKey('Roles', 'roles'), true);

    assert.equal(matchesRoomKey('automode', 'automode'), true);
    assert.equal(matchesRoomKey('AutoMode', 'automode'), true);
    assert.equal(matchesRoomKey('auto-mod', 'automode'), true);
  });

  test('auto-detects all 9 Radar rooms inside a category containing "Radar"', () => {
    const radarCategory = { id: 'cat_radar', name: '⚡ Radar ⚡', type: ChannelType.GuildCategory };
    const otherCategory = { id: 'cat_general', name: 'General', type: ChannelType.GuildCategory };

    const channels = new Map([
      ['cat_radar', radarCategory],
      ['cat_general', otherCategory],
      ['c_msg', { id: 'c_msg', name: 'message', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_chan', { id: 'c_chan', name: 'channels', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_time', { id: 'c_time', name: 'timeout · untimeout', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_ban', { id: 'c_ban', name: 'ban · kick', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_voice', { id: 'c_voice', name: 'voice', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_join', { id: 'c_join', name: 'join · leave', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_inv', { id: 'c_inv', name: 'invite', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_role', { id: 'c_role', name: 'roles', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_auto', { id: 'c_auto', name: 'automode', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      // Channel in another category should not match
      ['c_other_msg', { id: 'c_other_msg', name: 'message', parentId: 'cat_general', type: ChannelType.GuildText, isTextBased: () => true }],
    ]);

    const guild = {
      id: 'g_zenith',
      name: 'Zenith',
      channels: { cache: channels },
    };

    const detected = detectAuditRooms(guild);
    assert.deepEqual(detected, {
      message: 'c_msg',
      channels: 'c_chan',
      timeout: 'c_time',
      ban: 'c_ban',
      voice: 'c_voice',
      join: 'c_join',
      invites: 'c_inv',
      roles: 'c_role',
      automode: 'c_auto',
    });
  });

  test('persists detected IDs without overwriting manual IDs in config.auditChannels', async () => {
    const radarCategory = { id: 'cat_radar', name: 'Radar', type: ChannelType.GuildCategory };
    const channels = new Map([
      ['cat_radar', radarCategory],
      ['c_msg', { id: 'c_msg', name: 'message', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_voice', { id: 'c_voice', name: 'voice', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
    ]);

    const dbStore = new Map();
    const client = {
      db: {
        get: async (k, f) => (dbStore.has(k) ? dbStore.get(k) : f),
        set: async (k, v) => { dbStore.set(k, v); return true; },
      },
    };

    // Owner set a manual ID for voice
    dbStore.set('guild:g_persist:config', {
      auditChannels: {
        voice: 'manual_voice_123',
      },
    });

    const guild = {
      id: 'g_persist',
      name: 'Persist Guild',
      client,
      channels: { cache: channels },
    };

    const voiceId = await resolveAuditRoomId(guild, 'voice');
    assert.equal(voiceId, 'manual_voice_123', 'manual ID takes priority');

    const messageId = await resolveAuditRoomId(guild, 'message');
    assert.equal(messageId, 'c_msg', 'auto-detected message ID');

    // Verify config persistence
    const savedConfig = dbStore.get('guild:g_persist:config');
    assert.equal(savedConfig.auditChannels.voice, 'manual_voice_123', 'manual ID was not overwritten');
    assert.equal(savedConfig.auditChannels.message, 'c_msg', 'newly detected ID was persisted');
  });

  test('env override AUDIT_CHANNELS_JSON takes precedence', async () => {
    process.env.AUDIT_CHANNELS_JSON = JSON.stringify({
      g_env: {
        message: 'env_message_channel',
        ban: 'env_ban_channel',
      },
    });

    const channels = new Map([
      ['env_message_channel', { id: 'env_message_channel', isTextBased: () => true, permissionsFor: () => new Set() }],
    ]);

    const guild = {
      id: 'g_env',
      name: 'Env Guild',
      client: { db: { get: async () => ({}) } },
      channels: { cache: channels },
    };

    const resolvedId = await resolveAuditRoomId(guild, 'message');
    assert.equal(resolvedId, 'env_message_channel');
  });

  test('routing table correctly maps event types to room keys and preserves role.* for roleLogs', () => {
    assert.equal(getAuditRoomKeyForEvent('message.delete'), 'message');
    assert.equal(getAuditRoomKeyForEvent('message.edit'), 'message');
    assert.equal(getAuditRoomKeyForEvent('message.bulkdelete'), 'message');

    assert.equal(getAuditRoomKeyForEvent('moderation.ban'), 'ban');
    assert.equal(getAuditRoomKeyForEvent('moderation.kick'), 'ban');
    assert.equal(getAuditRoomKeyForEvent('moderation.unban'), 'ban');

    assert.equal(getAuditRoomKeyForEvent('moderation.timeout'), 'timeout');
    assert.equal(getAuditRoomKeyForEvent('moderation.untimeout'), 'timeout');
    assert.equal(getAuditRoomKeyForEvent('moderation.mute'), 'timeout');

    assert.equal(getAuditRoomKeyForEvent('member.join'), 'join');
    assert.equal(getAuditRoomKeyForEvent('member.leave'), 'join');

    // role.* stays with roleLogs to avoid duplicates
    assert.equal(getAuditRoomKeyForEvent('role.create'), null);
    assert.equal(getAuditRoomKeyForEvent('role.delete'), null);
    assert.equal(getAuditRoomKeyForEvent('role.update'), null);

    // Other events stay with fallback
    assert.equal(getAuditRoomKeyForEvent('giveaway.create'), null);
    assert.equal(getAuditRoomKeyForEvent('counter.update'), null);
  });

  test('logging.enabled=false still routes to audit rooms when room exists, unless explicitly disabled', async () => {
    const sent = [];
    const channel = {
      id: 'c_routed_msg',
      name: 'message',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      permissionsFor: () => ({
        has: () => true,
      }),
      send: async (payload) => {
        sent.push(payload);
        return { id: 'sent_msg' };
      },
    };

    const dbStore = new Map();
    dbStore.set('guild:g_disabled:config', {
      logging: {
        enabled: false, // General logging is disabled!
        enabledEvents: {},
      },
      auditChannels: {
        message: 'c_routed_msg',
      },
    });

    const client = {
      db: {
        get: async (k, f) => (dbStore.has(k) ? dbStore.get(k) : f),
      },
      guilds: {
        cache: new Map(),
      },
    };

    const guild = {
      id: 'g_disabled',
      name: 'Disabled Logging Guild',
      client,
      channels: { cache: new Map([['c_routed_msg', channel]]) },
      members: { me: { permissions: { has: () => true } } },
      iconURL: () => null,
    };
    client.guilds.cache.set(guild.id, guild);

    // 1. logging.enabled is false, but room exists -> routes!
    const result = await logEvent({
      client,
      guildId: guild.id,
      eventType: EVENT_TYPES.MESSAGE_DELETE,
      data: { title: 'Deleted' },
    });
    assert.ok(result);
    assert.equal(sent.length, 1);

    // 2. But if enabledEvents['message.delete'] === false, it is suppressed
    dbStore.set('guild:g_disabled:config', {
      logging: {
        enabled: false,
        enabledEvents: { 'message.delete': false },
      },
      auditChannels: {
        message: 'c_routed_msg',
      },
    });

    const suppressed = await logEvent({
      client,
      guildId: guild.id,
      eventType: EVENT_TYPES.MESSAGE_DELETE,
      data: { title: 'Deleted' },
    });
    assert.equal(suppressed, null);
    assert.equal(sent.length, 1); // No new message
  });

  test('missing permissions do not throw and return false', async () => {
    const channelNoPerms = {
      id: 'c_noperms',
      type: ChannelType.GuildText,
      isTextBased: () => true,
      permissionsFor: () => ({
        has: () => false, // missing View / Send / Embed
      }),
      send: async () => { throw new Error('Send should not be called without permissions'); },
    };

    const guild = {
      id: 'g_perms',
      name: 'Perms Guild',
      client: { db: { get: async () => ({ auditChannels: { message: 'c_noperms' } }) } },
      channels: { cache: new Map([['c_noperms', channelNoPerms]]) },
      members: { me: {} },
    };

    const posted = await postAuditRoom(guild, 'message', { title: 'Test' });
    assert.equal(posted, false, 'returns false and does not throw');

    // Missing room entirely also does not throw
    const missingPosted = await postAuditRoom(guild, 'non_existent_key', { title: 'Test' });
    assert.equal(missingPosted, false, 'missing room returns false and does not throw');
  });

  test('ensureAuditLogChannels runs auto-detection for every guild', async () => {
    const radarCategory = { id: 'cat_radar', name: 'Radar', type: ChannelType.GuildCategory };
    const channels = new Map([
      ['cat_radar', radarCategory],
      ['c_time', { id: 'c_time', name: 'timeout · untimeout', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
      ['c_ban', { id: 'c_ban', name: 'ban · kick', parentId: 'cat_radar', type: ChannelType.GuildText, isTextBased: () => true }],
    ]);

    const dbStore = new Map();
    const client = {
      guilds: {
        cache: new Map([
          ['g_ensure', { id: 'g_ensure', name: 'Ensure Guild', channels: { cache: channels } }],
        ]),
      },
      db: {
        get: async (k, f) => (dbStore.has(k) ? dbStore.get(k) : f),
        set: async (k, v) => { dbStore.set(k, v); return true; },
      },
    };

    await ensureAuditLogChannels(client);
    const config = dbStore.get('guild:g_ensure:config');
    assert.ok(config?.auditChannels);
    assert.equal(config.auditChannels.timeout, 'c_time');
    assert.equal(config.auditChannels.ban, 'c_ban');
  });

  test('new listeners post once to their respective audit rooms', async () => {
    const postedRooms = [];
    const makeAuditChannel = (id) => ({
      id,
      type: ChannelType.GuildText,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload) => {
        postedRooms.push({ id, payload });
        return { id: `sent_${id}` };
      },
    });

    const channelsMap = new Map([
      ['c_channels', makeAuditChannel('c_channels')],
      ['c_ban', makeAuditChannel('c_ban')],
      ['c_timeout', makeAuditChannel('c_timeout')],
      ['c_automode', makeAuditChannel('c_automode')],
      ['c_message', makeAuditChannel('c_message')],
    ]);

    const guild = {
      id: 'g_listeners',
      name: 'Listeners Guild',
      client: {
        db: {
          get: async () => ({
            auditChannels: {
              channels: 'c_channels',
              ban: 'c_ban',
              timeout: 'c_timeout',
              automode: 'c_automode',
              message: 'c_message',
            },
          }),
        },
      },
      channels: { cache: channelsMap },
      members: { me: { permissions: { has: () => true } } },
      fetchAuditLogs: async () => ({
        entries: [
          { target: { id: 'u1' }, executor: { id: 'mod1', username: 'Moderator' }, createdTimestamp: Date.now() },
        ],
      }),
    };

    // 1. channelCreate
    await channelCreateEvent.execute({ id: 'c_created', name: 'new-room', type: 0, guild });
    assert.equal(postedRooms.filter((p) => p.id === 'c_channels').length, 1);

    // 2. channelUpdate
    await channelUpdateEvent.execute(
      { id: 'c_update', name: 'old-name', guild },
      { id: 'c_update', name: 'new-name', guild }
    );
    assert.equal(postedRooms.filter((p) => p.id === 'c_channels').length, 2);

    // 3. guildBanAdd
    await guildBanAddEvent.execute({ guild, user: { id: 'u1', username: 'banned_user' }, reason: 'Toxicity' });
    assert.equal(postedRooms.filter((p) => p.id === 'c_ban').length, 1);

    // 4. guildBanRemove
    await guildBanRemoveEvent.execute({ guild, user: { id: 'u1', username: 'unbanned_user' } });
    assert.equal(postedRooms.filter((p) => p.id === 'c_ban').length, 2);

    // 5. guildMemberUpdate (timeout set)
    await guildMemberUpdateEvent.execute(
      { communicationDisabledUntilTimestamp: 0, nickname: 'nick', guild },
      { communicationDisabledUntilTimestamp: Date.now() + 600_000, id: 'u1', user: { id: 'u1', username: 'user1' }, nickname: 'nick', guild }
    );
    assert.equal(postedRooms.filter((p) => p.id === 'c_timeout').length, 1);

    // 6. autoModerationActionExecution
    await autoModEvent.execute({
      guild,
      userId: 'u1',
      channelId: 'c_chat',
      action: { type: 1 },
      content: 'bad content',
    });
    assert.equal(postedRooms.filter((p) => p.id === 'c_automode').length, 1);

    // 7. messageBulkDelete
    guild.client.guilds = { cache: new Map([[guild.id, guild]]) };
    const textChannel = { id: 'c_chat', name: 'general', guild, client: guild.client };
    await messageBulkDeleteEvent.execute(new Map([['m1', {}], ['m2', {}]]), textChannel);
    assert.equal(postedRooms.filter((p) => p.id === 'c_message').length, 1);
  });
});
