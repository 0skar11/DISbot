import { Events } from 'discord.js';
import { registerRoleBoardReactions } from '../services/roleBoardService.js';

// GH #326: emoji reaction-role boards read reactions from raw gateway packets (so they keep working after a
// restart without message partials). This only starts listening; it never posts or edits anything.
export default {
  name: Events.ClientReady,
  once: true,

  async execute(readyClient, client) {
    registerRoleBoardReactions(client || readyClient);
  },
};
