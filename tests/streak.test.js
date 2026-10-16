import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { getEconomyKey } from '../src/utils/database.js';
import {
  recordStreakMessage, streakBonus, liveStreak, getStreakLeaderboard, handleStreakCommand, resetStreakCache, STREAK,
} from '../src/services/cc/streakService.js';

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
    assert.equal(streakBonus(2).total, STREAK.base + STREAK.perDay);
    assert.equal(streakBonus(50).daily, STREAK.cap);
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
    assert.equal(ccOf(), STREAK.base * 2 + STREAK.perDay);

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
