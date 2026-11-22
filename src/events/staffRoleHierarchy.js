import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import {
  rememberStaffRoles, refreshStaffPermissionBoard, demoteAdministratorsBelowAdmin, removeMentionEveryoneFromStaffRoles,
  describeMentionEveryoneHolders,
} from '../services/staffRoleHierarchyService.js';

export default {
  name: Events.ClientReady,
  once: true,

  // The bot never creates, edits, moves or deletes a role here: it only finds the staff roles for the board.
  async execute(client) {
    let found = 0;
    const boardResults = [];

    for (const guild of client.guilds.cache.values()) {
      // The permission board is edited to match the roles. The bot never posts there on its own,
      // except once per BOARD_RESET_VERSION, when it clears the channel and posts the board fresh.
      try {
        found += (await rememberStaffRoles(guild)).found;
      } catch (error) {
        logger.error(`Failed to find the staff roles in ${guild.name}:`, error);
      }
      // Reports #208 & #302: Administrator taken off roles across all servers and granted all other permissions.
      try {
        const demoted = await demoteAdministratorsBelowAdmin(guild);
        if (demoted.status === 'done' && (demoted.changed.length || demoted.failed.length)) {
          startupLog(`Administrator taken off in ${guild.name}: ${demoted.changed.join(', ') || 'none'}${demoted.failed.length ? ` (failed: ${demoted.failed.join(', ')})` : ''}`);
        }
      } catch (error) {
        logger.error(`Failed to take Administrator off roles in ${guild.name}:`, error);
      }
      // GH #320: no staff role may mention @everyone / @here, in every server (the trusted roles keep it).
      try {
        const stripped = await removeMentionEveryoneFromStaffRoles(guild);
        if (stripped.changed.length || stripped.failed.length) {
          startupLog(`Mention Everyone taken off in ${guild.name}: ${stripped.changed.join(', ') || 'none'}${stripped.failed.length ? ` (failed: ${stripped.failed.join(', ')})` : ''}`);
        }
        // For the owner to check: every role that can still ping @everyone, and why (a log only, nothing on Discord).
        logger.info(describeMentionEveryoneHolders(guild, stripped.kept));
      } catch (error) {
        logger.error(`Failed to take Mention Everyone off staff roles in ${guild.name}:`, error);
      }
      try {
        const board = await refreshStaffPermissionBoard(guild);
        boardResults.push(board.status === 'sent' ? `${board.status} (cleared ${board.deleted})` : board.status);
      } catch (error) {
        logger.warn(`Permission board not refreshed in ${guild.name}: ${error.message}`);
      }
    }

    startupLog(`Staff roles: found ${found}, permission board ${boardResults.join(', ') || 'skipped'}`);
  },
};
