// roleBoardService.js — emoji reaction-role boards (GH #326).
//
// A board is one bot message listing "emoji ┃ @role" lines, with the bot's own reaction for every line.
// Reacting gives the role, removing the reaction takes it back. The boards are configured in
// src/config/roleBoards.js and posted only by an owner (/publish-board role-boards); nothing is posted on
// startup. Stored per guild under `guild:<id>:role_boards` so a re-run edits the same message.
//
// Consistency rules:
//   • only roles that exist and that the bot may hand out are ever rendered (never "@unknown-role");
//   • every line has exactly one reaction and every reaction has a line: stray reactions are removed;
//   • when a board's role is deleted, its line and its reaction are removed and the message is re-rendered
//     (on the role delete event, or on the next reaction if the bot was offline);
//   • reactions are read from raw gateway packets, so boards keep working after a restart without
//     message partials.

import { PermissionFlagsBits, Routes } from 'discord.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { getRoleBoardsKey } from '../utils/database/keys.js';
import { hasDangerousPermissions } from './reactionRoleService.js';

/** Discord allows at most 20 different reactions on one message. */
export const ROLE_BOARD_MAX_ROLES = 20;

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';
const DEFAULT_COLOR = 0x5865f2;
const SNOWFLAKE = /^\d{17,20}$/;
const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_~]{2,32}):(\d{17,20})>$/;
const CUSTOM_EMOJI_ANYWHERE = /<a?:[A-Za-z0-9_~]{2,32}:\d{17,20}>/;
const EMOJI_PART = '(?:\\p{Extended_Pictographic}|\\p{Emoji_Presentation})(?:\\uFE0F|\\p{Emoji_Modifier})*';
const UNICODE_EMOJI_SOURCE = `(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${EMOJI_PART}(?:\\u200D${EMOJI_PART})*)`;
const UNICODE_EMOJI = new RegExp(`^${UNICODE_EMOJI_SOURCE}$`, 'u');
const UNICODE_EMOJI_ANYWHERE = new RegExp(UNICODE_EMOJI_SOURCE, 'u');
const ROLE_MENTION = /<@&(\d{17,20})>/;

const REACTION_PACKETS = new Set([
    'MESSAGE_REACTION_ADD',
    'MESSAGE_REACTION_REMOVE',
    'MESSAGE_REACTION_REMOVE_ALL',
    'MESSAGE_REACTION_REMOVE_EMOJI',
]);
const DELETE_PACKETS = new Set(['MESSAGE_DELETE', 'MESSAGE_DELETE_BULK']);

const CHANNEL_PERMISSIONS = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AddReactions', 'ReadMessageHistory', 'ManageMessages'];

/** Short Egyptian Arabic reasons for the owner's reply. */
export const SKIP_REASONS = {
    missing: 'الرول مش موجود في السيرفر',
    ambiguous: 'فيه أكتر من رول بنفس الاسم، ابعت الـ id',
    bad_emoji: 'الإيموجي مش صالح',
    emoji_unavailable: 'البوت مش شايف الإيموجي ده',
    react_failed: 'مقدرتش أحط الرياكشن بتاعه',
    everyone: 'مينفعش @everyone',
    managed: 'رول بوت أو integration',
    dangerous: 'الرول فيه صلاحيات ستاف',
    above_bot: 'الرول أعلى من رول البوت',
    duplicate_role: 'الرول متكرر',
    duplicate_emoji: 'الإيموجي متكرر',
    limit: `ديسكورد بيسمح بـ ${ROLE_BOARD_MAX_ROLES} رياكشن بس`,
};

// Emoji variation selector-16: '⚔' and '⚔ + VS16' are the same reaction to Discord.
const VARIATION_SELECTOR = String.fromCodePoint(0xfe0f);
const stripVariation = (text) => String(text ?? '').replaceAll(VARIATION_SELECTOR, '');

/** Parses a configured emoji: '🎮', '<:name:id>' or '<a:name:id>'. Returns null when it is not one emoji. */
export function parseEmoji(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;
    const custom = text.match(CUSTOM_EMOJI);
    if (custom) {
        const [, animated, name, id] = custom;
        return { key: id, id, identifier: `${animated ? 'a:' : ''}${name}:${id}`, text };
    }
    if (!UNICODE_EMOJI.test(text)) return null;
    return { key: stripVariation(text), id: null, identifier: encodeURIComponent(text), text };
}

/** The key a reaction's emoji ({ id, name } from Discord) is matched by. */
export function reactionEmojiKey(emoji) {
    if (!emoji) return '';
    return emoji.id ? String(emoji.id) : stripVariation(emoji.name);
}

const entryKey = (entry) => parseEmoji(entry?.emoji)?.key ?? '';

function normalizeRoleName(name) {
    return String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const rolesOf = (guild) => [...(guild?.roles?.cache?.values?.() ?? [])];

/** True once the guild's roles are known, so a missing role really means a deleted role. */
export function rolesCacheReady(guild) {
    return Boolean(guild && guild.available !== false && guild.roles?.cache?.has?.(guild.id));
}

/** Why the bot must not hand out `role` from a board, or null when it may. */
export function roleBoardRoleProblem(role, guild, botMember) {
    if (!role) return 'missing';
    if (role.id === guild?.id) return 'everyone';
    if (role.managed) return 'managed';
    if (hasDangerousPermissions(role) || role.permissions?.has?.(PermissionFlagsBits.MentionEveryone)) return 'dangerous';
    const top = botMember?.roles?.highest?.position;
    if (!Number.isFinite(top) || role.position >= top) return 'above_bot';
    return null;
}

function findRole(guild, raw) {
    if (raw.roleId) {
        const id = String(raw.roleId).trim();
        return { role: SNOWFLAKE.test(id) ? guild.roles.cache.get(id) || null : null };
    }
    const wanted = normalizeRoleName(raw.name);
    if (!wanted) return { role: null };
    const matches = rolesOf(guild).filter((role) => normalizeRoleName(role.name) === wanted);
    if (matches.length > 1) return { role: null, ambiguous: true };
    return { role: matches[0] || null };
}

/**
 * Turns configured lines ({ emoji, roleId } or { emoji, name }) into the lines the bot can really serve.
 * Returns { entries: [{ emoji, roleId, roleName }], skipped: [{ label, reason }] } in the configured order.
 */
export function resolveBoardEntries(guild, rawEntries, botMember, client = null) {
    const entries = [];
    const skipped = [];
    const seenRoles = new Set();
    const seenEmojis = new Set();

    for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
        if (!raw || typeof raw !== 'object') continue;
        let label = String(raw.name || raw.roleId || raw.emoji || '?');
        const skip = (reason) => skipped.push({ label, reason, emoji: raw.emoji ?? null });

        const emoji = parseEmoji(raw.emoji);
        const { role, ambiguous } = findRole(guild, raw);
        if (role) label = role.name;
        if (!role) { skip(ambiguous ? 'ambiguous' : 'missing'); continue; }
        if (!emoji) { skip('bad_emoji'); continue; }
        if (emoji.id && client?.emojis?.cache && !client.emojis.cache.has(emoji.id)) { skip('emoji_unavailable'); continue; }

        const problem = roleBoardRoleProblem(role, guild, botMember);
        if (problem) { skip(problem); continue; }
        if (seenRoles.has(role.id)) { skip('duplicate_role'); continue; }
        if (seenEmojis.has(emoji.key)) { skip('duplicate_emoji'); continue; }
        if (entries.length >= ROLE_BOARD_MAX_ROLES) { skip('limit'); continue; }

        seenRoles.add(role.id);
        seenEmojis.add(emoji.key);
        entries.push({ emoji: emoji.text, roleId: role.id, roleName: role.name });
    }

    return { entries, skipped };
}

/**
 * The board's embed as a plain object (src/utils/embeds.js strips emojis from builders, and the icons
 * are the point here). Only the given entries are listed, so a deleted role is never shown.
 */
export function buildRoleBoardEmbed(board, entries, guild) {
    const lines = (entries || []).map((entry) => `${entry.emoji} ┃ <@&${entry.roleId}>`);
    const list = lines.length ? lines.join('\n') : '_مفيش رولات على البورد دي دلوقتي._';
    const intro = String(board?.description || '').trim();
    const room = 4096 - list.length - DIVIDER.length - 2;
    const description = intro ? `${intro.slice(0, Math.max(0, room))}\n${DIVIDER}\n${list}` : list;

    const embed = {
        title: String(board?.title || 'Roles').slice(0, 256),
        description,
        color: Number.isInteger(board?.color) ? board.color : DEFAULT_COLOR,
        footer: { text: `${guild?.name || 'السيرفر'} • ${lines.length} رول` },
    };
    const icon = guild?.iconURL?.({ size: 256 });
    if (icon) embed.thumbnail = { url: icon };
    return embed;
}

/**
 * Reads "emoji … @role" pairs from an existing board message (this bot's or another bot's), one pair per
 * line, so the current roles and icons can be kept. Lines without both an emoji and a role mention are ignored.
 */
export function parseBoardMessageEntries(message) {
    const lines = [];
    const addText = (text) => { if (text) lines.push(...String(text).split('\n')); };
    addText(message?.content);
    for (const embed of message?.embeds || []) {
        addText(embed?.description);
        for (const field of embed?.fields || []) {
            const value = String(field?.value ?? '');
            if (value.includes('\n')) addText(value);
            else lines.push(`${field?.name ?? ''} ${value}`);
        }
    }

    const firstEmoji = (text) => {
        const custom = text.match(CUSTOM_EMOJI_ANYWHERE);
        const unicode = text.match(UNICODE_EMOJI_ANYWHERE);
        if (custom && (!unicode || custom.index <= unicode.index)) return custom[0];
        return unicode ? unicode[0] : null;
    };

    const entries = [];
    const seen = new Set();
    for (const line of lines) {
        const mention = line.match(ROLE_MENTION);
        if (!mention) continue;
        const roleId = mention[1];
        const emoji = firstEmoji(line.slice(0, mention.index)) || firstEmoji(line.slice(mention.index + mention[0].length));
        if (!emoji || seen.has(roleId)) continue;
        seen.add(roleId);
        entries.push({ emoji, roleId });
    }
    return entries;
}

/** Accepts a message link, "channelId-messageId", "channelId/messageId" or a bare message id. */
export function parseMessageReference(text) {
    const value = String(text ?? '').trim();
    const link = value.match(/discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})/i);
    if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] };
    const pair = value.match(/^(\d{17,20})[-/](\d{17,20})$/);
    if (pair) return { guildId: null, channelId: pair[1], messageId: pair[2] };
    if (SNOWFLAKE.test(value)) return { guildId: null, channelId: null, messageId: value };
    return null;
}

// ── storage ────────────────────────────────────────────────────────────────────────────────────────────

const boardCache = new WeakMap();

function cacheFor(client) {
    let cache = boardCache.get(client);
    if (!cache) { cache = new Map(); boardCache.set(client, cache); }
    return cache;
}

/** The guild's boards `{ <key>: board }`, read once per process and then kept in memory. */
export async function loadGuildBoards(client, guildId) {
    const cache = cacheFor(client);
    if (!cache.has(guildId)) {
        const pending = Promise.resolve(client.db?.get?.(getRoleBoardsKey(guildId), null)).then((raw) => {
            const boards = raw && typeof raw === 'object' && raw.boards && typeof raw.boards === 'object' ? raw.boards : {};
            for (const board of Object.values(boards)) {
                if (!Array.isArray(board.entries)) board.entries = [];
            }
            return boards;
        });
        cache.set(guildId, pending);
        pending.catch(() => { if (cache.get(guildId) === pending) cache.delete(guildId); });
    }
    return cache.get(guildId);
}

async function saveGuildBoards(client, guildId, boards) {
    let saved;
    try {
        saved = await client.db.set(getRoleBoardsKey(guildId), { boards });
    } catch (error) {
        cacheFor(client).delete(guildId);
        throw error;
    }
    if (saved === false) {
        cacheFor(client).delete(guildId);
        throw new Error('Failed to save the role boards');
    }
    cacheFor(client).set(guildId, Promise.resolve(boards));
}

export async function getBoardByMessage(client, guildId, messageId) {
    if (!guildId || !messageId) return null;
    const boards = await loadGuildBoards(client, guildId);
    return Object.values(boards).find((board) => board.messageId === messageId) || null;
}

const lockKey = (guildId) => `roleboards:${guildId}`;

// ── posting ────────────────────────────────────────────────────────────────────────────────────────────

/** Permission names the bot is missing to run a board in `channel`. */
export function missingBoardPermissions(channel, botMember) {
    const permissions = botMember ? channel?.permissionsFor?.(botMember) : null;
    const missing = CHANNEL_PERMISSIONS.filter((name) => !permissions?.has?.(PermissionFlagsBits[name]));
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) missing.push('ManageRoles');
    return missing;
}

async function fetchMessageOrNull(channel, messageId) {
    return channel.messages.fetch(messageId).catch((error) => {
        // Only a confirmed deleted message may be replaced; a network or permission error must not
        // make an existing board look absent (that would post a second copy).
        if (error?.code === 10008) return null;
        throw error;
    });
}

/** Adds the bot's reaction for every line (in order) and removes reactions that have no line. Returns the lines that failed. */
export async function syncBoardReactions(message, entries) {
    const wanted = new Set(entries.map(entryKey));
    const reactions = [...(message.reactions?.cache?.values?.() ?? [])];
    for (const reaction of reactions) {
        if (!wanted.has(reactionEmojiKey(reaction.emoji))) await reaction.remove().catch(() => {});
    }

    const failed = [];
    for (const entry of entries) {
        const key = entryKey(entry);
        const existing = reactions.find((reaction) => reactionEmojiKey(reaction.emoji) === key);
        if (existing?.me) continue;
        try {
            await message.react(entry.emoji);
        } catch (error) {
            logger.warn(`Role board: could not add reaction ${entry.emoji} on ${message.id}: ${error.message}`);
            failed.push(entry);
        }
    }
    return failed;
}

function storedBoard(board, channel, message, entries, previous, actorId) {
    const now = new Date().toISOString();
    return {
        key: board.key,
        title: board.title,
        description: board.description || '',
        color: Number.isInteger(board.color) ? board.color : DEFAULT_COLOR,
        channelId: channel.id,
        messageId: message.id,
        entries: entries.map(({ emoji, roleId }) => ({ emoji, roleId })),
        createdAt: previous?.messageId === message.id && previous?.createdAt ? previous.createdAt : now,
        updatedAt: now,
        updatedBy: actorId || null,
    };
}

/**
 * Posts `board` in `channel`, or edits the guild's existing board with the same key (moving it when the
 * channel changed). `entries` overrides the configured lines (used to copy an old board).
 * Returns { status: 'sent' | 'updated' | 'empty', key, channelId, messageId, url, entries, skipped }.
 * Throws when the bot lacks permissions or Discord fails; nothing is posted twice.
 */
export async function publishRoleBoard(client, { channel, board, entries: rawEntries = board?.roles, actorId = null }) {
    const guild = channel?.guild;
    if (!guild || !channel.isTextBased?.() || !channel.messages?.fetch) {
        throw new Error('The board channel must be a text channel in a server');
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const missing = missingBoardPermissions(channel, botMember);
    if (missing.length) {
        const error = new Error(`Missing permissions: ${missing.join(', ')}`);
        error.missingPermissions = missing;
        throw error;
    }

    const { entries, skipped } = resolveBoardEntries(guild, rawEntries, botMember, client);
    const base = { key: board.key, channelId: channel.id, skipped };
    if (!entries.length) return { ...base, status: 'empty', entries: [] };

    return Mutex.runExclusive(lockKey(guild.id), async () => {
        const boards = await loadGuildBoards(client, guild.id);
        const previous = boards[board.key] || null;

        let message = null;
        if (previous?.messageId) {
            const oldChannel = previous.channelId === channel.id
                ? channel
                : guild.channels.cache.get(previous.channelId) || await guild.channels.fetch(previous.channelId).catch(() => null);
            const oldMessage = oldChannel?.messages?.fetch ? await fetchMessageOrNull(oldChannel, previous.messageId) : null;
            if (oldMessage && previous.channelId === channel.id) message = oldMessage;
            else if (oldMessage) await oldMessage.delete().catch(() => {}); // the board moved to another channel
        }

        let status = 'updated';
        const embed = buildRoleBoardEmbed(board, entries, guild);
        if (message) {
            await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        } else {
            message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            status = 'sent';
        }
        boards[board.key] = storedBoard(board, channel, message, entries, previous, actorId);
        try {
            await saveGuildBoards(client, guild.id, boards);
        } catch (error) {
            // A new board that can't be saved would never give roles: take it down again.
            if (status === 'sent') await message.delete().catch(() => {});
            throw error;
        }

        const failed = await syncBoardReactions(message, entries);
        let kept = entries;
        if (failed.length) {
            kept = entries.filter((entry) => !failed.includes(entry));
            skipped.push(...failed.map((entry) => ({ label: entry.roleName, reason: 'react_failed', emoji: entry.emoji })));
            await message.edit({ embeds: [buildRoleBoardEmbed(board, kept, guild)], allowedMentions: { parse: [] } }).catch(() => {});
            boards[board.key] = storedBoard(board, channel, message, kept, previous, actorId);
            await saveGuildBoards(client, guild.id, boards);
        }

        logger.info(`Role board "${board.key}" ${status} in guild ${guild.id} channel ${channel.id} (${kept.length} roles, ${skipped.length} skipped)`);
        return { ...base, status, messageId: message.id, url: message.url, entries: kept };
    });
}

// ── keeping boards consistent ──────────────────────────────────────────────────────────────────────────

function editBoardMessage(client, guild, board) {
    return client.rest.patch(Routes.channelMessage(board.channelId, board.messageId), {
        body: { embeds: [buildRoleBoardEmbed(board, board.entries, guild)], allowed_mentions: { parse: [] } },
    });
}

/**
 * Removes the lines of `roleIds` (deleted roles) from every board of the guild: their reactions go,
 * the message is re-rendered and the board is saved. Returns how many lines were removed.
 */
export async function removeRolesFromBoards(client, guild, roleIds) {
    const gone = new Set((roleIds || []).map(String));
    if (!guild || !gone.size) return 0;
    const usesGoneRole = (boards) => Object.values(boards).some((board) => board.entries.some((entry) => gone.has(entry.roleId)));
    if (!usesGoneRole(await loadGuildBoards(client, guild.id))) return 0;

    return Mutex.runExclusive(lockKey(guild.id), async () => {
        const boards = await loadGuildBoards(client, guild.id);
        let removed = 0;
        for (const board of Object.values(boards)) {
            const dropped = board.entries.filter((entry) => gone.has(entry.roleId));
            if (!dropped.length) continue;
            board.entries = board.entries.filter((entry) => !gone.has(entry.roleId));
            board.updatedAt = new Date().toISOString();
            removed += dropped.length;
            for (const entry of dropped) {
                const identifier = parseEmoji(entry.emoji)?.identifier;
                if (identifier) {
                    await client.rest.delete(Routes.channelMessageReaction(board.channelId, board.messageId, identifier)).catch(() => {});
                }
            }
            await editBoardMessage(client, guild, board).catch((error) => {
                logger.warn(`Role board "${board.key}" in guild ${guild.id}: could not re-render after a role was deleted: ${error.message}`);
            });
        }
        if (removed) {
            await saveGuildBoards(client, guild.id, boards);
            logger.info(`Removed ${removed} deleted role(s) from the role boards of guild ${guild.id}`);
        }
        return removed;
    });
}

async function forgetDeletedBoards(client, guildId, messageIds) {
    const ids = new Set(messageIds || []);
    if (!Object.values(await loadGuildBoards(client, guildId)).some((board) => ids.has(board.messageId))) return 0;
    return Mutex.runExclusive(lockKey(guildId), async () => {
        const boards = await loadGuildBoards(client, guildId);
        let forgotten = 0;
        for (const [key, board] of Object.entries(boards)) {
            if (!ids.has(board.messageId)) continue;
            delete boards[key];
            forgotten += 1;
        }
        if (forgotten) {
            await saveGuildBoards(client, guildId, boards);
            logger.info(`Role board message deleted in guild ${guildId}; forgot ${forgotten} board(s)`);
        }
        return forgotten;
    });
}

const removeUserReaction = (client, data, userId) => {
    const identifier = data.emoji?.id
        ? `${data.emoji.animated ? 'a:' : ''}${data.emoji.name || '_'}:${data.emoji.id}`
        : encodeURIComponent(data.emoji?.name ?? '');
    return client.rest.delete(Routes.channelMessageUserReaction(data.channel_id, data.message_id, identifier, userId)).catch(() => {});
};

async function addOwnReactions(client, board, entries) {
    for (const entry of entries) {
        const identifier = parseEmoji(entry.emoji)?.identifier;
        if (identifier) await client.rest.put(Routes.channelMessageOwnReaction(board.channelId, board.messageId, identifier)).catch(() => {});
    }
}

async function fetchMember(guild, userId) {
    return guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
}

/**
 * Handles one raw gateway packet for the boards: reactions give and take roles, stray reactions are
 * removed, cleared reactions are put back and a deleted board message is forgotten.
 * Returns a short description of what was done (for tests and logs), or null when the packet is unrelated.
 */
export async function handleRoleBoardPacket(client, packet) {
    const type = packet?.t;
    const data = packet?.d;
    if (!data?.guild_id || !(REACTION_PACKETS.has(type) || DELETE_PACKETS.has(type))) return null;
    const guildId = data.guild_id;

    if (DELETE_PACKETS.has(type)) {
        const forgotten = await forgetDeletedBoards(client, guildId, type === 'MESSAGE_DELETE' ? [data.id] : data.ids);
        return forgotten ? { action: 'forgotten', count: forgotten } : null;
    }

    const board = await getBoardByMessage(client, guildId, data.message_id);
    if (!board) return null;
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return null;

    if (type === 'MESSAGE_REACTION_REMOVE_ALL') {
        await addOwnReactions(client, board, board.entries);
        return { action: 'reseeded', count: board.entries.length };
    }

    const key = reactionEmojiKey(data.emoji);
    const entry = board.entries.find((item) => entryKey(item) === key) || null;

    if (type === 'MESSAGE_REACTION_REMOVE_EMOJI') {
        if (!entry) return { action: 'ignored' };
        await addOwnReactions(client, board, [entry]);
        return { action: 'reseeded', count: 1 };
    }

    const userId = data.user_id;
    const botId = client.user?.id;
    const adding = type === 'MESSAGE_REACTION_ADD';

    if (userId === botId) {
        // Someone removed the bot's own reaction: put it back so members can still click the line.
        if (!adding && entry && guild.roles.cache.get(entry.roleId)) {
            await addOwnReactions(client, board, [entry]);
            return { action: 'reseeded', count: 1 };
        }
        return { action: 'ignored' };
    }

    if (!entry) {
        if (adding) {
            await removeUserReaction(client, data, userId);
            return { action: 'stray_removed' };
        }
        return { action: 'ignored' };
    }

    const role = guild.roles.cache.get(entry.roleId);
    if (!role) {
        if (rolesCacheReady(guild)) await removeRolesFromBoards(client, guild, [entry.roleId]);
        return { action: 'pruned', roleId: entry.roleId };
    }

    if (adding && data.member?.user?.bot) {
        await removeUserReaction(client, data, userId);
        return { action: 'bot_ignored' };
    }

    const botMember = guild.members.me || null;
    const problem = roleBoardRoleProblem(role, guild, botMember);
    if (problem) {
        logger.warn(`Role board "${board.key}" in guild ${guildId}: not handing out ${role.name} (${problem})`);
        if (adding) await removeUserReaction(client, data, userId);
        return { action: 'blocked', reason: problem };
    }

    // One member at a time, so a quick add+remove can't finish in the wrong order.
    return Mutex.runExclusive(`roleboard:${guildId}:${userId}`, async () => {
        const member = await fetchMember(guild, userId);
        if (!member || member.user?.bot) return { action: 'ignored' };
        const reason = `Role board: ${board.key}`;
        try {
            if (adding) {
                if (member.roles.cache.has(role.id)) return { action: 'unchanged' };
                await member.roles.add(role, reason);
                return { action: 'added', roleId: role.id };
            }
            if (!member.roles.cache.has(role.id)) return { action: 'unchanged' };
            await member.roles.remove(role, reason);
            return { action: 'removed', roleId: role.id };
        } catch (error) {
            logger.warn(`Role board "${board.key}" in guild ${guildId}: could not ${adding ? 'add' : 'remove'} ${role.name} for ${userId}: ${error.message}`);
            // Keep what members see true: no reaction without the role.
            if (adding) await removeUserReaction(client, data, userId);
            return { action: 'failed' };
        }
    });
}

const registeredClients = new WeakSet();

/** Listens to raw reaction/delete packets for the boards. Safe to call more than once. */
export function registerRoleBoardReactions(client) {
    if (registeredClients.has(client)) return false;
    registeredClients.add(client);
    client.on('raw', (packet) => {
        if (!REACTION_PACKETS.has(packet?.t) && !DELETE_PACKETS.has(packet?.t)) return;
        handleRoleBoardPacket(client, packet).catch((error) => {
            logger.warn(`Role board packet ${packet.t} failed: ${error.message}`);
        });
    });
    return true;
}
