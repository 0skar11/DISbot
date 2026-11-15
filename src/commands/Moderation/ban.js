import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { moderationCard, cardReason } from '../../utils/moderationCard.js';
import { fetchRepliedMessage, sendModerationActionLog } from '../../services/moderation/moderationActionLogService.js';
import { ensureCanActOn } from '../../services/moderation/memberHierarchy.js';

export default {
    data: new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user from the server")
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("The user to ban")
                .setRequired(true),
        )
        .addStringOption((option) =>
            option.setName("reason").setDescription("Reason for the ban"),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const user = interaction.options.getUser("target");
        const reason = cardReason(interaction.options.getString("reason"));

        if (!user) {
            throw new TitanBotError(
                'Missing target user',
                ErrorTypes.USER_INPUT,
                'You must specify a user to ban.',
                { subtype: 'invalid_user' },
            );
        }

        if (user.id === interaction.user.id) {
            throw new TitanBotError(
                'Cannot ban self',
                ErrorTypes.VALIDATION,
                'You cannot ban yourself.',
            );
        }
        if (user.id === client.user.id) {
            throw new TitanBotError(
                'Cannot ban bot',
                ErrorTypes.VALIDATION,
                'You cannot ban the bot.',
            );
        }

        // Our servers: a member of the same or a higher role (or an owner) is refused here (memberHierarchy.js).
        ensureCanActOn(interaction.guild, interaction.member, interaction.options.getMember("target") || user);

        const repliedMessage = await fetchRepliedMessage(interaction);
        await ModerationService.banUser({
            guild: interaction.guild,
            user,
            moderator: interaction.member,
            reason,
        });
        await sendModerationActionLog(interaction.guild, {
            action: 'ban',
            targetUser: user,
            moderatorUser: interaction.user,
            executorUser: interaction.user,
            reason,
            channel: interaction.channel,
            repliedMessage,
        });

        await InteractionHelper.universalReply(interaction, moderationCard({
            emoji: '🔨',
            title: 'BAN ISSUED',
            fields: [['User', `<@${user.id}>`], ['Reason', reason]],
            moderatorId: interaction.user.id,
        }));
    },
};
