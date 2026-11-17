import { escapeMarkdown } from 'discord.js';
import { HOME_GUILD_ID } from './homeGuild.js';

export const CHAOS_GUILD_ID = HOME_GUILD_ID;
export const ZENITH_GUILD_ID = '1569932761471524874';

export const DEFAULT_WELCOME_CHANNELS = Object.freeze({
  [CHAOS_GUILD_ID]: '1547305745417113700',
  [ZENITH_GUILD_ID]: '1570728122259611779',
});

const snowflake = /^\d{17,20}$/u;

function pairs(env = process.env) {
  return String(env.WELCOME_CHANNEL_IDS ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => pair.split(':').map((part) => part.trim()));
}

export function welcomeChannelMap(env = process.env) {
  const map = new Map(Object.entries(DEFAULT_WELCOME_CHANNELS));
  for (const [guildId, channelId] of pairs(env)) {
    map.set(guildId, channelId?.toLowerCase() === 'off' ? 'off' : channelId);
  }
  return map;
}

export const welcomeChannelSetting = (guildId, env = process.env) =>
  welcomeChannelMap(env).get(String(guildId ?? '')) ?? null;

export function escapeGuildName(name) {
  return escapeMarkdown(String(name ?? ''), { maskedLink: true }).replace(/[<@]/gu, (char) => `\\${char}`);
}
