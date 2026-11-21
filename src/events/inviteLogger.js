import { Events } from 'discord.js';
import { handleMemberJoinInvite } from '../services/inviteTrackerService.js';

export default {
  name: Events.GuildMemberAdd,
  once: false,
  async execute(member) {
    // Log only: posts the "📨 عضو دخل" embed to the invites room. Rewards are paid by CC-bot.
    if (member.user?.bot) return;
    await handleMemberJoinInvite(member);
  },
};
