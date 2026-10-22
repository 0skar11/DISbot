import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { getEconomyKey } from '../src/utils/database.js';
import {
  recordStreakMessage, streakBonus, liveStreak, getStreakLeaderboard, handleStreakCommand, resetStreakCache, STREAK,
  ensureStreakChannel, handleStreakMessage, hasStreakMedia, sendDailyReminder, isStreakChannel, STREAK_CHANNEL_ID,
  publishStreakBoard, STREAK_CHANNEL_NAME, STREAK_BOARD_UPDATE_DELAY_MS,
} from '../src/services/cc/streakService.js';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../src/services/config/guildConfig.js';

const USER = '200000000000000001';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);

function setup() {
  const store = new Map();
  const client = {
    db: {
      get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
      list: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
  const ccOf = (guildId = HOME_GUILD_ID) => store.get(getEconomyKey(guildId, USER))?.cc || 0;
  return { client, store, ccOf };
}

describe('daily streak (report #229)', () => {
  beforeEach(() => resetStreakCache());

  test('bonus grows with the streak, is capped, and milestones pay once', () => {
    assert.equal(streakBonus(1).total, STREAK.base);
    assert.equal(STREAK.base, 250);
    assert.equal(streakBonus(STREAK.raiseEvery).daily, STREAK.base);
    assert.equal(streakBonus(STREAK.raiseEvery + 1).daily, STREAK.base + STREAK.raiseBy);
    assert.equal(streakBonus(1000).daily, STREAK.cap);
    assert.equal(streakBonus(7).milestone, STREAK.milestones[7]);
    assert.equal(streakBonus(8).milestone, 0);
  });

  test('one count per day, consecutive days grow it, a missed day starts again at 1', async () => {
    const { client, ccOf } = setup();
    assert.equal((await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW)).count, 1);
    assert.equal(await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW + 1000), null);
    assert.equal(ccOf(), STREAK.base);

    resetStreakCache();
    const second = await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW + DAY);
    assert.equal(second.count, 2);
    assert.equal(ccOf(), STREAK.base * 2);

    const missed = await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW + 3 * DAY);
    assert.equal(missed.count, 1);
    assert.equal(missed.best, 2);
    assert.equal(missed.restarted, true);
  });

  test('day 7 pays the milestone', async () => {
    const { client } = setup();
    let result;
    for (let day = 0; day < 7; day += 1) result = await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW + day * DAY);
    assert.equal(result.count, 7);
    assert.equal(result.milestone, STREAK.milestones[7]);
  });

  test('the board shows running streaks only; the commands answer', async () => {
    const { client } = setup();
    await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW);
    assert.equal(liveStreak({ day: '2026-10-16', count: 3 }, NOW + DAY), 3);
    assert.equal(liveStreak({ day: '2026-10-16', count: 3 }, NOW + 2 * DAY), 0);
    assert.deepEqual((await getStreakLeaderboard(client, HOME_GUILD_ID, NOW)).map((row) => row.userId), [USER]);

    const sent = [];
    const message = { guild: { id: HOME_GUILD_ID, client }, author: { id: USER }, channel: { send: async (payload) => sent.push(payload) } };
    assert.equal(await handleStreakCommand(message, 'ستريك', []), true);
    assert.match(sent[0].content, /ستريك/u);
    assert.equal(await handleStreakCommand(message, 'top', ['streak']), true);
    assert.match(sent[1].embeds[0].title, /Streak/u);
    assert.equal(await handleStreakCommand(message, 'ستريك', ['حلو', 'اوي']), false);
  });

  test('another server keeps nothing of this', async () => {
    const { client, store } = setup();
    assert.equal(await recordStreakMessage(client, '300000000000000001', USER, NOW), null);
    assert.equal(store.size, 0);
    const message = { guild: { id: '300000000000000001', client }, author: { id: USER }, channel: { send: async () => {} } };
    assert.equal(await handleStreakCommand(message, 'ستريك', []), false);
  });
});

describe('streak room: pictures and GIFs only, a reply every time, a daily reminder', () => {
  beforeEach(() => resetStreakCache());
  const ROOM = STREAK_CHANNEL_ID;

  async function room() {
    const base = setup();
    const posted = [];
    const channel = {
      id: ROOM, type: ChannelType.GuildText, name: STREAK_CHANNEL_NAME, parentId: 'category', topic: '',
      send: async (payload) => { posted.push(payload); return { id: `m${posted.length}` }; },
      permissionOverwrites: { cache: new Map(), edit: async () => {} }, setTopic: async () => {},
    };
    const guild = { id: HOME_GUILD_ID, client: base.client, channels: { cache: new Map([[ROOM, channel]]), fetch: async () => null } };
    channel.guild = guild;
    channel.client = base.client;
    base.client.guilds = { cache: new Map([[HOME_GUILD_ID, guild]]) };
    // The room's ID is saved in the guild config, as after the first startup.
    await updateGuildConfig(base.client, HOME_GUILD_ID, { streakChannelId: ROOM });
    await ensureStreakChannel(guild);
    const message = (extra = {}) => {
      const replies = [];
      return {
        guild, client: base.client, channelId: ROOM, author: { id: USER }, content: '', attachments: new Map(), embeds: [],
        reply: async (payload) => { replies.push(payload); return { delete: async () => {} }; }, react: async () => {}, replies, ...extra,
      };
    };
    return { ...base, guild, channel, posted, message };
  }

  test('a populated everyone overwrite keeps the pinned room without editing complete permissions', async () => {
    const { guild, channel } = await room();
    channel.permissionOverwrites.cache.set(guild.id, {
      allow: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions,
      ]),
    });
    channel.permissionOverwrites.edit = async () => assert.fail('complete permissions need no update');
    guild.channels.create = async () => assert.fail('must never create another room');
    assert.equal(await ensureStreakChannel(guild), channel);
    assert.equal(isStreakChannel(ROOM), true);
  });

  test('a valid pinned room with incomplete everyone permissions is opened without replacement', async () => {
    const { guild, channel } = await room();
    channel.permissionOverwrites.cache.set(guild.id, {
      allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    });
    const edits = [];
    channel.permissionOverwrites.edit = async (...args) => { edits.push(args); };
    guild.channels.create = async () => assert.fail('must never create another room');
    assert.equal(await ensureStreakChannel(guild), channel);
    assert.equal(isStreakChannel(ROOM), true);
    assert.deepEqual(edits, [[guild.id, {
      ViewChannel: true, ReadMessageHistory: true, SendMessages: true,
      AttachFiles: true, EmbedLinks: true, AddReactions: true,
    }, { reason: 'Streak room: daily pictures' }]]);
  });

  test('a stale saved ID cannot redirect counting away from the active room', async () => {
    const { client, guild, channel } = await room();
    await updateGuildConfig(client, HOME_GUILD_ID, { streakChannelId: '400000000000000001' });
    guild.channels.create = async () => assert.fail('must not create a duplicate room');
    assert.equal(await ensureStreakChannel(guild), channel);
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).streakChannelId, ROOM);
    assert.equal(isStreakChannel(ROOM), true);
  });

  test('a stale saved ID is reconciled to the pinned room, never another existing room', async () => {
    const { client, guild, channel, message, ccOf } = await room();
    resetStreakCache();
    await updateGuildConfig(client, HOME_GUILD_ID, { streakChannelId: '400000000000000001' });
    const other = { ...channel, id: '400000000000000100', parentId: null };
    guild.channels.cache.set(other.id, other);
    guild.channels.create = async () => assert.fail('must never create a room');
    assert.equal(await ensureStreakChannel(guild), channel);
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).streakChannelId, ROOM);
    const picture = new Map([['1', { contentType: 'image/png' }]]);
    assert.equal(await handleStreakMessage(message({ channelId: other.id, attachments: picture })), null);
    assert.equal(ccOf(), 0);
  });

  test('a missing pinned channel is not replaced and cannot award a streak from another room', async () => {
    const { client, guild, channel, message, ccOf } = await room();
    resetStreakCache();
    guild.channels.cache.clear();
    let creates = 0;
    guild.channels.create = async () => { creates += 1; };
    assert.equal(await ensureStreakChannel(guild), null);
    assert.equal(creates, 0);
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).streakChannelId, ROOM);
    const oldRoomMessage = message({ channelId: '400000000000000100', attachments: new Map([['1', { contentType: 'image/png' }]]) });
    assert.equal(await handleStreakMessage(oldRoomMessage), null);
    assert.equal(ccOf(), 0);
    assert.equal(oldRoomMessage.replies.length, 0);
  });

  test('a temporary Discord fetch failure cannot create another room', async () => {
    const { guild } = await room();
    resetStreakCache();
    guild.channels.cache.clear();
    guild.channels.fetch = async () => { throw Object.assign(new Error('Discord unavailable'), { code: 500 }); };
    guild.channels.create = async () => assert.fail('must not create on a temporary failure');
    await assert.rejects(ensureStreakChannel(guild), /Discord unavailable/);
  });

  test('successful images refresh the board promptly, coalescing the burst without duplicate rewards', async (t) => {
    const { client, guild, channel, message, ccOf } = await room();
    const boards = new Map();
    const boardEdits = [];
    let boardPosts = 0;
    client.user = { id: 'bot' };
    channel.messages = { fetch: async (query) => typeof query === 'string' ? boards.get(query) : boards };
    channel.send = async (payload) => {
      boardPosts += 1;
      const board = { id: 'board', author: client.user, createdTimestamp: 1, embeds: payload.embeds,
        edit: async (next) => { board.embeds = next.embeds; boardEdits.push(next); }, delete: async () => {} };
      boards.set(board.id, board);
      return board;
    };
    await Promise.all([publishStreakBoard(guild), publishStreakBoard(guild)]);
    assert.equal(boardPosts, 1, 'overlapping refreshes must not post two boards');
    boardEdits.length = 0;
    assert.match(boards.get('board').embeds[0].description, /0 عضو/u);
    boards.set('top-command-reply', { id: 'top-command-reply', author: client.user, createdTimestamp: 2,
      embeds: [{ title: '🔥 Top Streak' }], delete: async () => assert.fail('must preserve command replies') });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const picture = () => message({ attachments: new Map([['1', { contentType: 'image/png' }]]) });
    await handleStreakMessage(picture());
    await handleStreakMessage(message({ author: { id: '200000000000000002' }, attachments: picture().attachments }));
    await handleStreakMessage(picture());
    assert.equal(ccOf(), STREAK.base);
    assert.equal(boardEdits.length, 0, 'replies do not wait for a leaderboard scan');
    t.mock.timers.tick(STREAK_BOARD_UPDATE_DELAY_MS);
    // Join the scheduled refresh; both requests are serialized into at most one extra pass.
    await publishStreakBoard(guild);
    assert.match(boardEdits.at(-1).embeds[0].description, /2 عضو/u);
    assert.ok(boardEdits.length <= 2, 'a burst must not start one scan per image');
    assert.equal(boards.size, 2, 'one live board and the unchanged command reply');
  });

  test('pictures and GIF links count, text does not', () => {
    const image = { attachments: new Map([['1', { contentType: 'image/png', name: 'a.png' }]]) };
    assert.equal(hasStreakMedia(image), true);
    assert.equal(hasStreakMedia({ content: 'https://tenor.com/view/happy-123' }), true);
    assert.equal(hasStreakMedia({ embeds: [{ data: { type: 'gifv' } }] }), true);
    assert.equal(hasStreakMedia({ content: 'صباح الخير' }), false);
  });

  for (const [failureAt, code] of [['stored', 50013], ['stored', 'ETIMEDOUT'], ['recent', 'ETIMEDOUT']]) {
    test(`a ${code} failure fetching the ${failureAt} board does not post a replacement, and the next refresh recovers`, async () => {
      const { client, guild, channel } = await room();
      client.user = { id: 'bot' };
      let board;
      let boardPosts = 0;
      let boardEdits = 0;
      let failure = null;
      let failedPhase = null;
      channel.messages = { fetch: async (query) => {
        const phase = typeof query === 'string' ? 'stored' : 'recent';
        if (failure && phase === failureAt) {
          failedPhase = phase;
          throw failure;
        }
        // The saved board is older than the last 100 messages and cannot be found by scanning.
        return phase === 'stored' ? board : new Map();
      } };
      channel.send = async (payload) => {
        boardPosts += 1;
        board = { id: 'saved-board', author: client.user, createdTimestamp: 1, embeds: payload.embeds,
          edit: async (next) => { boardEdits += 1; board.embeds = next.embeds; },
          delete: async () => assert.fail('the existing board must remain intact') };
        return board;
      };

      assert.equal((await publishStreakBoard(guild)).status, 'sent');
      const original = board.embeds;
      failure = Object.assign(new Error('Discord lookup failed'), { code });
      await assert.rejects(publishStreakBoard(guild), (error) => error === failure);
      assert.equal(failedPhase, failureAt);
      assert.equal(boardPosts, 1, 'lookup failure must not cause a second board');
      assert.equal(boardEdits, 0);
      assert.equal(board.embeds, original);
      assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).boardMessageIds.streak, board.id);

      failure = null;
      assert.equal((await publishStreakBoard(guild)).status, 'updated');
      assert.equal(boardPosts, 1);
      assert.equal(boardEdits, 1);
    });
  }

  test('a confirmed deleted saved board can be replaced', async () => {
    const { client, guild, channel } = await room();
    client.user = { id: 'bot' };
    await updateGuildConfig(client, HOME_GUILD_ID, { boardMessageIds: { streak: 'deleted-board' } });
    channel.messages = { fetch: async (query) => {
      if (typeof query === 'string') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return new Map();
    } };
    let boardPosts = 0;
    channel.send = async () => { boardPosts += 1; return { id: 'replacement-board' }; };
    assert.equal((await publishStreakBoard(guild)).status, 'sent');
    assert.equal(boardPosts, 1);
    assert.equal((await getGuildConfig(client, HOME_GUILD_ID)).boardMessageIds.streak, 'replacement-board');
  });

  test('a picture updates the streak, a second one says it is done today, text is told it does not count', async () => {
    const { message, ccOf } = await room();
    assert.equal(isStreakChannel(ROOM), true);
    const picture = () => message({ attachments: new Map([['1', { contentType: 'image/gif', name: 'x.gif' }]]) });

    const first = picture();
    assert.equal((await handleStreakMessage(first)).count, 1);
    assert.match(first.replies[0].content, /ستريكك اتحدث: \*\*1\*\* يوم/u);
    assert.equal(ccOf(), STREAK.base);

    const again = picture();
    assert.equal(await handleStreakMessage(again), null);
    assert.match(again.replies[0].content, /متحدث النهارده خلاص \(\*\*1\*\* يوم\)/u);

    const text = message({ content: 'ازيكم' });
    await handleStreakMessage(text);
    assert.match(text.replies[0].content, /الكلام مابيتحسبش/u);
    assert.equal(ccOf(), STREAK.base);

    const elsewhere = message({ channelId: '400000000000000001', attachments: picture().attachments });
    assert.equal(await handleStreakMessage(elsewhere), null);
    assert.equal(elsewhere.replies.length, 0);
  });

  test('text and already-counted replies stay in the room', async (t) => {
    const { client, message } = await room();
    let deletions = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await recordStreakMessage(client, HOME_GUILD_ID, USER);
    const text = message({ content: 'ازيكم', reply: async (payload) => {
      text.replies.push(payload);
      return { delete: async () => { deletions += 1; } };
    } });
    const alreadyCounted = message({ attachments: new Map([['1', { contentType: 'image/png' }]]), reply: async (payload) => {
      alreadyCounted.replies.push(payload);
      return { delete: async () => { deletions += 1; } };
    } });

    await handleStreakMessage(text);
    await handleStreakMessage(alreadyCounted);
    t.mock.timers.tick(20_000);
    assert.equal(text.replies.length, 1);
    assert.equal(alreadyCounted.replies.length, 1);
    assert.equal(deletions, 0);
  });

  test('the evening reminder goes once a day and mentions streaks that would end tonight', async () => {
    const { client, guild, posted } = await room();
    await recordStreakMessage(client, HOME_GUILD_ID, USER, NOW - DAY);
    const evening = NOW - 12 * 60 * 60 * 1000 + (STREAK.reminderHourUtc + 1) * 60 * 60 * 1000;
    assert.equal(await sendDailyReminder(guild, NOW - 12 * 60 * 60 * 1000 + 60 * 60 * 1000), false, 'too early');
    assert.equal(await sendDailyReminder(guild, evening), true);
    assert.match(posted.at(-1).content, /تذكير الستريك/u);
    assert.deepEqual(posted.at(-1).allowedMentions.users, [USER]);
    assert.equal(await sendDailyReminder(guild, evening + 60 * 1000), false, 'once a day');
  });
});
