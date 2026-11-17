import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { resetBugReportCounter } from '../../services/bugsReportsInbox.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('resetbugscounter')
        .setDescription('Owner only: reset the #bugs-reports counter to #1 in this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),

    async execute(interaction, config, client) {
        const reply = (payload) => InteractionHelper.safeReply(interaction, { allowedMentions: { parse: [] }, ...payload });
        if (!isServerOwner(interaction.user.id)) return reply({ content: '❌ الأمر ده للأونر بس.' });

        const success = await resetBugReportCounter(client, interaction.guildId);
        if (!success) return reply({ content: '❌ فشل تصفير العداد بسبب مشكلة في قاعدة البيانات.' });

        await reply({ content: '✅ تم تصفير عداد البلاغات في السيرفر ده، البلاغ القادم هيكون رقم #1.' });
    },
};
