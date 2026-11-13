// auditRooms.js — Zenith Radar audit log routing service.
// Auto-detects and resolves audit rooms in the "Radar" category for message, channels,
// timeout, ban, voice, join, invites, roles, automode.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../config/guildConfig.js';
import { logger } from '../../utils/logger.js';

export const ROOM_KEYS = [
  'message',
  'channels',
  'timeout',
  'ban',
  'voice',
  'join',
  'invites',
  'roles',
  'automode',
];

export const AUDIT_LOG_SETTINGS = { auditRetryMs: 1_500 };

// guildId -> Map<key, channelId>
const guildRoomCache = new Map();
// Set<"guildId:key">
const warnedMissingRooms = new Set();

/** Normalizes room names for loose matching: lowercase, strip punctuation, dots, spaces. */
export function normalizeRoomName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[\s\.\·\•\-_/\\|,;:!?~`'"()[\]{}<>@#$%^&*+=]+/g, '');
}

/** Matches a channel name to a room key using loose matching. */
export function matchesRoomKey(channelName, key) {
  const norm = normalizeRoomName(channelName);
  if (!norm) return false;

  switch (key) {
    case 'message':
      return norm.includes('message');
    case 'channels':
      return norm.includes('channel');
    case 'timeout':
      return norm.includes('timeout');
    case 'ban':
      return norm.includes('ban') || norm.includes('kick');
    case 'voice':
      return norm.includes('voice');
    case 'join':
      return norm.includes('join') || norm.includes('leave');
    case 'invites':
      return norm.includes('invite');
    case 'roles':
      return norm.includes('role');
    case 'automode':
      return norm.includes('automod') || norm.includes('automode');
    default:
      return norm === normalizeRoomName(key);
  }
}

/** Finds categories containing "radar" (case-insensitive) in the guild. */
export function findRadarCategories(guild) {
  if (!guild?.channels?.cache) return [];
  return [...guild.channels.cache.values()].filter((c) => {
    const isCategory = c.type === ChannelType.GuildCategory || c.type === 4;
    return isCategory && c.name?.toLowerCase().includes('radar');
  });
}

/** Auto-detects room channel IDs inside any radar category. */
export function detectAuditRooms(guild) {
  const radarCategories = findRadarCategories(guild);
  if (!radarCategories.length) return {};

  const radarCategoryIds = new Set(radarCategories.map((c) => c.id));
  const detected = {};

  const candidates = [...guild.channels.cache.values()].filter((c) => {
    const isText = c.type === ChannelType.GuildText || c.isTextBased?.() || c.type === 0;
    return radarCategoryIds.has(c.parentId) && isText;
  });

  for (const key of ROOM_KEYS) {
    const channel = candidates.find((c) => matchesRoomKey(c.name, key));
    if (channel) {
      detected[key] = channel.id;
    }
  }

  return detected;
}

/** Parses AUDIT_CHANNELS_JSON env override: {"<guildId>":{"<key>":"<channelId>"}} */
export function getEnvAuditChannels(guildId) {
  if (!process.env.AUDIT_CHANNELS_JSON) return null;
  try {
    const parsed = JSON.parse(process.env.AUDIT_CHANNELS_JSON);
    return parsed?.[guildId] || null;
  } catch (error) {
    logger.warn('Failed to parse AUDIT_CHANNELS_JSON env variable:', error);
    return null;
  }
}

/** Resolves the channel ID for a given room key in a guild. */
export async function resolveAuditRoomId(guild, key) {
  if (!guild || !key) return null;

  // 1. Env override
  const envChannels = getEnvAuditChannels(guild.id);
  if (envChannels?.[key]) {
    return envChannels[key];
  }

  // 2. Config auditChannels (set by hand)
  const config = await getGuildConfig(guild.client, guild.id).catch(() => null);
  if (config?.auditChannels?.[key]) {
    return config.auditChannels[key];
  }

  // 3. In-memory cache
  const cache = guildRoomCache.get(guild.id);
  if (cache?.has(key)) {
    return cache.get(key);
  }

  // 4. Auto-detect inside any category whose name contains "radar"
  const detected = detectAuditRooms(guild);
  if (detected[key]) {
    // Cache per guild
    if (!guildRoomCache.has(guild.id)) {
      guildRoomCache.set(guild.id, new Map());
    }
    for (const [k, id] of Object.entries(detected)) {
      guildRoomCache.get(guild.id).set(k, id);
    }

    // Persist into config.auditChannels without overwriting manual IDs
    const existing = config?.auditChannels || {};
    const toPersist = {};
    for (const [k, id] of Object.entries(detected)) {
      if (!existing[k] && id) {
        toPersist[k] = id;
      }
    }
    if (Object.keys(toPersist).length > 0) {
      await updateGuildConfig(guild.client, guild.id, {
        auditChannels: { ...existing, ...toPersist },
      }).catch((err) => logger.warn(`Failed to persist detected audit channels in ${guild.id}:`, err));
    }

    return detected[key];
  }

  return null;
}

/** Resolves the Discord channel object for a given room key. */
export async function resolveAuditRoom(guild, key) {
  if (!guild || !key) return null;
  const channelId = await resolveAuditRoomId(guild, key);
  if (!channelId) return null;

  const channel = guild.channels?.cache?.get?.(channelId)
    || (await guild.channels?.fetch?.(channelId).catch(() => null));

  return channel || null;
}

function warnMissingRoomOnce(guild, key) {
  const warnKey = `${guild?.id}:${key}`;
  if (!warnedMissingRooms.has(warnKey)) {
    warnedMissingRooms.add(warnKey);
    logger.warn(`Audit room "${key}" not found in ${guild?.name || guild?.id} (${guild?.id})`);
  }
}

/**
 * Posts an embed to the resolved audit room.
 * Checks text channel type and View/Send/Embed permissions.
 * Never throws. Sends with allowedMentions: { parse: [] }.
 * Logs a warning once per missing room.
 */
export async function postAuditRoom(guild, key, embedOrPayload) {
  try {
    if (!guild || !key) return false;

    const channel = await resolveAuditRoom(guild, key);
    if (!channel || (!channel.isTextBased?.() && channel.type !== ChannelType.GuildText && channel.type !== 0)) {
      warnMissingRoomOnce(guild, key);
      return false;
    }

    const me = guild.members?.me || (await guild.members?.fetchMe?.().catch(() => null));
    if (channel.permissionsFor && me) {
      const permissions = channel.permissionsFor(me);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        logger.warn(`Missing View/Send/Embed permissions for audit room "${key}" in ${guild.name}`);
        return false;
      }
    }

    const payload = embedOrPayload?.embeds ? { ...embedOrPayload } : { embeds: [embedOrPayload] };
    payload.allowedMentions = { parse: [] };

    const sent = await channel.send(payload);
    return sent;
  } catch (error) {
    logger.warn(`Failed to post to audit room "${key}" in ${guild?.name}: ${error.message}`);
    return false;
  }
}

/** Look up an audit log entry with optional retry. */
export async function fetchAuditEntry(guild, type, targetId, filter = () => true, { retry = true } = {}) {
  const find = (entries) => entries.find((item) => (!targetId || item.target?.id === targetId)
    && Date.now() - (item.createdTimestamp || 0) < 15_000 && filter(item)) || null;

  const fetchLogs = async () => {
    try {
      const logs = await guild.fetchAuditLogs?.({ type, limit: 10 });
      return [...(logs?.entries?.values?.() || [])];
    } catch {
      return [];
    }
  };

  let entry = find(await fetchLogs());
  if (entry || !retry || !AUDIT_LOG_SETTINGS.auditRetryMs) return entry;
  await new Promise((resolve) => setTimeout(resolve, AUDIT_LOG_SETTINGS.auditRetryMs));
  return find(await fetchLogs());
}

/** Formats an executor user line with bot tag clearly labelled. */
export function formatExecutor(executor) {
  if (!executor) return 'غير معروف';
  const tag = executor.tag || executor.username || executor.id;
  const botLabel = executor.bot ? ' 🤖 (بوت)' : '';
  return `<@${executor.id}> (${tag} - ${executor.id})${botLabel}`;
}

/** Clears cached rooms and missing warnings (useful for tests). */
export function clearAuditRoomCache() {
  guildRoomCache.clear();
  warnedMissingRooms.clear();
}
