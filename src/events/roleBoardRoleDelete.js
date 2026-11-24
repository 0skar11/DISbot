import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { removeRolesFromBoards } from '../services/roleBoardService.js';
import { getAllReactionRoleMessages, pruneMissingPanelRoles } from '../services/reactionRoleService.js';
import { rebuildLivePanelMessage } from '../commands/Reaction_roles/reactroles.js';

// GH #326: a deleted role leaves every role board and select-menu panel right away (its line, its reaction
// or menu option), so nothing shows "@unknown-role" and no reaction points at a role that is gone.
export default {
  name: Events.GuildRoleDelete,
  once: false,

  async execute(role, client) {
    const guild = role?.guild;
    if (!guild) return;
    const botClient = client || role.client;

    try {
      await removeRolesFromBoards(botClient, guild, [role.id]);
    } catch (error) {
      logger.warn(`Could not remove deleted role ${role.id} from the role boards of guild ${guild.id}: ${error.message}`);
    }

    try {
      const panels = await getAllReactionRoleMessages(botClient, guild.id);
      for (const panel of panels) {
        if (!Array.isArray(panel.roles) || !panel.roles.includes(role.id)) continue;
        if ((await pruneMissingPanelRoles(botClient, guild, panel)).length) {
          await rebuildLivePanelMessage(guild, panel);
        }
      }
    } catch (error) {
      logger.warn(`Could not remove deleted role ${role.id} from the reaction role panels of guild ${guild.id}: ${error.message}`);
    }
  },
};
