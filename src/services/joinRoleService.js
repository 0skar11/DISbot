// joinRoleService.js — Zenith: new members get the join role, everyone already in the server gets it once, and
// @everyone may add reactions. The one-time part is remembered in the guild config, so it never runs again.
import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

export const JOIN_ROLES = { '1569932761471524874': '1570728155612708895' };
const DONE_KEY = 'joinRoleBackfillDone';
export const BACKFILL_DELAY_MS = { value: 400 };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const joinRoleFor = (guildId) => JOIN_ROLES[String(guildId)] || null;

/** Gives the join role to a member who just joined. Bots are skipped. */
export async function giveJoinRole(member) {
    const roleId = joinRoleFor(member?.guild?.id);
    if (!roleId || member.user?.bot || member.roles.cache.has(roleId)) return false;
    await member.roles.add(roleId, 'Join role');
    return true;
}

/** Runs once per server: @everyone may react, every current human member gets the role. Never again after that. */
export async function runJoinRoleBackfill(client, guild) {
    const roleId = joinRoleFor(guild.id);
    if (!roleId) return { skipped: true };
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    if (!config || config[DONE_KEY]) return { skipped: true };

    const everyone = guild.roles.everyone;
    if (everyone && !everyone.permissions.has(PermissionFlagsBits.AddReactions)) {
        await everyone.setPermissions(everyone.permissions.add(PermissionFlagsBits.AddReactions), 'Everyone may react').catch((error) => logger.warn(`Reactions permission failed in ${guild.name}: ${error.message}`));
    }

    const members = await guild.members.fetch();
    let given = 0;
    for (const member of members.values()) {
        if (member.user.bot || member.roles.cache.has(roleId)) continue;
        if (await member.roles.add(roleId, 'Join role (one-time)').then(() => true).catch(() => false)) given += 1;
        if (BACKFILL_DELAY_MS.value) await sleep(BACKFILL_DELAY_MS.value);
    }
    await updateGuildConfig(client, guild.id, { [DONE_KEY]: true });
    return { skipped: false, given };
}
