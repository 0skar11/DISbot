import { Events } from 'discord.js';
import { markLeft } from '../services/inviteRewardService.js';

// An invited member who leaves before the invite reward is paid doesn't count for their inviter.
export default {
  name: Events.GuildMemberRemove,
  once: false,
  async execute(member) {
    // Disabled: invite rewards moved to CC-bot
  },
};
