// #bot-updates admin activity logging (botUpdatesRoom.js, botActivityStats.js): rooms in every server, each server's
// own updates, the queued summaries, the counters and the reports. Two servers: ours and one that is not protected.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import {
  startBotUpdates, ensureBotUpdatesRoom, logBotUpdate, buildBotUpdatesGuide, LOGGED_OPERATIONS, BOT_UPDATES_CHANNEL_NAME,
  queueBotUpdate, flushBotUpdateBatches, BATCH_MAX_LINES, reportAntiSpam, reportOwnerMention, reportHardBan,
  reportTicketClosed, reportRoleSync, reportBootStatus, reportMassModeration, reportMassDm, postActivitySummary,
  startActivitySummaries, stopActivitySummaries, getBotActivityStats, guildActivityStats, flushBotActivity,
  recordBotAction, noteBotAction, ACTIVITY_STATS_KEY, flushBotUpdates,
} from '../src/services/botUpdatesRoom.js';
import { handleEveryoneMention } from '../src/services/everyoneMentionGuardService.js';
import { enforceHardBanOnJoin, enforceHardBanOnUnban } from '../src/services/moderation/hardBanService.js';
import { reconcileDeletedBirthdayGreetings } from '../src/services/birthdayGreetingService.js';
import { executePrefixCommand } from '../src/utils/messageAdapter.js';

const BOT_ID = '100000000000000001';
const OTHER_GUILD_ID = '1400000000000000001';
const GUILDS = [HOME_GUILD_ID, OTHER_GUILD_ID];
const GUIDE_FOOTER = 'Bot Updates • تحديثات وعمليات البوت';

const role = (id, name, permissions = 0n, extra = {}) => ({
  id, name, managed: false, position: 1, permissions: new PermissionsBitField(permissions), ...extra,
});

function setup(guildIds = GUILDS, { createError = {} } = {}) {
  const store = new Map();
  const db = {
    get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    getStatus: () => ({ connectionType: 'postgresql', isDegraded: false, degradedReason: 'db.internal:5432 password=hunter2' }),
  };
  const client = {
    user: { id: BOT_ID }, db, guilds: { cache: new Map() }, commands: new Map([['ping', {}], ['ban', {}], ['kick', {}]]),
    users: { fetch: async () => null },
  };
  const servers = {};
  let nextId = 1;
  let clock = 1;
  const snowflake = (prefix) => `${prefix}${String(nextId++).padStart(12, '0')}`;

  for (const guildId of guildIds) {
    const channels = new Map();
    const created = [];
    const guild = { id: guildId, name: `server ${guildId}`, client, ownerId: '900000000000000009' };
    const textChannel = (options) => {
      const messages = new Map();
      const channel = {
        id: snowflake('7000'), type: ChannelType.GuildText, client, guild, position: options.position ?? 0,
        parentId: options.parent ?? options.parentId ?? null, isTextBased: () => true, payloads: [], ...options,
        send: async (payload) => {
          channel.payloads.push(payload);
          const message = {
            id: snowflake('8000'), author: { id: BOT_ID }, embeds: payload.embeds, pinned: false, createdTimestamp: clock++,
          };
          message.pin = async () => { message.pinned = true; };
          message.edit = async (next) => { message.embeds = next.embeds; message.edits = (message.edits || 0) + 1; };
          message.delete = async () => { messages.delete(message.id); };
          messages.set(message.id, message);
          return message;
        },
        edit: async (opts) => {
          if (opts.position !== undefined) channel.position = opts.position;
          if (opts.parent !== undefined) channel.parentId = opts.parent;
          return channel;
        },
        messages: { fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) || null : new Map(messages)) },
      };
      channel.allMessages = messages;
      return channel;
    };
    const category = { id: snowflake('6000'), name: 'Radar / Logs', type: ChannelType.GuildCategory };
    channels.set(category.id, category);
    const sibling = textChannel({ name: 'message', parentId: category.id, position: 1 });
    channels.set(sibling.id, sibling);

    guild.channels = {
      cache: channels,
      fetch: async (id) => channels.get(id) || Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })),
      create: async (options) => {
        created.push(options);
        if (createError[guildId]) throw Object.assign(new Error('Missing Permissions'), { code: createError[guildId] });
        const channel = textChannel({ name: options.name, parent: options.parent ?? null, position: 0 });
        channels.set(channel.id, channel);
        return channel;
      },
    };
    const roles = [role(guildId, '@everyone'), role('300000000000000001', '🔨 Moderator', 0n, { position: 9 })];
    guild.roles = { cache: new Map(roles.map((r) => [r.id, r])) };
    guild.members = { fetch: async () => null, ban: async () => {} };
    client.guilds.cache.set(guildId, guild);
    servers[guildId] = { guild, channels, created, textChannel };
  }

  const roomOf = (guildId) => [...servers[guildId].channels.values()].find((c) => c.name === BOT_UPDATES_CHANNEL_NAME) || null;
  const postsIn = (guildId) => roomOf(guildId)?.payloads || [];
  return { client, store, servers, roomOf, postsIn };
}

const fakeMessage = (client, guildId, authorId, channelId = '710000000000000001') => ({
  client, guild: client.guilds.cache.get(guildId), author: { id: authorId }, channel: { id: channelId },
});

describe('#bot-updates rooms in every server', () => {
  test('startup makes the room and pins the guide in both servers (not only the protected ones)', async () => {
    const { client, servers, roomOf, postsIn } = setup();
    const results = await startBotUpdates(client);
    assert.equal(results.length, 2);
    for (const guildId of GUILDS) {
      assert.equal(servers[guildId].created.length, 1, guildId);
      assert.ok(roomOf(guildId), guildId);
      assert.equal(postsIn(guildId).length, 1);
      const guide = [...roomOf(guildId).allMessages.values()][0];
      assert.equal(guide.pinned, true);
      assert.equal(guide.embeds[0].footer.text, GUIDE_FOOTER);
    }
  });

  test('the guide lists exactly what is logged, in one field Discord accepts', () => {
    const guide = buildBotUpdatesGuide();
    assert.equal(guide.fields.length, 1);
    assert.equal(guide.fields[0].value, LOGGED_OPERATIONS.join('\n'));
    assert.ok(guide.fields[0].value.length <= 1024);
    for (const word of ['تشغيل البوت', 'Mention Everyone', 'عيد الميلاد', 'ماس بان', 'الهارد بان', 'السبام', 'منشن الأونر', 'التكتات', '6 ساعات']) {
      assert.ok(guide.fields[0].value.includes(word), word);
    }
    assert.ok(!/@(everyone|here)/u.test(JSON.stringify(guide)));
  });

  test('a restart edits the pinned guide in place and never deletes the log posts (old footer included)', async () => {
    const { client, roomOf } = setup();
    await startBotUpdates(client);
    for (const guildId of GUILDS) {
      const room = roomOf(guildId);
      // A log post from before this change, with the guide's footer.
      await room.send({ embeds: [{ title: '📬 إرسال رسائل التهنئة في الخاص', footer: { text: GUIDE_FOOTER } }] });
      await logBotUpdate(client, { guildId, title: 'new log' });
    }
    const second = await startBotUpdates(client);
    for (const [index, guildId] of GUILDS.entries()) {
      assert.match(second[index].status, /found, guide updated/u);
      const room = roomOf(guildId);
      assert.equal(room.allMessages.size, 3, guildId);
      const guide = [...room.allMessages.values()][0];
      assert.equal(guide.edits, 1);
      assert.equal(guide.embeds[0].fields[0].value, LOGGED_OPERATIONS.join('\n'));
      assert.equal(room.payloads.length, 3);
    }
  });

  test('two lookups at the same time (the two startup handlers) make one room only', async () => {
    const { client, servers } = setup();
    const guild = servers[OTHER_GUILD_ID].guild;
    const [a, b] = await Promise.all([
      ensureBotUpdatesRoom(client, guild),
      ensureBotUpdatesRoom(client, guild),
      logBotUpdate(client, { guildId: OTHER_GUILD_ID, title: 'role sync' }),
    ]);
    assert.equal(servers[OTHER_GUILD_ID].created.length, 1);
    assert.equal(a.channel.id, b.channel.id);
  });

  test('a server whose room cannot be made is skipped for a while instead of retried on every log', async () => {
    const { client, servers, postsIn } = setup(GUILDS, { createError: { [OTHER_GUILD_ID]: 50013 } });
    await startBotUpdates(client);
    const first = await logBotUpdate(client, { title: 'boot' });
    await logBotUpdate(client, { title: 'boot again' });
    assert.equal(servers[OTHER_GUILD_ID].created.length, 1);
    assert.deepEqual(first.map((r) => r.ok), [true, false]);
    assert.equal(postsIn(HOME_GUILD_ID).length, 3);
  });
});

describe('logBotUpdate', () => {
  test('goes to that server only with guildId, to every server without; never pings, empty values filled', async () => {
    const { client, postsIn } = setup();
    await logBotUpdate(client, {
      guildId: OTHER_GUILD_ID,
      title: 'hi @everyone',
      description: 'ping @here',
      fields: [{ name: 'empty', value: '' }, { name: 'zero', value: 0 }],
    });
    assert.equal(postsIn(HOME_GUILD_ID).length, 0);
    const [payload] = postsIn(OTHER_GUILD_ID);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const embed = payload.embeds[0];
    assert.ok(!/@(everyone|here)/u.test(JSON.stringify(embed)));
    assert.equal(embed.title, 'hi everyone');
    assert.deepEqual(embed.fields.map((f) => f.value), ['—', '0']);
    assert.notEqual(embed.footer.text, GUIDE_FOOTER);

    await logBotUpdate(client, { title: 'everyone gets this' });
    assert.equal(postsIn(HOME_GUILD_ID).length, 1);
    assert.equal(postsIn(OTHER_GUILD_ID).length, 2);
  });

  test('a failing room never throws (the action it reports goes on)', async () => {
    const { client, roomOf } = setup();
    await startBotUpdates(client);
    roomOf(HOME_GUILD_ID).send = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
    const results = await logBotUpdate(client, { title: 'x' });
    assert.deepEqual(results.map((r) => r.ok), [false, true]);
    // Broken clients and inputs: still no throw.
    assert.deepEqual(await logBotUpdate(null, { title: 'x' }), []);
    assert.deepEqual(await reportBootStatus({ guilds: null }), []);
    assert.equal(queueBotUpdate(undefined, HOME_GUILD_ID, 'antiSpam', 'x'), false);
    assert.equal(reportAntiSpam({}, { reason: 'r', punishment: 'p' }), false);
  });

  test('an embed with very long fields stays under Discord limits', async () => {
    const { client, postsIn } = setup();
    const long = 'س'.repeat(3000);
    await logBotUpdate(client, { guildId: HOME_GUILD_ID, title: 't', description: long, fields: Array.from({ length: 10 }, () => ({ name: 'n', value: long })) });
    const embed = postsIn(HOME_GUILD_ID)[0].embeds[0];
    const size = embed.title.length + (embed.description || '').length + embed.footer.text.length
      + embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.ok(size <= 6000, String(size));
    assert.ok(embed.fields.every((f) => f.value.length <= 1024 && f.value.length > 0));
  });
});

describe('activity counters', () => {
  test('commands and actions are counted per server, saved at once on flush, never double counted', async () => {
    const { client, store } = setup();
    for (let i = 0; i < 3; i += 1) noteBotAction(client, 'command', { guildId: HOME_GUILD_ID });
    noteBotAction(client, 'command', { guildId: OTHER_GUILD_ID });
    noteBotAction(client, 'action', { guildId: OTHER_GUILD_ID, count: 2 });
    assert.equal(noteBotAction(client, 'bogus'), false);
    assert.equal(noteBotAction(client, 'command', { count: 0 }), false);
    assert.equal(store.has(ACTIVITY_STATS_KEY), false);

    let stats = await getBotActivityStats(client);
    assert.equal(stats.commandsExecuted, 4);
    assert.equal(guildActivityStats(stats, HOME_GUILD_ID).commandsExecuted, 3);
    assert.equal(guildActivityStats(stats, OTHER_GUILD_ID).actionsPerformed, 2);

    assert.equal(await flushBotActivity(client), true);
    assert.equal(store.get(ACTIVITY_STATS_KEY).commandsExecuted, 4);
    assert.equal(store.get(ACTIVITY_STATS_KEY).guilds[OTHER_GUILD_ID].commandsExecuted, 1);
    stats = await getBotActivityStats(client);
    assert.equal(stats.commandsExecuted, 4);
  });

  test('many counts at once lose nothing, and a failed write keeps them for the next one', async () => {
    const { client, store } = setup();
    await Promise.all(Array.from({ length: 50 }, () => recordBotAction(client, 'action', 1, HOME_GUILD_ID)));
    const realSet = client.db.set;
    client.db.set = async () => { throw new Error('db down'); };
    assert.equal(await flushBotActivity(client), false);
    assert.equal((await getBotActivityStats(client)).actionsPerformed, 50);
    client.db.set = realSet;
    assert.equal(await flushBotActivity(client), true);
    assert.equal(store.get(ACTIVITY_STATS_KEY).actionsPerformed, 50);
    assert.equal(store.get(ACTIVITY_STATS_KEY).guilds[HOME_GUILD_ID].actionsPerformed, 50);
  });

  test('a typed command that runs is counted for its server; a wrong usage is not', async () => {
    const { client } = setup();
    const command = {
      data: { name: 'hello', toJSON: () => ({ name: 'hello', options: [{ name: 'word', type: 3, required: true }] }) },
      execute: async () => {},
    };
    const message = {
      id: '820000000000000001', content: '.hello x', client, guild: client.guilds.cache.get(OTHER_GUILD_ID),
      guildId: OTHER_GUILD_ID, author: { id: '500000000000000001', bot: false }, member: { permissions: new PermissionsBitField(PermissionFlagsBits.Administrator), roles: { cache: new Map() } },
      channel: { id: '710000000000000001', send: async () => ({ delete: async () => {} }) }, channelId: '710000000000000001',
      reply: async () => ({ delete: async () => {} }), mentions: { users: new Map(), members: new Map(), roles: new Map() },
      attachments: new Map(),
    };
    await executePrefixCommand(command, message, ['x'], client, '.');
    await executePrefixCommand(command, message, [], client, '.');
    const stats = await getBotActivityStats(client);
    assert.equal(guildActivityStats(stats, OTHER_GUILD_ID).commandsExecuted, 1);
    assert.equal(guildActivityStats(stats, HOME_GUILD_ID).commandsExecuted, 0);
  });
});

describe('queued summaries (anti-spam, owner mention, @everyone, hard ban, tickets)', () => {
  test('nothing is posted until the window ends; then one summary per server and kind, capped', async () => {
    const { client, postsIn } = setup();
    for (let i = 0; i < 20; i += 1) {
      reportAntiSpam(fakeMessage(client, HOME_GUILD_ID, `50000000000000${String(i).padStart(4, '0')}`), { reason: 'سبام', punishment: 'مسح الرسائل + وارن (1)' });
    }
    reportOwnerMention(fakeMessage(client, OTHER_GUILD_ID, '500000000000000099'), { punishment: '⚠️ وارن (2)' });
    assert.equal(postsIn(HOME_GUILD_ID).length, 0);
    assert.equal(postsIn(OTHER_GUILD_ID).length, 0);

    await flushBotUpdateBatches(client);
    const home = postsIn(HOME_GUILD_ID);
    assert.equal(home.length, 1);
    assert.match(home[0].embeds[0].title, /مكافحة السبام: 20 مرات/u);
    const lines = home[0].embeds[0].description.split('\n');
    assert.equal(lines.length, BATCH_MAX_LINES + 1);
    assert.match(lines.at(-1), /و 5 كمان/u);
    const other = postsIn(OTHER_GUILD_ID);
    assert.equal(other.length, 1);
    assert.match(other[0].embeds[0].title, /منشن الأونر: 1 مرة/u);
    // Only that server's member: none of the other server's spammers.
    assert.ok(!other[0].embeds[0].description.includes('<@500000000000000000>'));
    assert.match(other[0].embeds[0].description, /<@500000000000000099>/u);

    const stats = await getBotActivityStats(client);
    assert.equal(guildActivityStats(stats, HOME_GUILD_ID).actionsPerformed, 20);
    assert.equal(guildActivityStats(stats, OTHER_GUILD_ID).actionsPerformed, 1);
    assert.deepEqual(await flushBotUpdateBatches(client), []);
  });

  test('the @everyone guard queues its delete in that server', async () => {
    const { client, postsIn } = setup();
    for (const guildId of GUILDS) {
      const guild = client.guilds.cache.get(guildId);
      const message = {
        content: '@everyone hi', mentions: { everyone: true }, author: { id: '500000000000000005', bot: false },
        client, guild, member: { roles: { cache: new Map() } }, channel: { id: '710000000000000002', send: async () => null },
        delete: async () => {},
      };
      assert.equal(await handleEveryoneMention(message), true);
    }
    await flushBotUpdateBatches(client, { kind: 'everyoneGuard' });
    for (const guildId of GUILDS) {
      const [payload] = postsIn(guildId);
      assert.match(payload.embeds[0].title, /منشن everyone: 1 مرة/u);
      assert.match(payload.embeds[0].description, /<@500000000000000005> في <#710000000000000002>: الرسالة اتمسحت/u);
    }
  });

  test('hard ban enforcement: re-ban on rejoin and on an unban, and a trusted lift, reported per server', async () => {
    const { client, store, postsIn } = setup();
    const banned = [];
    for (const guildId of GUILDS) {
      store.set(`guild:${guildId}:config`, { hardBannedUsers: ['500000000000000007'] });
      const guild = client.guilds.cache.get(guildId);
      guild.members.ban = async (id) => { banned.push([guildId, id]); };
      guild.fetchAuditLogs = async () => ({ entries: { find: () => null } });
      await enforceHardBanOnJoin({ id: '500000000000000007', client, guild });
    }
    const home = client.guilds.cache.get(HOME_GUILD_ID);
    await enforceHardBanOnUnban({ guild: home, user: { id: '500000000000000007' } });
    // A trusted member (the server's owner) lifts it.
    home.fetchAuditLogs = async () => ({
      entries: { find: (fn) => [{ target: { id: '500000000000000007' }, createdTimestamp: Date.now(), executor: { id: home.ownerId } }].find(fn) },
    });
    await enforceHardBanOnUnban({ guild: home, user: { id: '500000000000000007' } });
    assert.equal(banned.length, 3);

    await flushBotUpdateBatches(client, { kind: 'hardBan' });
    const homeText = postsIn(HOME_GUILD_ID)[0].embeds[0].description;
    assert.match(postsIn(HOME_GUILD_ID)[0].embeds[0].title, /الهارد بان: 3 مرات/u);
    assert.match(homeText, /رجع السيرفر وعليه هارد بان • اتبند تاني/u);
    assert.match(homeText, /فك البان اترجع • اتبند تاني/u);
    assert.match(homeText, /الهارد بان اتفك بإيد تراستد \(<@900000000000000009>\)/u);
    assert.match(postsIn(OTHER_GUILD_ID)[0].embeds[0].title, /الهارد بان: 1 مرة/u);
  });

  test('closed tickets: with and without a transcript', async () => {
    const { client, postsIn } = setup();
    reportTicketClosed(client, OTHER_GUILD_ID, { ticket: '🎫 دعم #4', closedById: '500000000000000008', transcript: true });
    reportTicketClosed(client, OTHER_GUILD_ID, { ticket: '#ticket-5', closedById: '500000000000000008' });
    await flushBotUpdateBatches(client);
    const text = postsIn(OTHER_GUILD_ID)[0].embeds[0].description;
    assert.match(text, /🎫 دعم #4: قفله <@500000000000000008> • الترانسكريبت اتبعت/u);
    assert.match(text, /#ticket-5: قفله <@500000000000000008>$/mu);
    assert.equal(postsIn(HOME_GUILD_ID).length, 0);
  });

  test('shutdown posts the queued summaries and saves the counts', async () => {
    const { client, store, postsIn } = setup();
    reportHardBan(client, HOME_GUILD_ID, { event: 'rejoined', userId: '500000000000000007', ok: false });
    await flushBotUpdates(client);
    assert.match(postsIn(HOME_GUILD_ID)[0].embeds[0].description, /إعادة البان فشلت/u);
    assert.equal(store.get(ACTIVITY_STATS_KEY).actionsPerformed, 1);
  });
});

describe('reports', () => {
  const stripped = (overrides = {}) => ({
    changed: ['Helpers'],
    failed: [],
    kept: [
      { id: 'r1', name: '🛡️ Admin', reasons: ['Administrator'] },
      { id: 'r2', name: 'Trusted', reasons: ['trusted role'] },
      { id: 'r3', name: '@everyone', reasons: ['@everyone role'] },
    ],
    ...overrides,
  });

  test('role sync: changes are posted; the same result again is not; a new result is', async () => {
    const { client, servers, postsIn } = setup();
    for (const guildId of GUILDS) {
      const { guild } = servers[guildId];
      await reportRoleSync(client, guild, { demoted: { changed: ['Old Admin'], failed: [] }, stripped: stripped() });
      const embed = postsIn(guildId)[0].embeds[0];
      assert.match(embed.title, /صلاحيات الرتب/u);
      const text = JSON.stringify(embed);
      assert.match(text, /Helpers/u);
      assert.match(text, /Old Admin/u);
      assert.match(text, /🛡️ Admin: أدمن/u);
      assert.match(text, /Trusted: تراستد/u);
      assert.ok(!/@(everyone|here)/u.test(text));

      // Restart, nothing changed: nothing posted.
      await reportRoleSync(client, guild, { demoted: { changed: [], failed: [] }, stripped: stripped({ changed: [] }) });
      await reportRoleSync(client, guild, { demoted: { changed: [], failed: [] }, stripped: stripped({ changed: [] }) });
      assert.equal(postsIn(guildId).length, 2);
      // A role failed now: posted once.
      const failing = stripped({ changed: [], failed: ['Stuck'], kept: [...stripped().kept, { id: 'r4', name: 'Stuck', reasons: ['failed to change'] }] });
      await reportRoleSync(client, guild, { stripped: failing });
      await reportRoleSync(client, guild, { stripped: failing });
      assert.equal(postsIn(guildId).length, 3);
      assert.match(JSON.stringify(postsIn(guildId)[2].embeds[0]), /مقدرتش أشيل منها Mention Everyone/u);
    }
  });

  test('boot status goes to every server, without secrets', async () => {
    const { client, postsIn } = setup();
    await reportBootStatus(client);
    for (const guildId of GUILDS) {
      const embed = postsIn(guildId)[0].embeds[0];
      assert.match(embed.title, /البوت اشتغل/u);
      const text = JSON.stringify(embed);
      assert.match(text, /متوصلة \(postgresql\)/u);
      assert.match(text, /\*\*2\*\*/u);
      assert.match(text, /\*\*3\*\*/u);
      assert.ok(!text.includes('hunter2') && !text.includes('db.internal'));
    }
  });

  test('mass DMs and mass moderation report how many it went to, delivered and failed', async () => {
    const { client, postsIn } = setup();
    await reportMassDm(client, HOME_GUILD_ID, { what: 'test', sent: 2, failed: 1, users: [{ id: '500000000000000001', tag: 'a#1' }] });
    await reportMassModeration(client, OTHER_GUILD_ID, { action: 'ban', byId: '500000000000000009', done: 3, skipped: 1, failed: 1, dmTried: 3, dmSent: 2 });
    const dm = JSON.stringify(postsIn(HOME_GUILD_ID)[0].embeds[0]);
    assert.match(dm, /\*\*3\*\* عضو/u);
    assert.match(dm, /<@500000000000000001> \(a#1\)/u);
    const ban = postsIn(OTHER_GUILD_ID)[0].embeds[0];
    assert.match(ban.title, /هارد بان جماعي/u);
    assert.match(JSON.stringify(ban), /اتبعتت لـ \*\*3\*\* • وصلت \*\*2\*\* • فشلت \*\*1\*\*/u);
  });

  test('birthday replies: each server gets only its own members and counts', async () => {
    const { client, store, servers, postsIn } = setup();
    const users = {
      '300000000000000011': { id: '300000000000000011', tag: 'Home#1', bot: false, send: async () => {} },
      '300000000000000022': { id: '300000000000000022', tag: 'Other#2', bot: false, send: async () => {} },
      '300000000000000033': { id: '300000000000000033', tag: 'Closed#3', bot: false, send: async () => { throw new Error('Cannot send messages to this user'); } },
    };
    client.users.fetch = async (id) => users[id] || null;
    const authors = { [HOME_GUILD_ID]: ['300000000000000011'], [OTHER_GUILD_ID]: ['300000000000000022', '300000000000000033'] };
    for (const guildId of GUILDS) {
      const logs = new Map(authors[guildId].map((id, i) => [`log-${i}`, {
        embeds: [{ title: '❌ Message deleted', description: `Message author: <@${id}>\n\n> كل سنه وانت طيب` }],
      }]));
      const auditRoom = { id: `71000000000000009${guildId.slice(-1)}`, name: 'message', isTextBased: () => true, messages: { fetch: async () => logs } };
      servers[guildId].channels.set(auditRoom.id, auditRoom);
      store.set(`guild:${guildId}:config`, { auditChannels: { message: auditRoom.id } });
    }

    const stats = await reconcileDeletedBirthdayGreetings(client);
    assert.equal(stats.sent, 2);
    assert.equal(stats.failed, 1);
    const home = JSON.stringify(postsIn(HOME_GUILD_ID).at(-1).embeds[0]);
    const other = JSON.stringify(postsIn(OTHER_GUILD_ID).at(-1).embeds[0]);
    assert.match(home, /Home#1/u);
    assert.ok(!home.includes('Other#2'));
    assert.match(other, /Other#2/u);
    assert.ok(!other.includes('Home#1'));
    assert.match(other, /\*\*2\*\* عضو/u);
    const counted = await getBotActivityStats(client);
    assert.equal(guildActivityStats(counted, OTHER_GUILD_ID).birthdayDmsSent, 1);

    // Startup again: the closed DM fails again but is not posted again; the manual run reports it.
    const before = postsIn(OTHER_GUILD_ID).length;
    await reconcileDeletedBirthdayGreetings(client);
    assert.equal(postsIn(OTHER_GUILD_ID).length, before);
    await reconcileDeletedBirthdayGreetings(client, { reportFailures: true });
    assert.equal(postsIn(OTHER_GUILD_ID).length, before + 1);
  });

  test('activity summary every 6 hours: only servers with something new, with the new counts', async () => {
    const { client, postsIn } = setup();
    noteBotAction(client, 'command', { guildId: OTHER_GUILD_ID, count: 4 });
    const started = await startActivitySummaries(client, { intervalMs: 6 * 60 * 60 * 1000 });
    assert.equal(started.status, 'every 6h');
    assert.equal((await startActivitySummaries(client)).status, 'already running');
    try {
      noteBotAction(client, 'command', { guildId: OTHER_GUILD_ID, count: 3 });
      noteBotAction(client, 'dm', { guildId: OTHER_GUILD_ID });
      await postActivitySummary(client, null, { onlyIfChanged: true });
      assert.equal(postsIn(HOME_GUILD_ID).length, 0);
      const embed = postsIn(OTHER_GUILD_ID)[0].embeds[0];
      assert.match(embed.title, /Activity Summary/u);
      assert.match(JSON.stringify(embed), /الأوامر: \*\*7\*\* \(\+3\)/u);
      // Nothing new since: nothing posted.
      await postActivitySummary(client, null, { onlyIfChanged: true });
      assert.equal(postsIn(OTHER_GUILD_ID).length, 1);
      // /bot-activity post_card posts on demand.
      await postActivitySummary(client, client.guilds.cache.get(HOME_GUILD_ID));
      assert.equal(postsIn(HOME_GUILD_ID).length, 1);
    } finally {
      stopActivitySummaries(client);
    }
  });
});
