import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { proofChannelFor } from '../src/services/moderation/moderationActionLogService.js';
import {
  startBugsReports, buildBugsReportsGuide, BUGS_REPORTS_CHANNEL_NAME, STAFF_ALLOW, BOT_ALLOW,
} from '../src/services/bugsReportsRoom.js';

const role = (id, name, permissions = 0n, extra = {}) => ({ id, name, managed: false, position: 1, permissions: new PermissionsBitField(permissions), ...extra });

function setup(guildIds = [HOME_GUILD_ID]) {
  const store = new Map();
  const db = { get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback), set: async (key, value) => { store.set(key, structuredClone(value)); return true; } };
  const client = { user: { id: 'bot' }, db, guilds: { cache: new Map() } };
  const created = [];
  const servers = {};
  let nextId = 1;
  for (const guildId of guildIds) {
    const channels = new Map();
    const guild = { id: guildId, name: `server ${guildId}`, client };
    const textChannel = (options) => {
      const messages = new Map();
      const channel = {
        id: `5000000000000000${String(nextId++).padStart(2, '0')}`, type: ChannelType.GuildText, client, guild, sent: 0,
        isTextBased: () => true, ...options,
        send: async (payload) => {
          channel.sent += 1;
          const message = { id: `6000000000000000${String(nextId++).padStart(2, '0')}`, author: { id: 'bot' }, embeds: payload.embeds, pinned: false };
          message.pin = async () => { message.pinned = true; };
          message.edit = async (next) => { message.embeds = next.embeds; message.edits = (message.edits || 0) + 1; };
          messages.set(message.id, message);
          return message;
        },
        messages: { fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) || null : new Map(messages)) },
      };
      channel.allMessages = messages;
      return channel;
    };
    // The moderation log room sits in a staff category.
    const category = { id: `cat-${guildId}`, name: 'Staff Logs', type: ChannelType.GuildCategory };
    channels.set(category.id, category);
    const proofId = proofChannelFor(guildId);
    if (proofId) channels.set(proofId, { id: proofId, name: 'mod-log', type: ChannelType.GuildText, parentId: category.id });
    guild.channels = {
      cache: channels,
      fetch: async (id) => channels.get(id) || Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })),
      create: async (options) => {
        const channel = textChannel({ name: options.name, parentId: options.parent ?? null, permissionOverwrites: options.permissionOverwrites, topic: options.topic });
        created.push({ guildId, options, channel });
        channels.set(channel.id, channel);
        return channel;
      },
    };
    const roles = [
      role(guildId, '@everyone'),
      role('300000000000000001', '🔨 Moderator', 0n, { position: 9 }),
      role('300000000000000002', 'Helpers', PermissionFlagsBits.ManageMessages, { position: 5 }),
      role('300000000000000003', 'Members', PermissionFlagsBits.SendMessages, { position: 2 }),
      role('300000000000000004', 'Some Bot', PermissionFlagsBits.Administrator, { managed: true, position: 8 }),
    ];
    guild.roles = { cache: new Map(roles.map((r) => [r.id, r])) };
    client.guilds.cache.set(guildId, guild);
    servers[guildId] = { guild, channels, textChannel, category };
  }
  return { client, created, servers };
}

const allowOf = (overwrites, id) => overwrites.find((overwrite) => overwrite.id === id);

describe('#bugs-reports (owner\'s request)', () => {
  test('made once, private to the staff, in the staff log category; the guide is posted, pinned, then edited in place', async () => {
    const { client, created, servers } = setup();
    const [first] = await startBugsReports(client);
    assert.equal(created.length, 1);
    const { options, channel } = created[0];
    assert.equal(options.name, BUGS_REPORTS_CHANNEL_NAME);
    assert.equal(options.type, ChannelType.GuildText);
    assert.equal(options.parent, servers[HOME_GUILD_ID].category.id);
    assert.match(first.status, /created, guide sent/u);

    const overwrites = options.permissionOverwrites;
    assert.deepEqual(allowOf(overwrites, HOME_GUILD_ID).deny, [PermissionFlagsBits.ViewChannel], '@everyone can not see it');
    assert.deepEqual(allowOf(overwrites, '300000000000000001').allow, STAFF_ALLOW, 'a staff role by name');
    assert.deepEqual(allowOf(overwrites, '300000000000000002').allow, STAFF_ALLOW, 'a role with Manage Messages');
    for (const flag of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]) assert.ok(STAFF_ALLOW.includes(flag));
    assert.equal(allowOf(overwrites, '300000000000000003'), undefined, 'ordinary members are left out');
    assert.equal(allowOf(overwrites, '300000000000000004'), undefined, 'managed bot roles are left out');
    const bot = allowOf(overwrites, 'bot');
    assert.equal(bot.type, OverwriteType.Member);
    assert.deepEqual(bot.allow, BOT_ALLOW);
    assert.ok(BOT_ALLOW.includes(PermissionFlagsBits.SendMessages));

    const [guide] = channel.allMessages.values();
    assert.equal(guide.pinned, true);
    assert.equal(channel.sent, 1);

    // Restarts: no second room, no second post; the same message is edited.
    const [second] = await startBugsReports(client);
    await startBugsReports(client);
    assert.equal(created.length, 1);
    assert.equal(channel.sent, 1);
    assert.equal(guide.edits, 2);
    assert.match(second.status, /found, guide updated/u);
  });

  test('a #bugs-reports room that already exists is used, never duplicated', async () => {
    const { client, created, servers } = setup();
    const { channels, textChannel } = servers[HOME_GUILD_ID];
    const existing = textChannel({ name: BUGS_REPORTS_CHANNEL_NAME });
    channels.set(existing.id, existing);
    const [result] = await startBugsReports(client);
    assert.equal(created.length, 0);
    assert.equal(result.channelId, existing.id);
    assert.equal(existing.sent, 1);
  });

  test('Zenith gets it too; any other server gets nothing', async () => {
    const OTHER = '100000000000000099';
    const { client, created } = setup([ZENITH_GUILD_ID, OTHER]);
    const results = await startBugsReports(client);
    assert.deepEqual(created.map((entry) => entry.guildId), [ZENITH_GUILD_ID]);
    assert.deepEqual(results.map((entry) => entry.guildId), [ZENITH_GUILD_ID]);
  });

  test('the guide says what to report and how, in Arabic and English', () => {
    const guide = buildBugsReportsGuide();
    const text = [guide.title, guide.description, ...guide.fields.flatMap((field) => [field.name, field.value])].join('\n');
    for (const words of [/bug/iu, /wrong action/iu, /missing log/iu, /الأمر اللي استخدمته/u, /الروم/u, /الوقت/u, /سكرين شوت/u, /screenshot/iu]) {
      assert.match(text, words);
    }
  });
});
