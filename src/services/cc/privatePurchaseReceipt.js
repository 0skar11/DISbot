// Prefix replies are public. Reveal an already-purchased result through an owner-only ephemeral
// component reply, never through prefix followUp and never by running the purchase again.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export const PRIVATE_PURCHASE_TTL_MS = 5 * 60_000;
const UNAVAILABLE = '🔒 الشراء تم، بس عرض النتيجة الخاصة مش متاح دلوقتي. متكررش الشراء وكلم الإدارة.';
const EXPIRED = '🔒 انتهت مهلة عرض النتيجة الخاصة. الشراء تم؛ متكررش الشراء وكلم الإدارة لو النتيجة فاتتك.';

export async function replyWithPrivatePurchase(interaction, payload, privatePayload) {
    if (!isHomeGuild(interaction.guildId)) return InteractionHelper.safeReply(interaction, payload);
    const status = (content, components = []) => ({ ...payload, content: [payload.content, content].filter(Boolean).join('\n'), components });
    if (!await InteractionHelper.safeReply(interaction, status('🔒 الشراء تم. جاري تجهيز عرض النتيجة الخاصة.'))) return null;

    let collector;
    try {
        const message = await interaction.fetchReply();
        if (!message?.id || message.guildId !== interaction.guildId) throw new Error('Private receipt is unavailable');
        // No colon: interactionCreate leaves these IDs to message collectors, avoiding a second reply.
        const customId = `store_private_${interaction.id}_${interaction.user.id}`;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder()
            .setCustomId(customId).setLabel('عرض النتيجة الخاصة').setEmoji('🔒').setStyle(ButtonStyle.Secondary));
        const expiresAt = Date.now() + PRIVATE_PURCHASE_TTL_MS;
        let result = privatePayload;
        let busy = false;
        let ended = false;
        collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: PRIVATE_PURCHASE_TTL_MS,
            filter: (button) => button.customId === customId,
        });
        const privately = (button, content) => button.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
        collector.on('collect', async (button) => {
            if (button.user.id !== interaction.user.id || button.guildId !== interaction.guildId || button.message?.id !== message.id) {
                return privately(button, '❌ النتيجة دي لصاحب الشراء بس.');
            }
            if (ended || Date.now() >= expiresAt) {
                if (!ended) collector.stop('time');
                return privately(button, EXPIRED);
            }
            if (busy) return privately(button, '⏳ النتيجة بتتعرض دلوقتي، ومفيش شراء تاني.');
            busy = true;
            try {
                await button.reply({ ...result, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
                collector.stop('delivered');
            } catch {
                // An unavailable interaction can be retried using the same receipt until it expires.
                busy = false;
            }
        });
        collector.on('end', async (_, reason) => {
            ended = true;
            result = null;
            const content = reason === 'delivered' ? '✅ النتيجة ظهرتلك بشكل خاص. الشراء اتنفّذ مرة واحدة.' : reason === 'time' ? EXPIRED : UNAVAILABLE;
            await message.edit(status(content)).catch(() => {});
        });
        await message.edit(status('🔒 الخاص مقفول. اضغط **عرض النتيجة الخاصة** خلال **5 دقايق**. لو الزرار مش متاح، متكررش الشراء وكلم الإدارة.', [row]));
        return collector;
    } catch {
        collector?.stop('unavailable');
        await InteractionHelper.safeEditReply(interaction, status(UNAVAILABLE));
        return null;
    }
}
