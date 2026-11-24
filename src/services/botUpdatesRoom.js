// botUpdatesRoom.js — the staff-only #bot-updates channel at the very bottom of the Logs category, in every server
// the bot is in (owner's rule: every change is for all servers). Each server's room gets only that server's updates;
// only the boot status goes to every room. What is logged (the pinned guide, buildBotUpdatesGuide, lists the same):
//   • the boot status (database, servers, commands loaded), on every start;
//   • the startup role sync (Mention Everyone / Administrator taken off, the roles that kept it and why), on a change;
//   • mass DMs (birthday replies, massban / masskick): how many were sent to, delivered and failed;
//   • automatic moderation, one summary per window (BATCH_KINDS): anti-spam, owner mentions, the @everyone guard,
//     hard-ban enforcement and closed tickets;
//   • an activity summary every SUMMARY_INTERVAL_MS (only when something changed).
// Posting never pings (allowedMentions none, and everyone / here are written without the @) and never throws: a failed
// log must not break the action it reports. A server whose room cannot be made or written to is skipped for a while.

import { createHash } from 'node:crypto';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { findBoardMessage, rememberBoardMessage } from '../utils/boardMessage.js';
import { bugsReportsStaffRoles } from './bugsReportsRoom.js';
import { proofChannelFor } from './moderation/moderationActionLogService.js';
import { AUDIT_LOG_CATEGORY_ID } from './auditLogChannelsService.js';
import { findRadarCategories } from './logging/auditRooms.js';
import { REPLIED_USERS_DB_KEY } from './birthdayGreetingService.js';
import {
  COUNTER_FIELDS, getBotActivityStats, guildActivityStats, noteBotAction, flushBotActivity,
} from './botActivityStats.js';
import { logger } from '../utils/logger.js';

export {
  ACTIVITY_STATS_KEY, getBotActivityStats, guildActivityStats, noteBotAction, flushBotActivity, recordBotAction,
} from './botActivityStats.js';

export const BOT_UPDATES_CHANNEL_NAME = 'bot-updates';
const CONFIG_KEY = 'botUpdatesChannelId';
const BOARD_KEY = 'botUpdatesGuide';
// The guide keeps its footer and title, so the guide pinned before is found and edited in place.
const FOOTER = 'Bot Updates • تحديثات وعمليات البوت';
const GUIDE_TITLE = '🤖 تحديثات وعمليات البوت | Bot Activity & Updates';
// The log posts have their own footer: the guide lookup deletes extra copies of the guide, never a log post.
const LOG_FOOTER = 'Bot Updates • سجل البوت';
const MINUTE = 60_000;
// A server whose room could not be made or written to (missing permissions) is skipped for this long.
export const ROOM_RETRY_MS = 15 * MINUTE;
const ROOM_BLOCKING_CODES = new Set([50001, 50013, 30013]);
const FINGERPRINTS_KEY = (guildId) => `bot:updates:fingerprints:${guildId}`;

export const STAFF_VIEW_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
];

export const BOT_ALLOW = [
  ...STAFF_VIEW_ALLOW,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.PinMessages,
];

/** Hidden from @everyone; staff can view and read history; bot posts and pins. */
export function botUpdatesOverwrites(guild, botId, staffRoles) {
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...staffRoles.map((role) => ({
      id: role.id,
      type: OverwriteType.Role,
      allow: STAFF_VIEW_ALLOW,
      deny: [PermissionFlagsBits.SendMessages],
    })),
    { id: botId, type: OverwriteType.Member, allow: BOT_ALLOW },
  ];
}

/** Finds the logs category (moderation log room's parent, AUDIT_LOG_CATEGORY_ID, or radar category). */
export function staffCategory(guild) {
  const proofRoom = guild.channels.cache.get(proofChannelFor(guild.id));
  const candidates = [proofRoom?.parentId, AUDIT_LOG_CATEGORY_ID, ...findRadarCategories(guild).map((c) => c.id)];
  for (const id of candidates) {
    const category = id ? guild.channels.cache.get(id) : null;
    if (category?.type === ChannelType.GuildCategory) return category;
  }
  return null;
}

const knownRoomIds = new Set();

/** Whether the channel is the saved #bot-updates room of its server. */
export async function isBotUpdatesRoom(client, channel) {
  if (!channel?.id || !channel.guild?.id) return false;
  if (knownRoomIds.has(channel.id)) return true;
  if (channel.name !== BOT_UPDATES_CHANNEL_NAME) return false;
  const config = await getGuildConfig(client, channel.guild.id).catch(() => null);
  if (config?.[CONFIG_KEY] !== channel.id) return false;
  knownRoomIds.add(channel.id);
  return true;
}

const isRoom = (channel) => channel?.type === ChannelType.GuildText && channel.name === BOT_UPDATES_CHANNEL_NAME;

// Per client: the room of each server, the room lookups running now, the servers skipped for a while, the queued
// summaries (queueBotUpdate) and the activity summary timer.
const clientStates = new WeakMap();
function stateOf(client) {
  if (!client || typeof client !== 'object') return null;
  let state = clientStates.get(client);
  if (!state) {
    state = {
      rooms: new Map(),
      ensuring: new Map(),
      blockedUntil: new Map(),
      batches: new Map(),
      summaryBaseline: new Map(),
      summaryTimer: null,
    };
    clientStates.set(client, state);
  }
  return state;
}

/**
 * Finds or creates the #bot-updates room in the Logs category and places it at the very bottom. Calls for the same
 * server at the same time (the two startup handlers) share one lookup, so the room is never made twice.
 */
export async function ensureBotUpdatesRoom(client, guild) {
  const state = stateOf(client);
  const key = String(guild?.id);
  const running = state?.ensuring.get(key);
  if (running) return running;
  const task = findOrMakeRoom(client, guild)
    .then((result) => {
      if (result?.channel?.id) state?.rooms.set(key, result.channel.id);
      return result;
    })
    .finally(() => state?.ensuring.delete(key));
  state?.ensuring.set(key, task);
  return task;
}

async function findOrMakeRoom(client, guild) {
  const config = await getGuildConfig(client, guild.id).catch(() => null);
  const savedId = config?.[CONFIG_KEY] || null;
  let channel = savedId ? guild.channels.cache.get(savedId) || (await guild.channels.fetch(savedId).catch(() => null)) : null;
  if (channel && channel.type !== ChannelType.GuildText) channel = null;
  if (!channel) channel = [...guild.channels.cache.values()].find(isRoom) || null;

  let created = false;
  const category = staffCategory(guild);

  if (!channel) {
    if (typeof guild.channels?.create !== 'function') return { channel: null, created: false };
    const staffRoles = await bugsReportsStaffRoles(guild).catch(() => []);
    channel = await guild.channels.create({
      name: BOT_UPDATES_CHANNEL_NAME,
      type: ChannelType.GuildText,
      ...(category ? { parent: category.id } : {}),
      topic: '🤖 تحديثات وعمليات البوت اليومية والإدارية | Bot activity & operational updates',
      permissionOverwrites: botUpdatesOverwrites(guild, client.user.id, staffRoles),
      reason: 'Bot updates and activity log room (staff only)',
    });
    created = true;
    logger.info(`Created the #bot-updates room ${channel.id} in ${guild.name}`);
  }

  // Ensure the channel is under the category and positioned at the very bottom
  if (category) {
    const parentMismatch = channel.parentId !== category.id;
    const siblings = [...guild.channels.cache.values()].filter(
      (c) => c.parentId === category.id && c.id !== channel.id && c.type === ChannelType.GuildText,
    );
    const maxPos = siblings.length ? Math.max(...siblings.map((c) => c.position ?? 0)) : 0;
    const needsReposition = created || parentMismatch || (channel.position !== undefined && channel.position <= maxPos);

    if (parentMismatch || needsReposition) {
      await channel.edit({
        parent: category.id,
        position: maxPos + 1,
      }).catch((err) => logger.warn(`Could not set bottom position for #bot-updates: ${err.message}`));
    }
  }

  knownRoomIds.add(channel.id);
  if (savedId !== channel.id) {
    await updateGuildConfig(client, guild.id, { [CONFIG_KEY]: channel.id }).catch(() => {});
  }
  return { channel, created };
}

// Exactly what the room gets (each line matches a report function below).
export const LOGGED_OPERATIONS = Object.freeze([
  '• 🚀 **تشغيل البوت:** الداتابيز شغالة ولا لأ، عدد السيرفرات، والأوامر المحمّلة.',
  '• 🛡️ **صلاحيات الرتب وقت التشغيل:** الرتب اللي اتشال منها Mention Everyone أو Administrator، واللي فضلت معاها وليه (لما حاجة تتغير).',
  '• 📬 **رسايل الخاص الجماعية:** ردود تهاني عيد الميلاد: اتبعتت لكام واحد، ووصلت لكام، وفشلت لكام.',
  '• 🔨 **ماس بان / ماس كيك:** مين عمله، كام واحد اتبند أو اتطرد، وكام رسالة خاص وصلت.',
  '• 🔒 **الهارد بان:** فك بان اترجع، عضو رجع واتبند تاني، أو تراستد فك الهارد بان (ملخص كل دقيقة).',
  '• 🧹 **الأوتومود (ملخص كل 10 دقايق):** مسح السبام والوارن، وارن منشن الأونر، ومسح منشن everyone.',
  '• 🎫 **التكتات (ملخص كل 10 دقايق):** التكتات اللي اتقفلت، والترانسكريبت اتبعت ولا لأ.',
  '• 📊 **تقرير كل 6 ساعات:** الأوامر والإجراءات الإدارية ورسايل الخاص في السيرفر ده (لو فيه جديد).',
]);

export function buildBotUpdatesGuide() {
  return {
    color: 0x3498db,
    title: GUIDE_TITLE,
    description: 'هنا البوت بيكتب كل حاجة إدارية عملها لوحده في السيرفر ده. الروم للإدارة بس ومحدش بيتمنشن.',
    fields: [{ name: '📋 اللي بيتسجل هنا', value: LOGGED_OPERATIONS.join('\n') }],
    footer: { text: FOOTER },
  };
}

/** Posts the explanation once and pins it; later runs edit the same message. */
export async function publishBotUpdatesGuide(client, channel) {
  const payload = { embeds: [buildBotUpdatesGuide()], allowedMentions: { parse: [] } };
  // The title as well as the footer: older log posts carry the guide's footer and must not count as extra guides.
  const isGuide = (message) => message.author?.id === client.user.id
    && message.embeds?.[0]?.footer?.text === FOOTER && message.embeds?.[0]?.title === GUIDE_TITLE;
  const existing = await findBoardMessage(channel, BOARD_KEY, isGuide);
  if (existing) {
    await existing.edit(payload);
    if (!existing.pinned) await existing.pin().catch(() => {});
    return 'updated';
  }
  const sent = await channel.send(payload);
  await rememberBoardMessage(channel, BOARD_KEY, sent.id);
  await sent.pin().catch((error) => logger.warn(`Could not pin the bot-updates guide: ${error.message}`));
  return 'sent';
}

// Everyone / here are written without the @, so nothing in the room reads as a ping (the embeds never ping anyway).
const noPing = (text) => String(text ?? '').replace(/@(everyone|here)/giu, '$1');
const EMBED_BUDGET = 5_800;

/** A log embed within Discord's limits: no empty field, under 6000 characters in all, no @everyone / @here. */
export function buildLogEmbed({ title, description, fields = [], color = 0x3498db } = {}) {
  const embed = {
    color,
    title: noPing(title || 'تحديث البوت').slice(0, 256),
    fields: [],
    timestamp: new Date().toISOString(),
    footer: { text: LOG_FOOTER },
  };
  let budget = EMBED_BUDGET - embed.title.length - LOG_FOOTER.length;
  if (description) {
    embed.description = noPing(description).slice(0, Math.min(4000, budget));
    budget -= embed.description.length;
  }
  for (const field of (Array.isArray(fields) ? fields : []).slice(0, 25)) {
    const name = (noPing(field?.name) || '—').slice(0, 256);
    const room = Math.min(1024, budget - name.length);
    if (room < 16) break;
    const value = (noPing(field?.value) || '—').slice(0, room);
    embed.fields.push({ name, value, inline: Boolean(field?.inline) });
    budget -= name.length + value.length;
  }
  return embed;
}

function skipRoomFor(client, guildId, ms = ROOM_RETRY_MS) {
  stateOf(client)?.blockedUntil.set(String(guildId), Date.now() + ms);
}

/** The server's room: the one found this run (by ID), otherwise ensureBotUpdatesRoom. */
async function roomFor(client, guild) {
  const cached = guild.channels?.cache?.get?.(stateOf(client)?.rooms.get(String(guild.id)));
  if (cached?.type === ChannelType.GuildText && typeof cached.send === 'function') return cached;
  return (await ensureBotUpdatesRoom(client, guild))?.channel || null;
}

async function postToRoom(client, guild, embed) {
  const guildId = String(guild.id);
  const state = stateOf(client);
  if ((state?.blockedUntil.get(guildId) || 0) > Date.now()) return { guildId, ok: false, error: 'room unavailable' };
  try {
    const channel = await roomFor(client, guild);
    if (typeof channel?.send !== 'function') {
      skipRoomFor(client, guildId);
      return { guildId, ok: false, error: 'no room' };
    }
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return { guildId, messageId: message?.id ?? null, ok: true };
  } catch (error) {
    if (ROOM_BLOCKING_CODES.has(error?.code)) skipRoomFor(client, guildId);
    // A deleted room is looked up (or made) again on the next post.
    if (error?.code === 10003) state?.rooms.delete(guildId);
    logger.warn(`Failed to post bot update in ${guild.name || guildId}: ${error?.message}`);
    return { guildId, ok: false, error: error?.message || String(error) };
  }
}

/**
 * Posts one embed in #bot-updates: in that server's room with `guildId`, otherwise in every server's room (only the
 * boot status does that). Resolves to one result per server; never rejects.
 */
export async function logBotUpdate(client, { guildId = null, title, description, fields = [], color = 0x3498db } = {}) {
  try {
    const cache = client?.guilds?.cache;
    const guilds = guildId ? [cache?.get?.(String(guildId))].filter(Boolean) : [...(cache?.values?.() || [])];
    if (!guilds.length) return [];
    const embed = buildLogEmbed({ title, description, fields, color });
    const results = [];
    for (const guild of guilds) results.push(await postToRoom(client, guild, embed));
    return results;
  } catch (error) {
    logger.warn(`Could not post a bot update: ${error?.message}`);
    return [];
  }
}

export const SUMMARY_INTERVAL_MS = 6 * 60 * MINUTE;
const sameCounters = (a, b) => COUNTER_FIELDS.every((field) => a[field] === b[field]);

function summaryEmbed(client, stats, here, before, repliedCount) {
  const line = (label, field) => {
    const added = before && here[field] > before[field] ? ` (+${here[field] - before[field]})` : '';
    return `• ${label}: **${here[field]}**${added}`;
  };
  return {
    title: '📊 ملخص نشاط البوت | Activity Summary',
    description: before ? 'اللي بين القوسين هو الجديد من آخر تقرير.' : 'ملخص اللي البوت عمله في السيرفر ده.',
    fields: [
      {
        name: '🏠 في السيرفر ده',
        value: [
          line('الأوامر', 'commandsExecuted'),
          line('الإجراءات الإدارية', 'actionsPerformed'),
          line('رسايل الخاص', 'dmsSent'),
        ].join('\n'),
        inline: true,
      },
      {
        name: '🌐 البوت كله',
        value: [
          `• السيرفرات: **${client.guilds?.cache?.size || 0}**`,
          `• الأوامر المحمّلة: **${client.commands?.size || 0}**`,
          `• الأوامر اللي اتنفذت: **${stats.commandsExecuted}**`,
          `• رسايل الخاص: **${Math.max(stats.dmsSent, repliedCount)}** (تهاني عيد الميلاد **${Math.max(stats.birthdayDmsSent, repliedCount)}**)`,
        ].join('\n'),
        inline: true,
      },
    ],
    color: 0x2ecc71,
  };
}

/**
 * Posts the activity summary card in #bot-updates: in `guild`'s room, otherwise in every server's room with that
 * server's own counts. `onlyIfChanged` (the timer) skips a server where nothing changed since its last summary.
 * Never rejects.
 */
export async function postActivitySummary(client, guild = null, { onlyIfChanged = false } = {}) {
  try {
    const state = stateOf(client);
    const stats = await getBotActivityStats(client);
    const repliedList = await Promise.resolve().then(() => client?.db?.get?.(REPLIED_USERS_DB_KEY, [])).catch(() => []);
    const repliedCount = Array.isArray(repliedList) ? repliedList.length : 0;
    const targets = guild ? [guild] : [...(client?.guilds?.cache?.values?.() || [])];
    const results = [];
    for (const target of targets) {
      if (!target?.id) continue;
      const key = String(target.id);
      const here = guildActivityStats(stats, key);
      const before = state?.summaryBaseline.get(key) || null;
      if (onlyIfChanged && (before ? sameCounters(here, before) : !COUNTER_FIELDS.some((field) => here[field] > 0))) continue;
      const posted = await logBotUpdate(client, { guildId: key, ...summaryEmbed(client, stats, here, before, repliedCount) });
      if (posted.some((result) => result.ok)) state?.summaryBaseline.set(key, here);
      results.push(...posted);
    }
    return results;
  } catch (error) {
    logger.warn(`Could not post the activity summary: ${error?.message}`);
    return [];
  }
}

/** Starts the activity summary every `intervalMs` (once per client; the timer never keeps the process alive). */
export async function startActivitySummaries(client, { intervalMs = SUMMARY_INTERVAL_MS } = {}) {
  const state = stateOf(client);
  if (!state) return { status: 'skipped' };
  if (state.summaryTimer) return { status: 'already running' };
  state.summaryTimer = setInterval(() => {
    postActivitySummary(client, null, { onlyIfChanged: true }).catch(() => {});
  }, intervalMs);
  state.summaryTimer.unref?.();
  // The first summary of each server counts from this start.
  const stats = await getBotActivityStats(client);
  for (const guildId of client?.guilds?.cache?.keys?.() || []) {
    const key = String(guildId);
    if (!state.summaryBaseline.has(key)) state.summaryBaseline.set(key, guildActivityStats(stats, key));
  }
  return { status: `every ${Math.round(intervalMs / (60 * MINUTE))}h` };
}

export function stopActivitySummaries(client) {
  const state = stateOf(client);
  if (state?.summaryTimer) clearInterval(state.summaryTimer);
  if (state) state.summaryTimer = null;
}

/**
 * Startup hook: in every server, finds or makes the #bot-updates room at the bottom of the Logs category and
 * publishes (or edits in place) the pinned guide. A server where it fails is skipped by the logs for a while.
 */
export async function startBotUpdates(client) {
  const results = [];
  for (const guild of client.guilds.cache.values()) {
    try {
      const { channel, created } = await ensureBotUpdatesRoom(client, guild);
      const guide = await publishBotUpdatesGuide(client, channel);
      results.push({ guildId: guild.id, channelId: channel.id, status: `${created ? 'created' : 'found'}, guide ${guide}` });
    } catch (error) {
      skipRoomFor(client, guild.id);
      logger.warn(`Failed to set up #bot-updates in ${guild.name}: ${error?.message}`);
      results.push({ guildId: guild.id, channelId: null, status: 'failed' });
    }
  }
  return results;
}

// ---- Summaries of frequent actions: one post per server and kind per window, so the room is never flooded. ----

export const BATCH_MAX_LINES = 15;
export const BATCH_KINDS = Object.freeze({
  antiSpam: { title: '🧹 مكافحة السبام', color: 0xe74c3c, windowMs: 10 * MINUTE },
  ownerMention: { title: '📛 منشن الأونر', color: 0xfee75c, windowMs: 10 * MINUTE },
  everyoneGuard: { title: '🚫 منشن everyone', color: 0xe67e22, windowMs: 10 * MINUTE },
  hardBan: { title: '🔒 الهارد بان', color: 0x992d22, windowMs: MINUTE },
  tickets: { title: '🎫 التكتات', color: 0x95a5a6, windowMs: 10 * MINUTE },
});

/**
 * Adds one line to the server's summary of `kind` (BATCH_KINDS); the first line starts the window, and the summary is
 * posted when it ends. Counts one admin action. Synchronous, never throws; returns whether it was queued.
 */
export function queueBotUpdate(client, guildId, kind, line) {
  try {
    const spec = BATCH_KINDS[kind];
    const state = stateOf(client);
    if (!spec || !state || !guildId) return false;
    const key = `${guildId}:${kind}`;
    let batch = state.batches.get(key);
    if (!batch) {
      batch = { guildId: String(guildId), kind, count: 0, lines: [], timer: null };
      state.batches.set(key, batch);
      batch.timer = setTimeout(() => {
        flushBatch(client, key).catch(() => {});
      }, spec.windowMs);
      batch.timer.unref?.();
    }
    batch.count += 1;
    if (batch.lines.length < BATCH_MAX_LINES) batch.lines.push(String(line).slice(0, 300));
    noteBotAction(client, 'action', { guildId });
    return true;
  } catch (error) {
    logger.debug?.(`Could not queue a bot update: ${error?.message}`);
    return false;
  }
}

async function flushBatch(client, key) {
  const state = stateOf(client);
  const batch = state?.batches.get(key);
  if (!batch) return [];
  state.batches.delete(key);
  clearTimeout(batch.timer);
  const spec = BATCH_KINDS[batch.kind];
  const more = batch.count - batch.lines.length;
  return logBotUpdate(client, {
    guildId: batch.guildId,
    title: `${spec.title}: ${batch.count} ${batch.count === 1 ? 'مرة' : 'مرات'}`,
    description: [...batch.lines, more > 0 ? `… و ${more} كمان` : null].filter(Boolean).join('\n'),
    color: spec.color,
  });
}

/** Posts the queued summaries now (all, or one server / kind). Never rejects. */
export async function flushBotUpdateBatches(client, { guildId = null, kind = null } = {}) {
  const state = stateOf(client);
  if (!state) return [];
  const keys = [...state.batches.values()]
    .filter((batch) => (!guildId || batch.guildId === String(guildId)) && (!kind || batch.kind === kind))
    .map((batch) => `${batch.guildId}:${batch.kind}`);
  const results = [];
  for (const key of keys) results.push(...(await flushBatch(client, key).catch(() => [])));
  return results;
}

/** Shutdown: saves the counts and posts the queued summaries, waiting at most `timeoutMs`. Never rejects. */
export async function flushBotUpdates(client, { timeoutMs = 4_000 } = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const work = Promise.all([flushBotActivity(client), flushBotUpdateBatches(client)]).catch(() => null);
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}

// ---- What each part of the bot reports. Every function here never throws (the async ones never reject). ----

const isSnowflake = (id) => /^\d{15,22}$/u.test(String(id ?? ''));
const userRef = (id) => (isSnowflake(id) ? `<@${id}>` : 'حد مش معروف');
const channelRef = (channel) => (isSnowflake(channel?.id) ? `<#${channel.id}>` : 'روم مش معروفة');
const bullets = (names) => names.map((name) => `• ${name}`).join('\n');

/** Anti-spam (antiSpamService): the spam was deleted and the member warned. */
export function reportAntiSpam(message, { reason, punishment }) {
  return queueBotUpdate(message?.client, message?.guild?.id, 'antiSpam',
    `• ${userRef(message?.author?.id)} في ${channelRef(message?.channel)}: ${reason} • ${punishment}`);
}

/** Owner mention guard (antiSpamService): the message past the limit was deleted and warned. */
export function reportOwnerMention(message, { punishment }) {
  return queueBotUpdate(message?.client, message?.guild?.id, 'ownerMention',
    `• ${userRef(message?.author?.id)} في ${channelRef(message?.channel)}: ${punishment}`);
}

/** The @everyone / @here guard (everyoneMentionGuardService). */
export function reportEveryoneMention(message, { deleted = true } = {}) {
  const who = message?.webhookId ? 'webhook' : userRef(message?.author?.id);
  return queueBotUpdate(message?.client, message?.guild?.id, 'everyoneGuard',
    `• ${who} في ${channelRef(message?.channel)}: ${deleted ? 'الرسالة اتمسحت' : 'مقدرتش أمسح الرسالة'}`);
}

/** Hard-ban enforcement (hardBanService): 'lifted' by a trusted member, an unban 'reverted', or a ban on 'rejoined'. */
export function reportHardBan(client, guildId, { event, userId, executorId = null, ok = true }) {
  const result = ok ? 'اتبند تاني' : 'إعادة البان فشلت';
  const lines = {
    lifted: `• 🔓 ${userRef(userId)}: الهارد بان اتفك بإيد تراستد (${userRef(executorId)})`,
    reverted: `• 🔨 ${userRef(userId)}: فك البان اترجع${executorId ? ` (فكه ${userRef(executorId)})` : ''} • ${result}`,
    rejoined: `• 🔨 ${userRef(userId)}: رجع السيرفر وعليه هارد بان • ${result}`,
  };
  return lines[event] ? queueBotUpdate(client, guildId, 'hardBan', lines[event]) : false;
}

/** A closed ticket (tickets/homeTickets.js, ticket.js); `transcript` true / false when the ticket has one. */
export function reportTicketClosed(client, guildId, { ticket, closedById, transcript = null }) {
  const transcriptText = transcript === null ? '' : ` • الترانسكريبت ${transcript ? 'اتبعت' : 'متبعتش'}`;
  return queueBotUpdate(client, guildId, 'tickets', `• ${ticket}: قفله ${userRef(closedById)}${transcriptText}`);
}

const dmLine = (tried, sent) => `اتبعتت لـ **${tried}** • وصلت **${sent}** • فشلت **${Math.max(0, tried - sent)}**`;

/** A mass DM (e.g. the birthday replies): how many it was sent to, delivered and failed, and who got it. */
export async function reportMassDm(client, guildId, { what, sent = 0, failed = 0, users = [] } = {}) {
  try {
    const listed = users.slice(0, 20).map((user) => `• ${userRef(user.id)}${user.tag ? ` (${user.tag})` : ''}`);
    if (users.length > 20) listed.push(`… و ${users.length - 20} كمان`);
    return await logBotUpdate(client, {
      guildId,
      title: `📬 رسايل خاص جماعية: ${what}`,
      fields: [
        { name: '👥 اتبعتت لـ', value: `**${sent + failed}** عضو`, inline: true },
        { name: '✅ وصلت', value: `**${sent}**`, inline: true },
        { name: '❌ فشلت (الخاص مقفول)', value: `**${failed}**`, inline: true },
        ...(listed.length ? [{ name: 'وصلت لـ', value: listed.join('\n') }] : []),
      ],
      color: failed && !sent ? 0xe67e22 : 0x2ecc71,
    });
  } catch (error) {
    logger.warn(`Could not report a mass DM: ${error?.message}`);
    return [];
  }
}

/** massban (hard ban) / masskick: who ran it, the results, and the DMs to the members. */
export async function reportMassModeration(client, guildId, {
  action, byId, done = 0, skipped = 0, failed = 0, dmTried = 0, dmSent = 0,
} = {}) {
  try {
    const ban = action === 'ban';
    noteBotAction(client, 'action', { count: done, guildId });
    return await logBotUpdate(client, {
      guildId,
      title: ban ? '🔨 هارد بان جماعي' : '👢 كيك جماعي',
      description: `👮 عمله: ${userRef(byId)}`,
      fields: [
        { name: ban ? '✅ اتبند' : '✅ اتطرد', value: `**${done}**`, inline: true },
        { name: '⚠️ اتساب', value: `**${skipped}**`, inline: true },
        { name: '❌ فشل', value: `**${failed}**`, inline: true },
        { name: '📬 رسايل الخاص', value: dmLine(dmTried, dmSent) },
      ],
      color: ban ? 0x992d22 : 0xe67e22,
    });
  } catch (error) {
    logger.warn(`Could not report a mass ${action}: ${error?.message}`);
    return [];
  }
}

// The reasons of removeMentionEveryoneFromStaffRoles (MENTION_EVERYONE_KEPT_REASONS), in short Arabic.
const KEPT_REASONS_AR = Object.freeze({
  '@everyone role': 'رول everyone',
  'managed/integration': 'رول بوت أو integration',
  Administrator: 'أدمن (الجارد بيمسح منشناته)',
  'trusted role': 'تراستد',
  'owner role': 'رول الأونر',
  'above the bot': 'فوق رول البوت',
  'skipped: not a staff role': 'مش رول إدارة',
  'failed to change': 'التعديل فشل',
});

async function readFingerprints(client, guildId) {
  if (typeof client?.db?.get !== 'function') return null;
  const stored = await Promise.resolve().then(() => client.db.get(FINGERPRINTS_KEY(guildId), null)).catch(() => null);
  return stored && typeof stored === 'object' ? stored : {};
}

async function rememberFingerprint(client, guildId, key, fingerprint) {
  if (typeof client?.db?.set !== 'function') return;
  const stored = (await readFingerprints(client, guildId)) || {};
  await Promise.resolve().then(() => client.db.set(FINGERPRINTS_KEY(guildId), { ...stored, [key]: fingerprint })).catch(() => {});
}

/**
 * The startup role sync (events/staffRoleHierarchy.js): `demoted` from demoteAdministratorsBelowAdmin and `stripped`
 * from removeMentionEveryoneFromStaffRoles. Posted when a role was changed, or when the result (failures, the roles
 * that kept Mention Everyone and why) differs from the last one posted, so a restart with nothing new posts nothing.
 */
export async function reportRoleSync(client, guild, { demoted = null, stripped = null } = {}) {
  try {
    if (!guild?.id) return [];
    const adminChanged = demoted?.changed || [];
    const adminFailed = demoted?.failed || [];
    const changed = stripped?.changed || [];
    const failed = stripped?.failed || [];
    const kept = (stripped?.kept || []).filter((role) => !(role.reasons?.length === 1 && role.reasons[0] === 'failed to change'));
    const fingerprint = createHash('sha1')
      .update(JSON.stringify([adminChanged, adminFailed, changed, failed, kept.map((role) => [role.id, role.reasons])]))
      .digest('hex');
    const changedRoles = adminChanged.length + changed.length;
    const stored = changedRoles ? null : await readFingerprints(client, guild.id);
    if (stored && stored.roleSync === fingerprint) return [];

    noteBotAction(client, 'action', { count: changedRoles, guildId: guild.id });
    const fields = [
      changed.length && { name: '✂️ اتشال منها Mention Everyone', value: bullets(changed) },
      failed.length && { name: '❌ مقدرتش أشيل منها Mention Everyone', value: bullets(failed) },
      adminChanged.length && { name: '🔻 اتشال منها Administrator', value: bullets(adminChanged) },
      adminFailed.length && { name: '❌ مقدرتش أشيل منها Administrator', value: bullets(adminFailed) },
      {
        name: '🔒 لسه معاها Mention Everyone',
        value: kept.length
          ? kept.map((role) => `• ${role.name}: ${(role.reasons || []).map((reason) => KEPT_REASONS_AR[reason] || reason).join('، ')}`).join('\n')
          : 'ولا رتبة',
      },
    ].filter(Boolean);
    const results = await logBotUpdate(client, {
      guildId: guild.id,
      title: '🛡️ صلاحيات الرتب وقت التشغيل',
      description: changedRoles ? null : 'مفيش رتبة اتغيرت المرة دي، ده الوضع الحالي.',
      fields,
      color: failed.length || adminFailed.length ? 0xe67e22 : 0x3498db,
    });
    if (results.some((result) => result.ok)) await rememberFingerprint(client, guild.id, 'roleSync', fingerprint);
    return results;
  } catch (error) {
    logger.warn(`Could not report the role sync in ${guild?.name || guild?.id}: ${error?.message}`);
    return [];
  }
}

/** The boot status in every server's room: database, servers and commands loaded (no secrets). */
export async function reportBootStatus(client) {
  try {
    const db = client?.db?.getStatus?.() || null;
    const database = !db
      ? '❓ مش معروف'
      : db.isDegraded
        ? '⚠️ شغالة من الذاكرة بس، البيانات هتضيع مع الريستارت'
        : `✅ متوصلة (${db.connectionType || 'database'})`;
    return await logBotUpdate(client, {
      title: '🚀 البوت اشتغل',
      fields: [
        { name: '🗄️ الداتابيز', value: database },
        { name: '🌐 السيرفرات', value: `**${client?.guilds?.cache?.size || 0}**`, inline: true },
        { name: '⚙️ الأوامر المحمّلة', value: `**${client?.commands?.size || 0}**`, inline: true },
      ],
      color: db && !db.isDegraded ? 0x2ecc71 : 0xe67e22,
    });
  } catch (error) {
    logger.warn(`Could not report the boot status: ${error?.message}`);
    return [];
  }
}
