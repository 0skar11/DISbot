import { Events } from 'discord.js';
import { handleMemberJoinInvite } from '../services/inviteTrackerService.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    // Disabled: invite tracking moved to CC-bot
  },
};
