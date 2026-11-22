// botUpdatesRoom.js — the staff-only #bot-updates channel in the Logs category (placed at the very bottom).
// Logs every automated action, operational update, member communications (e.g. birthday DMs sent),
// and activity statistics.

import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { isProtectedGuild } from '../config/homeGuild.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { findBoardMessage, rememberBoardMessage } from '../utils/boardMessage.js';
import { bugsReportsStaffRoles } from './bugsReportsRoom.js';
import { proofChannelFor } from './moderation/moderationActionLogService.js';
import { AUDIT_LOG_CATEGORY_ID } from './auditLogChannelsService.js';
import { findRadarCategories } from './logging/auditRooms.js';
import { REPLIED_USERS_DB_KEY } from './birthdayGreetingService.js';
import { logger } from '../utils/logger.js';

export const BOT_UPDATES_CHANNEL_NAME = 'bot-updates';
const CONFIG_KEY = 'botUpdatesChannelId';
const BOARD_KEY = 'botUpdatesGuide';
const FOOTER = 'Bot Updates • تحديثات وعمليات البوت';

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

/**
 * Finds or creates the #bot-updates room in the Logs category and places it at the very bottom.
 */
export async function ensureBotUpdatesRoom(client, guild) {
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

export function buildBotUpdatesGuide() {
  return {
    color: 0x3498db,
    title: '🤖 تحديثات وعمليات البوت | Bot Activity & Updates',
    description: [
      'الروم ده مخصص لتسجيل كل التحديثات والعمليات المهمة اللي بينفذها البوت تلقائياً.',
      'This room logs all major automated updates, operations, and member communications.',
    ].join('\n'),
    fields: [
      {
        name: '📋 العمليات المسجلة | Logged Operations',
        value: [
          '• 📬 **رسائل الخاص (DMs):** تسجيل عدد الأعضاء والرسائل المرسلة في الخاص (مثل تهاني عيد الميلاد والتنبيهات).',
          '• 🛡️ **تحديثات الرتب والإدارة:** رصد صلاحيات الإدارة والرتب حتى سايكو.',
          '• 🚀 **إقلاع البوت والأنظمة:** حالة الاتصال بقاعدة البيانات ومزامنة الخدمات.',
          '• 📊 **إحصائيات النشاط:** تقرير دوري بعدد العمليات والأوامر المنفذة.',
        ].join('\n'),
      },
    ],
    footer: { text: FOOTER },
  };
}

/** Posts the explanation once and pins it; later runs edit the same message. */
export async function publishBotUpdatesGuide(client, channel) {
  const payload = { embeds: [buildBotUpdatesGuide()], allowedMentions: { parse: [] } };
  const isGuide = (message) => message.author?.id === client.user.id && message.embeds?.[0]?.footer?.text === FOOTER;
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

export const ACTIVITY_STATS_KEY = 'bot:activity:stats';

export async function getBotActivityStats(client) {
  const defaultStats = {
    dmsSent: 0,
    birthdayDmsSent: 0,
    actionsPerformed: 0,
    commandsExecuted: 0,
    lastUpdated: Date.now(),
  };
  if (!client?.db?.get) return defaultStats;
  const stored = await client.db.get(ACTIVITY_STATS_KEY, null).catch(() => null);
  return stored && typeof stored === 'object' ? { ...defaultStats, ...stored } : defaultStats;
}

export async function recordBotAction(client, type, count = 1) {
  if (!client?.db?.get || !client?.db?.set) return;
  try {
    const stats = await getBotActivityStats(client);
    if (type === 'dm') {
      stats.dmsSent = (stats.dmsSent || 0) + count;
    } else if (type === 'birthday_dm') {
      stats.dmsSent = (stats.dmsSent || 0) + count;
      stats.birthdayDmsSent = (stats.birthdayDmsSent || 0) + count;
    } else if (type === 'action') {
      stats.actionsPerformed = (stats.actionsPerformed || 0) + count;
    } else if (type === 'command') {
      stats.commandsExecuted = (stats.commandsExecuted || 0) + count;
    }
    stats.lastUpdated = Date.now();
    await client.db.set(ACTIVITY_STATS_KEY, stats).catch(() => {});
    return stats;
  } catch (err) {
    logger.warn(`Could not record bot activity: ${err.message}`);
  }
}

/**
 * Logs a formatted embed update to #bot-updates in protected guilds.
 */
export async function logBotUpdate(client, { guildId = null, title, description, fields = [], color = 0x3498db }) {
  const guilds = guildId
    ? [client.guilds?.cache?.get(guildId)].filter(Boolean)
    : [...(client.guilds?.cache?.values() || [])].filter((g) => isProtectedGuild(g.id));

  const results = [];
  const embed = {
    color,
    title: String(title || 'تحديث البوت').slice(0, 256),
    description: description ? String(description).slice(0, 4000) : undefined,
    fields: fields.map((f) => ({
      name: String(f.name || '').slice(0, 256),
      value: String(f.value || '').slice(0, 1024),
      inline: Boolean(f.inline),
    })),
    timestamp: new Date().toISOString(),
    footer: { text: FOOTER },
  };

  for (const guild of guilds) {
    try {
      const { channel } = await ensureBotUpdatesRoom(client, guild);
      if (channel?.send) {
        const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        results.push({ guildId: guild.id, messageId: message.id, ok: true });
      }
    } catch (error) {
      logger.warn(`Failed to post bot update in ${guild.name}: ${error.message}`);
      results.push({ guildId: guild.id, error: error.message, ok: false });
    }
  }
  return results;
}

/**
 * Posts a formatted activity summary card to #bot-updates.
 */
export async function postActivitySummary(client, guild = null) {
  const stats = await getBotActivityStats(client);
  const repliedList = (await client.db?.get?.(REPLIED_USERS_DB_KEY, [])) || [];
  const repliedCount = Array.isArray(repliedList) ? repliedList.length : 0;

  const totalDms = Math.max(stats.dmsSent || 0, repliedCount);
  const birthdayDms = Math.max(stats.birthdayDmsSent || 0, repliedCount);

  return logBotUpdate(client, {
    guildId: guild?.id || null,
    title: '📊 ملخص نشاط وعمليات البوت | Activity Summary',
    description: 'تقرير دوري ومباشر عن العمليات التي نفذها البوت والأعضاء الذين تم التواصل معهم:',
    fields: [
      {
        name: '📬 رسائل الخاص (DMs)',
        value: `• إجمالي رسائل الخاص: **${totalDms}**\n• رسائل تهنئة عيد الميلاد: **${birthdayDms}**`,
        inline: true,
      },
      {
        name: '⚙️ العمليات والأوامر',
        value: `• الأوامر المنفذة: **${stats.commandsExecuted || 0}**\n• الإجراءات المنفذة: **${stats.actionsPerformed || 0}**`,
        inline: true,
      },
      {
        name: '🌐 حالة النظام',
        value: `• السيرفرات: **${client.guilds?.cache?.size || 0}**\n• الأوامر المحملة: **${client.commands?.size || 0}**`,
        inline: true,
      },
    ],
    color: 0x2ecc71,
  });
}

/**
 * Startup hook: ensures the #bot-updates channel is set up at the bottom of the Logs category,
 * publishes the guide, and logs startup status.
 */
export async function startBotUpdates(client) {
  const results = [];
  for (const guild of client.guilds.cache.values()) {
    if (!isProtectedGuild(guild.id)) continue;
    try {
      const { channel, created } = await ensureBotUpdatesRoom(client, guild);
      const guide = await publishBotUpdatesGuide(client, channel);
      results.push({ guildId: guild.id, channelId: channel.id, status: `${created ? 'created' : 'found'}, guide ${guide}` });
    } catch (error) {
      logger.error(`Failed to set up #bot-updates in ${guild.name}:`, error);
      results.push({ guildId: guild.id, channelId: null, status: 'failed' });
    }
  }
  return results;
}
