// botActivityStats.js — the bot's activity counters: commands run, automatic admin actions and DMs sent, for the
// whole bot and per server. /bot-activity and the #bot-updates summaries (botUpdatesRoom.js) show them.
//
// Counting is synchronous and in memory: noteBotAction never throws and never waits for the database, so it is safe
// on every command. The counts are written at most every ACTIVITY_FLUSH_MS, one write at a time (reads wait for a
// write in progress), so two commands at once never overwrite each other's count. A failed write keeps the counts
// for the next one. This module imports nothing heavy, so the command paths can use it without import cycles.

import { logger } from '../utils/logger.js';

export const ACTIVITY_STATS_KEY = 'bot:activity:stats';
export const ACTIVITY_FLUSH_MS = 30_000;
export const COUNTER_FIELDS = Object.freeze(['dmsSent', 'birthdayDmsSent', 'actionsPerformed', 'commandsExecuted']);

const FIELDS_BY_TYPE = Object.freeze({
  dm: ['dmsSent'],
  birthday_dm: ['dmsSent', 'birthdayDmsSent'],
  action: ['actionsPerformed'],
  command: ['commandsExecuted'],
});

const zeroCounters = () => Object.fromEntries(COUNTER_FIELDS.map((field) => [field, 0]));
const emptyDelta = () => ({ ...zeroCounters(), guilds: {} });
const toCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const states = new WeakMap();
function stateOf(client) {
  if (!client || typeof client !== 'object') return null;
  let state = states.get(client);
  if (!state) {
    state = { pending: emptyDelta(), chain: Promise.resolve(), timer: null };
    states.set(client, state);
  }
  return state;
}

function addCounters(target, source) {
  for (const field of COUNTER_FIELDS) target[field] = toCount(target[field]) + toCount(source?.[field]);
  return target;
}

/** Adds `delta` (with its per-server counts) onto `target`, in place. */
function addDelta(target, delta) {
  addCounters(target, delta);
  if (!target.guilds || typeof target.guilds !== 'object') target.guilds = {};
  for (const [guildId, counters] of Object.entries(delta?.guilds || {})) {
    target.guilds[guildId] = addCounters({ ...zeroCounters(), ...(target.guilds[guildId] || {}) }, counters);
  }
  return target;
}

const hasCounts = (delta) => COUNTER_FIELDS.some((field) => delta[field] > 0) || Object.keys(delta.guilds).length > 0;

/** The saved stats with every counter present (older saves have no per-server counts). */
function normalizeStats(stored) {
  const base = stored && typeof stored === 'object' ? stored : {};
  const stats = { ...base, ...addCounters(zeroCounters(), base), lastUpdated: base.lastUpdated || Date.now(), guilds: {} };
  const guilds = base.guilds && typeof base.guilds === 'object' ? base.guilds : {};
  for (const [guildId, counters] of Object.entries(guilds)) stats.guilds[guildId] = addCounters(zeroCounters(), counters);
  return stats;
}

/** One server's counters out of getBotActivityStats' result (zeros when it has none yet). */
export function guildActivityStats(stats, guildId) {
  return addCounters(zeroCounters(), stats?.guilds?.[String(guildId)]);
}

function scheduleFlush(client, state) {
  if (state.timer || typeof client?.db?.set !== 'function') return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flushBotActivity(client).catch(() => {});
  }, ACTIVITY_FLUSH_MS);
  state.timer.unref?.();
}

/**
 * Counts one thing the bot did: 'command' (a slash or typed command ran), 'action' (an automatic admin action),
 * 'dm' or 'birthday_dm' (direct messages sent). Never throws and never waits. Returns whether it was counted.
 */
export function noteBotAction(client, type, { count = 1, guildId = null } = {}) {
  try {
    const fields = FIELDS_BY_TYPE[type];
    const amount = Math.floor(Number(count));
    const state = stateOf(client);
    if (!fields || !state || !(amount > 0)) return false;
    const add = (target) => {
      for (const field of fields) target[field] = toCount(target[field]) + amount;
    };
    add(state.pending);
    if (guildId) add(state.pending.guilds[String(guildId)] ||= zeroCounters());
    scheduleFlush(client, state);
    return true;
  } catch (error) {
    logger.debug?.(`Could not count bot activity: ${error?.message}`);
    return false;
  }
}

async function writePending(client, state) {
  if (!hasCounts(state.pending) || typeof client?.db?.get !== 'function' || typeof client?.db?.set !== 'function') return false;
  const delta = state.pending;
  state.pending = emptyDelta();
  try {
    // A read that fails must not reset the saved totals: the counts wait for the next write instead.
    const stored = await client.db.get(ACTIVITY_STATS_KEY, null);
    const next = addDelta(normalizeStats(stored), delta);
    next.lastUpdated = Date.now();
    await client.db.set(ACTIVITY_STATS_KEY, next);
    return true;
  } catch (error) {
    state.pending = addDelta(delta, state.pending);
    logger.warn(`Could not save the bot activity counts: ${error?.message}`);
    scheduleFlush(client, state);
    return false;
  }
}

/** Writes the counted activity now (after any write in progress). Resolves to whether it wrote; never rejects. */
export function flushBotActivity(client) {
  const state = stateOf(client);
  if (!state) return Promise.resolve(false);
  const run = state.chain.then(() => writePending(client, state)).catch(() => false);
  state.chain = run;
  return run;
}

/** The totals: what is saved plus what still waits to be written. Never rejects. */
export async function getBotActivityStats(client) {
  const state = stateOf(client);
  const read = async () => {
    let stored = null;
    if (typeof client?.db?.get === 'function') {
      stored = await Promise.resolve().then(() => client.db.get(ACTIVITY_STATS_KEY, null)).catch(() => null);
    }
    const stats = normalizeStats(stored);
    return state ? addDelta(stats, state.pending) : stats;
  };
  if (!state) return read();
  // Queued with the writes, so a read never sees counts that are half way to the database.
  const run = state.chain.then(read, read).catch(() => normalizeStats(null));
  state.chain = run;
  return run;
}

/** Counts `count` of `type` (see noteBotAction) and resolves to the new totals. Never rejects. */
export async function recordBotAction(client, type, count = 1, guildId = null) {
  noteBotAction(client, type, { count, guildId });
  return getBotActivityStats(client);
}
