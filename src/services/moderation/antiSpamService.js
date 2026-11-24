// antiSpamService.js — message flood protection (report #144) and the owner mention guard (report #148).
//
// Spam (GH #323): the same message DUPLICATE_MESSAGES (20) times within DUPLICATE_WINDOW_MS (10 s), or
// FLOOD_MESSAGES different messages within FLOOD_WINDOW_MS (copies of one message are left to the duplicate rule, so
// it really takes 20 of them): those messages are deleted, the member gets a warning (SPAM_TIMEOUT_MS is 0: no timeout, owner's decision).
// It runs before the other message guards (messageCreate.js), so a flood of @everyone, insults, invites or owner
// mentions — which those guards only delete or warn for — gets the timeout too. A single violation is still the
// other guard's alone. Owners, the server owner, bots, staff (Manage Messages) and the trusted (Anti-Nuke trusted
// members / roles) are left alone, and nobody the bot cannot moderate is timed out.
//
// Owner mentions (GH #323): each member may mention the owners (OWNER_PING_ID, the other server owners and the
// server's owner; typed in the message, replies to them don't count) OWNER_MENTION_LIMIT (5) times, counted over
// one message or several in a row (each within OWNER_MENTION_WINDOW_MS of the last). The mention that goes past it
// deletes that message and gives a warning. A message without the mention starts the count again. Only the owners
// may do it freely, and the staff too (report #196: staff roles, Manage Messages, or the Anti-Nuke trusted list),
// in every server.

import { PermissionFlagsBits } from 'discord.js';
import { SERVER_OWNER_IDS, isServerOwner } from '../../config/serverOwners.js';
import { issueWarning } from './warnEscalation.js';
import { sendModerationActionLog } from './moderationActionLogService.js';
import { canLiftHardBan } from './hardBanService.js';
import { isStaffMember } from '../staffRoleHierarchyService.js';
import { postAuditRoom } from '../logging/auditRooms.js';
import { reportAntiSpam, reportOwnerMention } from '../botUpdatesRoom.js';
import { logger } from '../../utils/logger.js';

export const FLOOD_MESSAGES = 10;
export const FLOOD_WINDOW_MS = 5_000;
export const DUPLICATE_MESSAGES = 20;
export const DUPLICATE_WINDOW_MS = 10_000;
// 0 turns the spam timeout off (the messages are still deleted and the member warned).
// 0 = no timeout at all: the owner wants only delete + warn (GH #323).
export const SPAM_TIMEOUT_MS = 0;

export const OWNER_PING_ID = '1159601661392715906';
export const OWNER_MENTION_LIMIT = 5;
export const OWNER_MENTION_WINDOW_MS = 20_000;
const USER_MENTION = /<@!?(\d{17,20})>/gu;

const NOTICE_DELETE_MS = 5_000;
const recent = new Map(); // guildId:userId -> [{ at, text, channelId, id }]
const ownerMentions = new Map(); // guildId:userId -> { count, at }

const isGuildOwner = (message) => Boolean(message.guild?.ownerId) && message.author?.id === message.guild.ownerId;

function isExempt(message) {
    return isServerOwner(message.author.id)
        || isGuildOwner(message)
        || Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageMessages));
}

const SPAM_REASONS = {
    flood: `سبام: ${FLOOD_MESSAGES} رسايل في ${FLOOD_WINDOW_MS / 1000} ثواني`,
    duplicate: `سبام: نفس الرسالة ${DUPLICATE_MESSAGES} مرة في ${DUPLICATE_WINDOW_MS / 1000} ثواني`,
};

async function notice(channel, userId, text) {
    const sent = await channel.send({ content: `🚫 <@${userId}> ${text}`, allowedMentions: { users: [userId] } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), NOTICE_DELETE_MS).unref?.();
}

/** Records the message and returns the spam kind ('flood' / 'duplicate') with the messages involved, or null. */
export function trackMessage(message, now = Date.now()) {
    const key = `${message.guild.id}:${message.author.id}`;
    const text = String(message.content || '').trim().toLowerCase();
    const entries = (recent.get(key) || []).filter((entry) => now - entry.at < DUPLICATE_WINDOW_MS);
    entries.push({ at: now, text, channelId: message.channelId, id: message.id });
    recent.set(key, entries);

    const flood = entries.filter((entry) => now - entry.at < FLOOD_WINDOW_MS);
    // Copies of the same message are the duplicate rule's (it takes DUPLICATE_MESSAGES of them); a message without
    // text (a picture, a sticker) always counts as a different one.
    const different = new Set(flood.map((entry) => entry.text || entry.id)).size;
    if (flood.length >= FLOOD_MESSAGES && different > 1) {
        recent.delete(key);
        return { kind: 'flood', entries: flood };
    }
    if (text) {
        const same = entries.filter((entry) => entry.text === text);
        if (same.length >= DUPLICATE_MESSAGES) {
            recent.delete(key);
            return { kind: 'duplicate', entries: same };
        }
    }
    return null;
}

/**
 * The spam timeout: SPAM_TIMEOUT_MS, never for the owners, the trusted, bots or a member the bot cannot moderate.
 * Returns whether it was applied.
 */
async function timeoutSpammer(message, member, reason) {
    if (!SPAM_TIMEOUT_MS || !member?.moderatable || member.user?.bot) return false;
    const applied = await member.timeout(SPAM_TIMEOUT_MS, `Anti-Spam: ${reason}`).then(() => true).catch((error) => {
        logger.warn(`Spam timeout failed for ${member.id}: ${error.message}`);
        return false;
    });
    if (applied) {
        await sendModerationActionLog(message.guild, { action: 'timeout', targetUser: message.author, moderatorUser: message.client.user, reason, durationMs: SPAM_TIMEOUT_MS, channel: message.channel }).catch(() => {});
    }
    return applied;
}

/** Deletes the spam, warns the member and times them out. Returns true when the message was spam. */
export async function handleSpam(message, { now = Date.now(), warn = issueWarning } = {}) {
    if (!message.guild || message.author?.bot || isExempt(message)) return false;
    const spam = trackMessage(message, now);
    if (!spam) return false;
    // Only looked up for a flood, not for every message: the trusted (Anti-Nuke trusted list) are left alone.
    if (await canLiftHardBan(message.guild, message.author.id).catch(() => false)) return false;

    const byChannel = new Map();
    for (const entry of spam.entries) {
        if (!byChannel.has(entry.channelId)) byChannel.set(entry.channelId, []);
        byChannel.get(entry.channelId).push(entry.id);
    }
    for (const [channelId, ids] of byChannel) {
        const channel = message.guild.channels.cache.get(channelId) || message.channel;
        if (ids.length > 1 && channel.bulkDelete) await channel.bulkDelete(ids, true).catch(() => {});
        else await channel.messages?.delete?.(ids[0]).catch(() => {});
    }

    const reason = SPAM_REASONS[spam.kind];
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    // The timeout first: a warning that reaches 3 / 6 / 9 sets its own (longer) timeout over it.
    const timedOut = await timeoutSpammer(message, member, reason);
    const punishment = ['مسح الرسائل'];
    const me = message.guild.members?.me;
    if (member && me) {
        try {
            const result = await warn({ guild: message.guild, member, moderator: me, reason });
            punishment.push(`وارن (${result.totalCount})`);
            await sendModerationActionLog(message.guild, { action: 'warn', targetUser: message.author, moderatorUser: message.client.user, reason, warnings: result.totalCount, channel: message.channel });
        } catch (error) {
            logger.warn(`Spam warning failed for ${message.author.id}: ${error.message}`);
        }
    }
    if (timedOut) punishment.push(`تايم ${SPAM_TIMEOUT_MS / 60_000} دقايق`);

    try {
        const lines = [
            `👤 **العضو:** <@${message.author.id}> (${message.author.tag || message.author.id})`,
            `💬 **الروم:** <#${message.channel.id}>`,
            `🚫 **المخالفة:** ${reason}`,
            `⚖️ **الإجراء:** ${punishment.join(' + ')}`,
            `🤖 **المنفذ:** <@${message.client?.user?.id}> (بوت)`,
        ];
        await postAuditRoom(message.guild, 'automode', {
            color: 0xe74c3c,
            title: '🛡️ أوتومود — مكافحة السبام (Anti-Spam)',
            description: lines.join('\n'),
            timestamp: new Date().toISOString(),
        });
    } catch (auditErr) {
        logger.debug('Failed to post spam action to automode room:', auditErr);
    }

    await notice(message.channel, message.author.id, `${reason} ・ ${punishment.join(' + ')}`);
    // #bot-updates: one summary per 10 minutes (botUpdatesRoom.js), never throws.
    reportAntiSpam(message, { reason, punishment: punishment.join(' + ') });
    return true;
}

/** Staff may mention the owner as much as they like, in every server (report #196). */
async function isStaffMentioner(message) {
    const member = message.member || await message.guild.members?.fetch?.(message.author.id).catch(() => null);
    if (await isStaffMember(member).catch(() => false)) return true;
    return canLiftHardBan(message.guild, message.author.id).catch(() => false);
}

/** How many times the message mentions an owner (the server owners and the server's owner), typed in it. */
export function countOwnerMentions(message) {
    const owners = new Set([OWNER_PING_ID, ...SERVER_OWNER_IDS, message.guild?.ownerId].filter(Boolean).map(String));
    let count = 0;
    for (const [, userId] of String(message.content || '').matchAll(USER_MENTION)) if (owners.has(userId)) count += 1;
    return count;
}

/**
 * Counts each member's owner mentions, in one message or several in a row: OWNER_MENTION_LIMIT are allowed, the
 * message that goes past it is deleted and warned (and the count starts again).
 */
export async function handleOwnerMentionSpam(message, { now = Date.now() } = {}) {
    if (!message.guild || message.author?.bot || isServerOwner(message.author?.id) || isGuildOwner(message)) return false;
    const key = `${message.guild.id}:${message.author.id}`;
    // Only a mention typed in the message counts: a reply to the owner (even with its ping on) is not one.
    const mentions = countOwnerMentions(message);
    if (!mentions) {
        ownerMentions.delete(key);
        return false;
    }
    if (await isStaffMentioner(message)) return false;

    const previous = ownerMentions.get(key);
    const count = (previous && now - previous.at < OWNER_MENTION_WINDOW_MS ? previous.count : 0) + mentions;
    if (count <= OWNER_MENTION_LIMIT) {
        ownerMentions.set(key, { count, at: now });
        return false;
    }
    ownerMentions.delete(key);

    await message.delete().catch(() => {});
    const reason = `منشن صاحب السيرفر أكتر من ${OWNER_MENTION_LIMIT} مرات`;
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const me = message.guild.members.me;
    let punishment = '🗑️ الرسالة اتمسحت';
    if (member && me) {
        try {
            const result = await issueWarning({ guild: message.guild, member, moderator: me, reason });
            punishment = `⚠️ وارن (${result.totalCount})${result.timeoutApplied ? ' + تايم' : ''}`;
            await sendModerationActionLog(message.guild, { action: 'warn', targetUser: message.author, moderatorUser: message.client.user, reason, warnings: result.totalCount, channel: message.channel });
        } catch (error) {
            logger.warn(`Owner mention warning failed for ${message.author.id}: ${error.message}`);
        }
    }

    try {
        const lines = [
            `👤 **العضو:** <@${message.author.id}> (${message.author.tag || message.author.id})`,
            `💬 **الروم:** <#${message.channel.id}>`,
            `🚫 **المخالفة:** ${reason}`,
            `⚖️ **الإجراء:** ${punishment}`,
            `🤖 **المنفذ:** <@${message.client?.user?.id}> (بوت)`,
        ];
        await postAuditRoom(message.guild, 'automode', {
            color: 0xFEE75C,
            title: '🛡️ أوتومود — منشن صاحب السيرفر',
            description: lines.join('\n'),
            timestamp: new Date().toISOString(),
        });
    } catch (auditErr) {
        logger.debug('Failed to post owner mention action to automode room:', auditErr);
    }

    await notice(message.channel, message.author.id, `متمنشنش صاحب السيرفر كتير ・ ${punishment}`);
    reportOwnerMention(message, { punishment });
    return true;
}
