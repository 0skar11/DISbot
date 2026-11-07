import { SlashCommandBuilder } from 'discord.js';
import { transferCC } from '../../services/cc/ccService.js';
import { CC, formatCC, ccEmbed } from '../../config/cc.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// `give @member 100` / `تحويل @member 100` / `cc give @member 100`: sends CC to another member. The
// receiver gets the amount minus a tax that grows when the sender sends a lot in a week (CC.transfer).
export default {
    data: new SlashCommandBuilder()
        .setName('give')
        .setDescription(`Send ${CC.name} (${CC.short}) to another member (a small tax is taken)`)
        .setDMPermission(false)
        .addUserOption((option) => option.setName('user').setDescription('Who gets the CC').setRequired(true))
        .addIntegerOption((option) => option
            .setName('amount')
            .setDescription(`How much to send (at least ${CC.transfer.minAmount})`)
            .setMinValue(CC.transfer.minAmount)
            .setRequired(true)),

    async execute(interaction, config, client) {
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const reply = (content) => InteractionHelper.safeReply(interaction, { content, allowedMentions: { parse: [] } });

        if (!target || target.bot) return reply('البوتات مالهاش CC 🤖');
        if (target.id === interaction.user.id) return reply('❌ مينفعش تحوّل لنفسك.');
        const [sender, member] = await Promise.all([
            interaction.member?.joinedTimestamp ? interaction.member : interaction.guild.members.fetch(interaction.user.id).catch(() => null),
            interaction.guild.members.fetch(target.id).catch(() => null),
        ]);
        if (!member) return reply('❌ العضو ده مش في السيرفر.');
        // Anti-alt: the sender must have been in the server for CC.transfer.minServerDays (the receiver can be new).
        const minAge = CC.transfer.minServerDays * 24 * 60 * 60 * 1000;
        const tooNew = (m) => !m?.joinedTimestamp || Date.now() - m.joinedTimestamp < minAge;
        if (tooNew(sender)) return reply(`❌ لازم يكون ليك في السيرفر ${CC.transfer.minServerDays} يوم على الأقل عشان تحوّل.`);

        const result = await transferCC(client, interaction.guildId, interaction.user.id, target.id, amount);
        if (!result.ok) {
            if (result.reason === 'no_cc') return reply(`❌ رصيدك ${formatCC(result.balance)} بس، مش كفاية تحوّل ${formatCC(amount)}.`);
            if (result.reason === 'bad_amount') return reply(`❌ أقل مبلغ للتحويل ${formatCC(CC.transfer.minAmount)}.`);
            return reply('❌ مينفعش تحوّل لنفسك.');
        }

        const embed = ccEmbed('🔁 تحويل CC', [
            `${interaction.user} ➜ ${target}`,
            '',
            `💸 المبلغ: ${formatCC(result.amount)}`,
            `🧾 الضريبة (${result.taxPercent}%): ${formatCC(result.tax)}`,
            `✅ وصل: ${formatCC(result.received)}`,
            `💰 رصيدك: ${formatCC(result.balance)}`,
        ].join('\n'), {
            fields: [{
                name: '📅 التحويل الجاي',
                value: result.nextTaxPercent > CC.transfer.taxPercent
                    ? `ضريبته **${result.nextTaxPercent}%** عشان حوّلت كتير آخر 7 أيام (أقصاها ${CC.transfer.maxTaxPercent}%).`
                    : `ضريبته **${result.nextTaxPercent}%**. بعد ${CC.transfer.cheapPerWeek} تحويلات في 7 أيام بتبدأ تزيد (أقصاها ${CC.transfer.maxTaxPercent}%).`,
            }],
        });
        await InteractionHelper.safeReply(interaction, { content: `${target}`, embeds: [embed], allowedMentions: { users: [target.id] } });
    },
};
