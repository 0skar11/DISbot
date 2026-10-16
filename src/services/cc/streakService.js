// streakService.js — the daily streak (report #229, the idea saved for later), our server only.
//
// A member who writes in chat on a day (UTC) keeps their streak going; missing a whole day starts it
// again at 1. The first message of each day pays a bonus that grows with the streak (STREAK.base, then
// +STREAK.perDay a day, up to STREAK.cap), plus a one-time bonus on the milestones (7, 30, 100 days).
// The streak lives next to CC in the economy record as `ccStreak: { day, count, best }`.
//
// The streak room sits in the games category, right under the games channel: it holds the live top
// streak board (edited every few minutes) and the milestone announcements. `ستريك` / `streak` shows a
// member's streak and `توب ستريك` / `top streak` the longest ones.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { CC } from '../../config/cc.js';
import { updateCCState, utcDay } from './ccService.js';
import { getEconomyKey, getEconomyPrefix } from '../../utils/database.js';
import { findBoardMessage, rememberBoardMessage } from '../../utils/boardMessage.js';
import { getGuildConfig, updateGuildConfig } from '../config/guildConfig.js';
import { GAMES_CHANNEL_ID } from '../games/gamesChannel.js';
import { MEDALS } from '../games/text.js';
import { logger } from '../../utils/logger.js';

export const STREAK = {
    base: 5,
    perDay: 2,
    cap: 30,
    milestones: { 7: 100, 30: 500, 100: 2000 },
};
export const STREAK_CHANNEL_NAME = '🔥┃streak';
export const STREAK_BOARD_REFRESH_MS = 10 * 60 * 1000;
const STREAK_BOARD_TITLE = '🔥 Top Streak';
const BOARD_KEY = 'streak';
const CONFIG_KEY = 'streakChannelId';
const BOARD_SIZE = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

// The day each member's streak was last counted, so most messages don't touch the database.
const counted = new Map();
let timer = null;

const n = (amount) => amount.toLocaleString('en-US');

/** CC for reaching day `count` of a streak: the daily bonus and the milestone bonus. */
export function streakBonus(count) {
    const daily = Math.min(STREAK.base + STREAK.perDay * (count - 1), STREAK.cap);
    const milestone = STREAK.milestones[count] || 0;
    return { daily, milestone, total: daily + milestone };
}

/** A member's current streak from a stored record: 0 when it ran out (no message today or yesterday). */
export function liveStreak(streak, now = Date.now()) {
    if (!streak?.day || !streak.count) return 0;
    const today = utcDay(now);
    const yesterday = utcDay(now - DAY_MS);
    return streak.day === today || streak.day === yesterday ? streak.count : 0;
}

/**
 * Counts a chat message for the streak. Returns null when nothing changed (another server, or already
 * counted today), otherwise `{ count, best, bonus, milestone, restarted }`.
 */
export async function recordStreakMessage(client, guildId, userId, now = Date.now()) {
    if (!isHomeGuild(guildId) || !userId) return null;
    const today = utcDay(now);
    const key = `${guildId}:${userId}`;
    if (counted.get(key) === today) return null;

    const result = await updateCCState(client, guildId, userId, (state, record) => {
        const previous = record.ccStreak || {};
        if (previous.day === today) return { skipSave: true, unchanged: true };
        const continues = previous.day === utcDay(now - DAY_MS);
        const count = continues ? (previous.count || 0) + 1 : 1;
        const best = Math.max(previous.best || 0, count);
        const bonus = streakBonus(count);
        state.cc += bonus.total;
        state.stats.earned += bonus.total;
        record.ccStreak = { day: today, count, best };
        return { count, best, bonus: bonus.total, milestone: bonus.milestone, restarted: !continues && (previous.count || 0) > 1 };
    });
    counted.set(key, today);
    return result?.unchanged ? null : result;
}

/** Everyone with a running streak, longest first. */
export async function getStreakLeaderboard(client, guildId, now = Date.now()) {
    const prefix = getEconomyPrefix(guildId);
    const keys = await client.db.list(prefix);
    const rows = [];
    for (const key of Array.isArray(keys) ? keys : []) {
        const record = await client.db.get(key, null);
        const count = liveStreak(record?.ccStreak, now);
        if (count > 0) rows.push({ userId: key.slice(prefix.length), count, best: record.ccStreak.best || count });
    }
    return rows.sort((a, b) => b.count - a.count || b.best - a.best);
}

export async function streakTopEmbed(client, guild, userId = null, now = Date.now()) {
    const board = await getStreakLeaderboard(client, guild.id, now);
    const lines = board.slice(0, BOARD_SIZE).map((row, index) => `${MEDALS[index] || `**#${index + 1}**`} <@${row.userId}> — **${row.count}** يوم 🔥 (أحسن: ${row.best})`);
    const summary = [];
    if (userId) {
        const rank = board.findIndex((row) => row.userId === userId) + 1;
        summary.push(`👤 ترتيبك: ${rank ? `**#${rank}**` : '—'}`);
    }
    summary.push(`👥 ${board.length} عضو عندهم ستريك`);
    return {
        color: 0xe67e22,
        title: STREAK_BOARD_TITLE,
        description: [
            lines.join('\n') || 'لسه محدش عنده ستريك. اكتب في الشات كل يوم!',
            '',
            `📅 اكتب في الشات كل يوم عشان الستريك يكمل، ولو فوّت يوم كامل يرجع من 1.`,
            `🌀 كل يوم: ${STREAK.base} ${CC.short} + ${STREAK.perDay} كل يوم لحد ${STREAK.cap} • 🏅 ${Object.entries(STREAK.milestones).map(([day, cc]) => `${day} يوم = ${n(cc)}`).join(' • ')}`,
            '',
            summary.join(' • '),
        ].join('\n'),
    };
}

/** `ستريك` / `streak` [@member]: a member's streak. */
export async function streakProfileLine(client, guildId, userId, now = Date.now()) {
    const record = await client.db.get(getEconomyKey(guildId, userId), null);
    const count = liveStreak(record?.ccStreak, now);
    const best = record?.ccStreak?.best || 0;
    const today = record?.ccStreak?.day === utcDay(now);
    if (!count) return `🔥 <@${userId}> معندوش ستريك دلوقتي${best ? ` (أحسن ستريك: **${best}** يوم)` : ''}. اكتب في الشات النهارده عشان تبدأ.`;
    const next = streakBonus(count + 1);
    return [
        `🔥 ستريك <@${userId}>: **${count}** يوم (أحسن: **${Math.max(best, count)}**)`,
        today ? `✅ اتحسب النهارده. بكرة هتاخد **${next.total}** ${CC.short}.` : `⚠️ لسه ماكتبش النهارده، اكتب في الشات قبل ما اليوم يخلص عشان الستريك مايقعش.`,
    ].join('\n');
}

const PROFILE_WORDS = new Set(['ستريك', 'streak', 'الستريك']);
const TOP_WORDS = new Set(['توب', 'top']);
const USER = /^<@!?(\d{17,20})>$|^(\d{17,20})$/u;

/** `ستريك` / `top streak` typed in our server. Returns true when handled. */
export async function handleStreakCommand(message, commandName, args = []) {
    if (!isHomeGuild(message.guild?.id)) return false;
    const first = String(commandName || '').toLowerCase();
    const client = message.guild.client;
    if (TOP_WORDS.has(first) && PROFILE_WORDS.has(String(args[0] || '').toLowerCase()) && args.length === 1) {
        const embed = await streakTopEmbed(client, message.guild, message.author.id);
        await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
        return true;
    }
    if (!PROFILE_WORDS.has(first) || args.length > 1) return false;
    const match = args.length ? USER.exec(args[0]) : null;
    if (args.length && !match) return false;
    const userId = match ? (match[1] || match[2]) : message.author.id;
    await message.channel.send({ content: await streakProfileLine(client, message.guild.id, userId), allowedMentions: { parse: [] } }).catch(() => {});
    return true;
}

/** Finds or makes the streak room in the games category, right under the games channel. */
export async function ensureStreakChannel(guild) {
    if (!isHomeGuild(guild?.id)) return null;
    const config = await getGuildConfig(guild.client, guild.id).catch(() => null);
    const saved = config?.[CONFIG_KEY] && (guild.channels.cache.get(config[CONFIG_KEY]) || await guild.channels.fetch(config[CONFIG_KEY]).catch(() => null));
    if (saved) return saved;

    const games = guild.channels.cache.get(GAMES_CHANNEL_ID) || await guild.channels.fetch(GAMES_CHANNEL_ID).catch(() => null);
    const parentId = games?.parentId || null;
    let channel = guild.channels.cache.find((item) => item.type === ChannelType.GuildText && item.name === STREAK_CHANNEL_NAME && item.parentId === parentId);
    if (!channel) {
        const me = guild.members.me;
        channel = await guild.channels.create({
            name: STREAK_CHANNEL_NAME,
            type: ChannelType.GuildText,
            parent: parentId,
            topic: 'الستريك اليومي: اكتب في الشات كل يوم عشان الستريك يكمل وتاخد CC. اكتب `ستريك` في أي روم تشوف ستريكك.',
            reason: 'Streak room (report #229)',
            permissionOverwrites: [
                { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads] },
                ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] }] : []),
            ],
        });
        if (games && Number.isInteger(games.position)) await channel.setPosition(games.position + 1).catch(() => {});
    }
    await updateGuildConfig(guild.client, guild.id, { [CONFIG_KEY]: channel.id }).catch(() => {});
    return channel;
}

const isStreakBoard = (message) => message.embeds?.[0]?.title?.includes('Top Streak');

/** Edits the live board in the streak room, posting it when it isn't there. */
export async function publishStreakBoard(guild) {
    const channel = await ensureStreakChannel(guild);
    if (!channel?.send) return { status: 'no-channel' };
    const embed = { ...(await streakTopEmbed(guild.client, guild)), footer: { text: '🔄 بيتحدث تلقائي • آخر تحديث' }, timestamp: new Date().toISOString() };
    const payload = { content: '', embeds: [embed], allowedMentions: { parse: [] } };
    const existing = await findBoardMessage(channel, BOARD_KEY, isStreakBoard).catch(() => null);
    if (existing) {
        await existing.edit(payload);
        return { status: 'updated', channelId: channel.id };
    }
    const sent = await channel.send(payload);
    await rememberBoardMessage(channel, BOARD_KEY, sent.id);
    return { status: 'sent', channelId: channel.id };
}

/** Announces a milestone in the streak room. */
export async function announceStreakMilestone(guild, userId, result) {
    if (!result?.milestone) return false;
    const channel = await ensureStreakChannel(guild).catch(() => null);
    if (!channel?.send) return false;
    await channel.send({
        content: `🏅 <@${userId}> وصل ستريك **${result.count}** يوم! 🔥 خد **${n(result.bonus)}** ${CC.short}.`,
        allowedMentions: { users: [userId] },
    }).catch(() => {});
    return true;
}

/** messageCreate: counts the message for the streak and announces a milestone. Never throws. */
export async function handleStreakMessage(message) {
    try {
        const result = await recordStreakMessage(message.client || message.guild?.client, message.guild?.id, message.author?.id);
        if (result?.milestone) await announceStreakMilestone(message.guild, message.author.id, result);
        return result;
    } catch (error) {
        logger.warn(`[STREAK] Could not count a message: ${error.message}`);
        return null;
    }
}

/** Startup: the streak room and its board in our server, refreshed every STREAK_BOARD_REFRESH_MS. */
export async function startStreak(client) {
    const guild = [...client.guilds.cache.values()].find((item) => isHomeGuild(item.id));
    if (!guild) return { status: 'skipped' };
    const refresh = () => publishStreakBoard(guild).catch((error) => {
        logger.error('Failed to refresh the streak board:', error);
        return { status: 'failed' };
    });
    if (!timer) {
        timer = setInterval(refresh, STREAK_BOARD_REFRESH_MS);
        timer.unref?.();
    }
    return refresh();
}

/** For tests. */
export function resetStreakCache() {
    counted.clear();
}
