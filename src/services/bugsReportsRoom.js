// bugsReportsRoom.js — the private #bugs-reports room (owner's request), in our server and in Zenith.
//
// The staff post the bot's problems there: a bug, a wrong action, a missing log. The room is hidden from
// @everyone; the staff roles (the staff roles of staffRoleHierarchyService.js and every role with a dangerous
// permission, Manage Messages included: staffAndDangerousRoles) can see it, write and attach files; the bot can
// post and pin. It is made at startup only when missing (the saved ID, then the name, are looked up first, so
// it is never made twice), in the category of the staff log rooms when there is one. The bot posts one short
// Arabic + English explanation there, pins it, and edits that same message on later startups.
// Every message posted there becomes a numbered report with a GitHub issue (bugsReportsInbox.js).

import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { isProtectedGuild } from '../config/homeGuild.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { findBoardMessage, rememberBoardMessage } from '../utils/boardMessage.js';
import { staffAndDangerousRoles } from './moderation/rejoinRestore.js';
import { proofChannelFor } from './moderation/moderationActionLogService.js';
import { AUDIT_LOG_CATEGORY_ID } from './auditLogChannelsService.js';
import { findRadarCategories } from './logging/auditRooms.js';
import { logger } from '../utils/logger.js';

export const BUGS_REPORTS_CHANNEL_NAME = 'bugs-reports';
const CONFIG_KEY = 'bugsReportsChannelId';
const BOARD_KEY = 'bugsReportsGuide';
const FOOTER = 'Bug reports • بلاغات المشاكل';
// Discord caps the permission overwrites of a channel; the highest staff roles come first.
const MAX_STAFF_ROLES = 90;

export const STAFF_ALLOW = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
];
export const BOT_ALLOW = [...STAFF_ALLOW, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.PinMessages];

/** The staff roles that see the room, highest first. */
export async function bugsReportsStaffRoles(guild) {
    const roles = [...guild.roles.cache.values()].filter((role) => role.id !== guild.id && !role.managed);
    const staff = await staffAndDangerousRoles(guild, roles);
    return staff.sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).slice(0, MAX_STAFF_ROLES);
}

/** Hidden from @everyone; the staff roles see, write and attach; the bot posts and pins. */
export function bugsReportsOverwrites(guild, botId, staffRoles) {
    return [
        { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        ...staffRoles.map((role) => ({ id: role.id, type: OverwriteType.Role, allow: STAFF_ALLOW })),
        { id: botId, type: OverwriteType.Member, allow: BOT_ALLOW },
    ];
}

/** The category of the staff log rooms: the moderation log room's, the Logs category, or a Radar category. */
function staffCategory(guild) {
    const proofRoom = guild.channels.cache.get(proofChannelFor(guild.id));
    const candidates = [proofRoom?.parentId, AUDIT_LOG_CATEGORY_ID, ...findRadarCategories(guild).map((category) => category.id)];
    for (const id of candidates) {
        const category = id ? guild.channels.cache.get(id) : null;
        if (category?.type === ChannelType.GuildCategory) return category;
    }
    return null;
}

// The rooms found or made this run, so each message is matched by ID without reading the config.
const knownRoomIds = new Set();

/** Whether the channel is the saved #bugs-reports room of its server (by ID, never by name alone). */
export async function isBugsReportsRoom(client, channel) {
    if (!channel?.id || !channel.guild?.id) return false;
    if (knownRoomIds.has(channel.id)) return true;
    if (channel.name !== BUGS_REPORTS_CHANNEL_NAME) return false;
    const config = await getGuildConfig(client, channel.guild.id).catch(() => null);
    if (config?.[CONFIG_KEY] !== channel.id) return false;
    knownRoomIds.add(channel.id);
    return true;
}

const isRoom = (channel) => channel?.type === ChannelType.GuildText && channel.name === BUGS_REPORTS_CHANNEL_NAME;

/** Finds the room (saved ID, then name) or makes it. Returns `{ channel, created }`. */
export async function ensureBugsReportsRoom(client, guild) {
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    const savedId = config?.[CONFIG_KEY] || null;
    let channel = savedId ? guild.channels.cache.get(savedId) || await guild.channels.fetch(savedId).catch(() => null) : null;
    if (channel && channel.type !== ChannelType.GuildText) channel = null;
    if (!channel) channel = [...guild.channels.cache.values()].find(isRoom) || null;

    let created = false;
    if (!channel) {
        const category = staffCategory(guild);
        channel = await guild.channels.create({
            name: BUGS_REPORTS_CHANNEL_NAME,
            type: ChannelType.GuildText,
            ...(category ? { parent: category.id } : {}),
            topic: '🐞 بلاغات مشاكل البوت للإدارة | Staff only: report bot problems here',
            permissionOverwrites: bugsReportsOverwrites(guild, client.user.id, await bugsReportsStaffRoles(guild)),
            reason: 'Bugs reports room (staff only)',
        });
        created = true;
        logger.info(`Created the bugs-reports room ${channel.id} in ${guild.name}`);
    }
    knownRoomIds.add(channel.id);
    if (savedId !== channel.id) await updateGuildConfig(client, guild.id, { [CONFIG_KEY]: channel.id }).catch(() => {});
    return { channel, created };
}

export function buildBugsReportsGuide() {
    return {
        color: 0xe67e22,
        title: '🐞 بلاغات مشاكل البوت | Bot bug reports',
        description: [
            'الروم ده للإدارة بس: لو البوت عمل حاجة غلط أو فيه حاجة مش شغالة، اكتبها هنا وهنتابعها.',
            'Staff only: if the bot did something wrong or something is broken, report it here.',
            '',
            '🔢 كل رسالة تتكتب هنا البوت بيحولها لبلاغ برقمه (🐞 بلاغ #1، #2، #3...) وبيمسح رسالتك الأصلية، والصور اللي بعتها بتتحط في البلاغ نفسه. البوت بيتابعه ولما يتحل بيقفله ويكتب هنا إنه اتحل.',
            'Every message posted here is turned into numbered report #N and your original message is removed (your files are re-attached to the report). The bot tracks it and marks it closed here once it is fixed.',
            'الرد على بلاغ = كلام عادي، مش بلاغ جديد. Replies to a report are just chat.',
        ].join('\n'),
        fields: [
            {
                name: '🔎 تبلّغ عن إيه؟ | What to report',
                value: [
                    '• البوت فيه مشكلة أو بيطلع خطأ — a bot bug or error',
                    '• أمر اتنفذ غلط أو على الشخص الغلط — a wrong action',
                    '• لوج ناقص أو مش ظاهر — a missing log',
                ].join('\n'),
            },
            {
                name: '📝 تكتب إزاي؟ | How to report',
                value: [
                    '1. اوصف المشكلة باختصار — describe the problem',
                    '2. الأمر اللي استخدمته (مثلاً `تايم @عضو 5m`) — the command you used',
                    '3. الروم اللي حصلت فيه — the channel',
                    '4. الوقت التقريبي — the time',
                    '5. صورة (سكرين شوت) لو تقدر — a screenshot if you can',
                ].join('\n'),
            },
        ],
        footer: { text: FOOTER },
    };
}

/** Posts the explanation once and pins it; later runs edit the same message. Returns 'sent' or 'updated'. */
export async function publishBugsReportsGuide(client, channel) {
    const payload = { embeds: [buildBugsReportsGuide()], allowedMentions: { parse: [] } };
    const isGuide = (message) => message.author?.id === client.user.id && message.embeds?.[0]?.footer?.text === FOOTER;
    // A failed lookup throws (never posts a second copy); the startup logs it and tries again next time.
    const existing = await findBoardMessage(channel, BOARD_KEY, isGuide);
    if (existing) {
        await existing.edit(payload);
        if (!existing.pinned) await existing.pin().catch(() => {});
        return 'updated';
    }
    const sent = await channel.send(payload);
    await rememberBoardMessage(channel, BOARD_KEY, sent.id);
    await sent.pin().catch((error) => logger.warn(`Could not pin the bugs-reports guide: ${error.message}`));
    return 'sent';
}

/** Startup: the room and its pinned explanation in our server and Zenith. Failures are logged, never thrown. */
export async function startBugsReports(client) {
    const results = [];
    for (const guild of client.guilds.cache.values()) {
        if (!isProtectedGuild(guild.id)) continue;
        try {
            const { channel, created } = await ensureBugsReportsRoom(client, guild);
            const guide = await publishBugsReportsGuide(client, channel);
            results.push({ guildId: guild.id, channelId: channel.id, status: `${created ? 'created' : 'found'}, guide ${guide}` });
        } catch (error) {
            logger.error(`Failed to set up the bugs-reports room in ${guild.name}:`, error);
            results.push({ guildId: guild.id, channelId: null, status: 'failed' });
        }
    }
    return results;
}
