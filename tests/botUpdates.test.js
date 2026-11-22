import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { proofChannelFor } from '../src/services/moderation/moderationActionLogService.js';
import {
  startBotUpdates,
  ensureBotUpdatesRoom,
  publishBotUpdatesGuide,
  logBotUpdate,
  recordBotAction,
  getBotActivityStats,
  postActivitySummary,
  BOT_UPDATES_CHANNEL_NAME,
  STAFF_VIEW_ALLOW,
  BOT_ALLOW,
  botUpdatesOverwrites,
} from '../src/services/botUpdatesRoom.js';

const role = (id, name, permissions = 0n, extra = {}) => ({
  id,
  name,
  managed: false,
  position: 1,
  permissions: new PermissionsBitField(permissions),
  ...extra,
});

function setup(guildIds = [HOME_GUILD_ID]) {
  const store = new Map();
  const db = {
    get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
  };
  const client = { user: { id: 'bot' }, db, guilds: { cache: new Map() }, commands: new Map() };
  const created = [];
  const servers = {};
  let nextId = 1;

  for (const guildId of guildIds) {
    const channels = new Map();
    const guild = { id: guildId, name: `server ${guildId}`, client };

    const textChannel = (options) => {
      const messages = new Map();
      const channel = {
        id: `7000000000000000${String(nextId++).padStart(2, '0')}`,
        type: ChannelType.GuildText,
        client,
        guild,
        sent: 0,
        position: options.position ?? 0,
        parentId: options.parent ?? options.parentId ?? null,
        isTextBased: () => true,
        ...options,
        send: async (payload) => {
          channel.sent += 1;
          const message = {
            id: `8000000000000000${String(nextId++).padStart(2, '0')}`,
            author: { id: 'bot' },
            embeds: payload.embeds,
            pinned: false,
          };
          message.pin = async () => { message.pinned = true; };
          message.edit = async (next) => { message.embeds = next.embeds; message.edits = (message.edits || 0) + 1; };
          messages.set(message.id, message);
          return message;
        },
        edit: async (opts) => {
          if (opts.position !== undefined) channel.position = opts.position;
          if (opts.parent !== undefined) channel.parentId = opts.parent;
          return channel;
        },
        setPosition: async (pos) => {
          channel.position = pos;
          return channel;
        },
        messages: {
          fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) || null : new Map(messages)),
        },
      };
      channel.allMessages = messages;
      return channel;
    };

    // The logs category
    const category = { id: `cat-${guildId}`, name: 'Radar / Logs', type: ChannelType.GuildCategory };
    channels.set(category.id, category);

    // Existing sibling channels in category
    const sibling1 = textChannel({ name: 'message', parentId: category.id, position: 1 });
    const sibling2 = textChannel({ name: 'roles', parentId: category.id, position: 2 });
    channels.set(sibling1.id, sibling1);
    channels.set(sibling2.id, sibling2);

    const proofId = proofChannelFor(guildId);
    if (proofId) channels.set(proofId, { id: proofId, name: 'mod-log', type: ChannelType.GuildText, parentId: category.id });

    guild.channels = {
      cache: channels,
      fetch: async (id) => channels.get(id) || Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })),
      create: async (options) => {
        const channel = textChannel({
          name: options.name,
          parent: options.parent ?? null,
          permissionOverwrites: options.permissionOverwrites,
          topic: options.topic,
          position: 0,
        });
        created.push({ guildId, options, channel });
        channels.set(channel.id, channel);
        return channel;
      },
    };

    const roles = [
      role(guildId, '@everyone'),
      role('300000000000000001', '🔨 Moderator', 0n, { position: 9 }),
      role('300000000000000002', 'Helpers', PermissionFlagsBits.ManageMessages, { position: 5 }),
    ];
    guild.roles = { cache: new Map(roles.map((r) => [r.id, r])) };
    client.guilds.cache.set(guildId, guild);
    servers[guildId] = { guild, channels, textChannel, category, sibling1, sibling2 };
  }
  return { client, created, servers };
}

describe('#bot-updates channel & activity logging', () => {
  test('creates #bot-updates at the very bottom of the logs category and configures staff read-only permissions', async () => {
    const { client, created, servers } = setup();
    const results = await startBotUpdates(client);

    assert.equal(created.length, 1);
    const { options, channel } = created[0];
    assert.equal(options.name, BOT_UPDATES_CHANNEL_NAME);
    assert.equal(options.type, ChannelType.GuildText);
    assert.equal(channel.parentId, servers[HOME_GUILD_ID].category.id);

    // Verified placed at bottom: higher than sibling1 (1) and sibling2 (2)
    assert.ok(channel.position > 2);

    // Overwrites verification
    const overwrites = botUpdatesOverwrites(servers[HOME_GUILD_ID].guild, client.user.id, [
      { id: '300000000000000001' },
    ]);
    const everyoneOw = overwrites.find((o) => o.id === HOME_GUILD_ID);
    assert.ok(everyoneOw.deny.includes(PermissionFlagsBits.ViewChannel));

    const staffOw = overwrites.find((o) => o.id === '300000000000000001');
    assert.ok(staffOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(staffOw.deny.includes(PermissionFlagsBits.SendMessages));

    const botOw = overwrites.find((o) => o.id === client.user.id);
    assert.ok(botOw.allow.includes(PermissionFlagsBits.SendMessages));

    assert.match(results[0].status, /created, guide sent/u);
  });

  test('reusing existing room does not create a duplicate', async () => {
    const { client, created } = setup();
    await startBotUpdates(client);
    assert.equal(created.length, 1);

    const secondRun = await startBotUpdates(client);
    assert.equal(created.length, 1); // No new channel created
    assert.match(secondRun[0].status, /found/u);
  });

  test('publishBotUpdatesGuide pins the guide message and edits in place on second call', async () => {
    const { client, servers } = setup();
    const { channel } = await ensureBotUpdatesRoom(client, servers[HOME_GUILD_ID].guild);

    const first = await publishBotUpdatesGuide(client, channel);
    assert.equal(first, 'sent');
    assert.equal(channel.sent, 1);

    const second = await publishBotUpdatesGuide(client, channel);
    assert.equal(second, 'updated');
    assert.equal(channel.sent, 1); // No new message sent, edited existing
  });

  test('recordBotAction updates activity counts in persistent store and getBotActivityStats reads them', async () => {
    const { client } = setup();
    await recordBotAction(client, 'birthday_dm', 5);
    await recordBotAction(client, 'command', 3);
    await recordBotAction(client, 'action', 2);

    const stats = await getBotActivityStats(client);
    assert.equal(stats.birthdayDmsSent, 5);
    assert.equal(stats.dmsSent, 5);
    assert.equal(stats.commandsExecuted, 3);
    assert.equal(stats.actionsPerformed, 2);
  });

  test('logBotUpdate and postActivitySummary send formatted embeds into #bot-updates', async () => {
    const { client, servers } = setup();
    const { channel } = await ensureBotUpdatesRoom(client, servers[HOME_GUILD_ID].guild);

    await logBotUpdate(client, {
      guildId: HOME_GUILD_ID,
      title: 'Test Title',
      description: 'Test Description',
      fields: [{ name: 'Field 1', value: 'Value 1', inline: true }],
    });

    assert.ok(channel.sent >= 1);
    const messages = [...channel.allMessages.values()];
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.embeds[0].title, 'Test Title');

    await postActivitySummary(client, servers[HOME_GUILD_ID].guild);
    const messagesAfter = [...channel.allMessages.values()];
    const summaryMsg = messagesAfter[messagesAfter.length - 1];
    assert.match(summaryMsg.embeds[0].title, /Activity Summary/u);
  });
});
