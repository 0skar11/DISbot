import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { infoEmbed, successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { verifyUser } from '../../services/verificationService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { executeVerification } from '../../services/verification/directVerifyService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify a member or yourself')
        .addUserOption(option =>
            option
                .setName('member')
                .setDescription('The member to verify (verifiers/staff only)')
                .setRequired(false)
        ),

    async execute(interaction, config, client) {
        const guild = interaction.guild;
        const targetUser = interaction.options.getUser('member');

        if (targetUser) {
            const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
            return await executeVerification({
                guild,
                executorMember: interaction.member,
                targetMember,
                respond: async (payload) => {
                    await InteractionHelper.safeReply(interaction, payload);
                    return payload;
                },
            });
        }

        const result = await verifyUser(client, guild.id, interaction.user.id, {
            source: 'command_self',
            moderatorId: null
        });

        if (result.status === 'already_verified') {
            return await InteractionHelper.safeReply(interaction, {
                embeds: [infoEmbed('Already Verified', "You are already verified.")],
                flags: MessageFlags.Ephemeral
            });
        }

        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed(
                "Verification Complete",
                `You have been verified and given the **${result.roleName}** role! Welcome to the server! 🎉`
            )],
            flags: MessageFlags.Ephemeral
        });
    }
};
