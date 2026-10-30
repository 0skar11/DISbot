import { MessageFlags } from 'discord.js';
import { isHomeGuild } from '../../../config/homeGuild.js';
import { isGamesBotsChannel } from '../../../services/cc/gamesBotChannel.js';
import { companyAction } from '../../../services/cc/companyService.js';
import { moderateCompany } from '../../../services/cc/companyModeration.js';
import { COMPANY_BUTTON_PREFIX, companyPanel, quoteCompanyAction, companyFailureText, getCompanyQuote, deleteCompanyQuote } from '../../../services/cc/companyUi.js';
import { isCommandEnabledInConfig } from '../../../services/commandAccessService.js';
import { getGuildConfigKey } from '../../../utils/database/keys.js';
import { unwrapReplitData } from '../../../utils/database/guildConfigStorage.js';

const privateReply = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const heldReply = () => ({ content: '⏸️ أوامر الشركة متوقفة مؤقتًا. افتح لوحة جديدة بعد ما الإدارة تفعّلها.', embeds: [], components: [], allowedMentions: { parse: [] } });

async function buttonEnabled(client, guildId, action) {
    if (!client?.db?.getStrict || client.db.isAvailable?.() === false || client.db.isDegraded?.()) {
        throw new Error('Persistent company configuration unavailable');
    }
    // Old buttons are another command entrypoint. Read its current hold authoritatively;
    // the normal config reader can return defaults after an error and reopen access.
    const config = unwrapReplitData(await client.db.getStrict(getGuildConfigKey(guildId), {}));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid company configuration');
    const subcommand = action === 'refresh' ? 'view' : action;
    return isCommandEnabledInConfig(config, `company ${subcommand}`, 'Games');
}

export default {
    name: COMPANY_BUTTON_PREFIX,
    async execute(interaction, client, [action, ...args]) {
        if (!interaction.inGuild() || !isHomeGuild(interaction.guildId)) return privateReply(interaction, '❌ الشركات مش متاحة هنا.');
        if (!isGamesBotsChannel(interaction.channel, interaction.channelId)) return privateReply(interaction, '🏢 افتح لوحة الشركة في روم الألعاب.');
        if (action === 'confirm' || action === 'cancel') {
            const quote = getCompanyQuote(args[0]);
            if (!quote) return privateReply(interaction, companyFailureText({ reason: 'expired' }));
            if (quote.userId !== interaction.user.id || quote.guildId !== interaction.guildId) return privateReply(interaction, '❌ التأكيد ده مش ليك.');
            await interaction.deferUpdate();
            if (action === 'cancel') {
                deleteCompanyQuote(args[0]);
                return interaction.editReply({ content: '✖️ اتلغت العملية.', embeds: [], components: [], allowedMentions: { parse: [] } });
            }
            if (!await buttonEnabled(client, interaction.guildId, quote.action)) {
                deleteCompanyQuote(args[0]);
                return interaction.editReply(heldReply());
            }
            const moderation = quote.action === 'archive' || quote.action === 'restore';
            const result = moderation
                ? await moderateCompany(client, interaction.guildId, interaction.user.id, quote.targetId, quote.action, quote)
                : await companyAction(client, interaction.guildId, interaction.user.id, quote.action, quote);
            deleteCompanyQuote(args[0]);
            if (!result.ok) return interaction.editReply({ content: companyFailureText(result), embeds: [], components: [], allowedMentions: { parse: [] } });
            if (moderation) return interaction.editReply({ content: quote.action === 'archive'
                ? `✅ شركة <@${quote.targetId}> اتوقفت واتشالت من الترتيب. البيانات محفوظة؛ مفيش رد أو خصم CC.`
                : `✅ شركة <@${quote.targetId}> رجعت باسم مناسب. مفيش أرباح عن فترة الإيقاف، ولا رد أو خصم CC.`,
            embeds: [], components: [], allowedMentions: { parse: [] } });
            let receipt;
            try {
                receipt = await companyPanel(client, interaction.guildId, interaction.user.id, { notice: '✅ العملية اتحفظت بنجاح.' });
            } catch {
                // The monetary commit already succeeded. A later panel read must never turn
                // its receipt into a failure or encourage the member to repeat the purchase.
                receipt = { content: '✅ العملية اتحفظت بنجاح، لكن تحديث اللوحة مش متاح دلوقتي. اكتب `شركة` بعد شوية؛ متكررش العملية.', embeds: [], components: [], allowedMentions: { parse: [] } };
            }
            return interaction.editReply(receipt);
        }
        const ownerId = args[args.length - 1];
        if (ownerId !== interaction.user.id) return privateReply(interaction, '❌ لوحة الشركة دي مش ليك.');
        await interaction.deferUpdate();
        if (!await buttonEnabled(client, interaction.guildId, action)) return interaction.editReply(heldReply());
        if (action === 'refresh') return interaction.editReply(await companyPanel(client, interaction.guildId, ownerId));
        if (action === 'upgrade') return interaction.editReply(await quoteCompanyAction(client, interaction.guildId, ownerId, { action: 'upgrade', kind: args[0] }));
        if (action === 'withdraw') return interaction.editReply(await quoteCompanyAction(client, interaction.guildId, ownerId, { action: 'withdraw', amount: 'all' }));
        return interaction.editReply({ content: '❌ العملية دي مش متاحة.', embeds: [], components: [] });
    },
};
