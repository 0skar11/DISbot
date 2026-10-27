import { SlashCommandBuilder } from 'discord.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { GAMES_BOTS_CHANNEL_ID } from '../../config/games.js';
import { isGamesBotsChannel } from '../../services/cc/gamesBotChannel.js';
import { companyPanel, companiesPanel, quoteCompanyAction } from '../../services/cc/companyUi.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const words = { إنشاء: 'create', انشاء: 'create', تطوير: 'upgrade', خزنة: 'treasury', خزنه: 'treasury', سحب: 'withdraw', ترتيب: 'leaderboard' };

export default {
    data: new SlashCommandBuilder().setName('company').setDescription('Build and manage your restaurant company').setDMPermission(false)
        .addSubcommand((sub) => sub.setName('view').setDescription('Your company and treasury'))
        .addSubcommand((sub) => sub.setName('create').setDescription('Create a restaurant (cost confirmation required)')
            .addStringOption((opt) => opt.setName('name').setDescription('Company name').setRequired(true).setMinLength(2).setMaxLength(32)))
        .addSubcommand((sub) => sub.setName('upgrade').setDescription('View upgrade choices'))
        .addSubcommand((sub) => sub.setName('treasury').setDescription('View treasury and payout time'))
        .addSubcommand((sub) => sub.setName('withdraw').setDescription('Move company profit to your CC balance')
            .addIntegerOption((opt) => opt.setName('amount').setDescription('CC to withdraw').setRequired(true).setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER)))
        .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Company value, monthly profit and trophies')),
    normalizePrefixArgs(args) {
        if (!args.length) return ['view'];
        const [first, ...rest] = args;
        const sub = words[first] || first;
        return sub === 'create' ? [sub, rest.join(' ')] : [sub, ...rest];
    },
    async execute(interaction, config, client) {
        const reply = (data) => InteractionHelper.safeReply(interaction, { allowedMentions: { parse: [] }, ...data });
        if (!isHomeGuild(interaction.guildId)) return reply({ content: '❌ الشركات مش متاحة في السيرفر ده.' });
        if (!isGamesBotsChannel(interaction.channel, interaction.channelId)) return reply({ content: `🏢 الشركات في <#${GAMES_BOTS_CHANNEL_ID}> بس.` });
        // Neon may cold-start and the leaderboard reads the guild's economy rows. Acknowledge
        // Discord before doing any I/O; prefix commands use the helper's local defer path.
        if (!await InteractionHelper.ensureReady(interaction, {})) return;
        const { guildId, user } = interaction;
        const sub = interaction.options.getSubcommand();
        if (sub === 'leaderboard') return reply(await companiesPanel(client, guildId));
        if (sub === 'create') return reply(await quoteCompanyAction(client, guildId, user.id, { action: 'create', name: interaction.options.getString('name') }));
        if (sub === 'withdraw') return reply(await quoteCompanyAction(client, guildId, user.id, { action: 'withdraw', amount: interaction.options.getInteger('amount') }));
        return reply(await companyPanel(client, guildId, user.id));
    },
};
