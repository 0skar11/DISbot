import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { CLEANUP_VERSION, UNTRUST_USER_IDS, UNTRUST_ROLE_IDS } from '../config/security.js';

const VERSION_KEY = 'securityCleanupVersion';

/** Removes the listed members and roles from the trusted list. Returns `{ users, roles }` removed. */
export async function untrust(client, guildId, config, { userIds = UNTRUST_USER_IDS, roleIds = UNTRUST_ROLE_IDS } = {}) {
    const users = Array.isArray(config?.antiNukeTrustedUsers) ? config.antiNukeTrustedUsers : [];
    const roles = Array.isArray(config?.antiNukeTrustedRoles) ? config.antiNukeTrustedRoles : [];
    const keptUsers = users.filter((id) => !userIds.includes(id));
    const keptRoles = roles.filter((id) => !roleIds.includes(id));
    const removed = { users: users.length - keptUsers.length, roles: roles.length - keptRoles.length };
    if (removed.users || removed.roles) {
        await updateGuildConfig(client, guildId, { antiNukeTrustedUsers: keptUsers, antiNukeTrustedRoles: keptRoles });
    }
    return removed;
}

/** Runs the cleanup once per CLEANUP_VERSION for the server. Invites must never be deleted (owner request). */
export async function runSecurityCleanup(client, guild) {
    const config = await getGuildConfig(client, guild.id).catch(() => null);
    if (!config || config[VERSION_KEY] === CLEANUP_VERSION) return { skipped: true };
    const removed = await untrust(client, guild.id, config);
    await updateGuildConfig(client, guild.id, { [VERSION_KEY]: CLEANUP_VERSION });
    return { skipped: false, ...removed };
}
