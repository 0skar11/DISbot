import { Events } from 'discord.js';
import { guardAdminRoleEdit } from '../services/moderation/staffRoleGuard.js';
import { logger } from '../utils/logger.js';

// An admin role edited by an untrusted member is put back as it was, and the editor is warned
// (services/moderation/staffRoleGuard.js, our server and Zenith).
export default {
  name: Events.GuildRoleUpdate,
  async execute(oldRole, newRole) {
    await guardAdminRoleEdit(oldRole, newRole).catch((error) => logger.error('Admin role edit guard failed:', error));
  },
};
