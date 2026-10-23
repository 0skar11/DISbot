import { MessageFlags } from 'discord.js';
import { isHomeGuild } from '../../../config/homeGuild.js';
import { BOURSE_BUTTON_PREFIX } from '../../../services/cc/bourseUi.js';
import { bourseTradePayload, sellAllPayload } from '../../../services/cc/bourseTransactions.js';

// The bourse confirm buttons: `bourse:buy|sell:<assetId>:<quantity>:<price>:<userId>` and
// `bourse:cancel:<userId>`. They only work for the member who asked. When the price changed since
// (a new hour started) nothing is bought or sold and the confirmation is shown again at the new price.
// `بيع كلو` confirms with `bourse:sellall:<hour>:<userId>` (our server only): everything is sold at the
// prices of that hour, or shown again when a new hour started.
const PRESS_COOLDOWN_MS = 2_000;
const lastPress = new Map();

function onCooldown(userId) {
    const now = Date.now();
    if (now - (lastPress.get(userId) || 0) < PRESS_COOLDOWN_MS) return true;
    lastPress.set(userId, now);
    return false;
}

const privately = (interaction, content) => interaction.reply({ content, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral }).catch(() => {});
const failed = (content) => ({ content, embeds: [], components: [], allowedMentions: { parse: [] } });

async function execute(interaction, client, [action, ...args]) {
    if (!interaction.inGuild()) return;
    const ownerId = args[args.length - 1];
    if (ownerId !== interaction.user.id) return privately(interaction, '❌ الزرار ده مش ليك.');
    if (action === 'cancel') return interaction.update(failed('✖️ اتلغى.')).catch(() => {});
    if (action !== 'buy' && action !== 'sell' && action !== 'sellall') return privately(interaction, 'الزرار ده مبقاش شغال.');
    if (onCooldown(interaction.user.id)) return privately(interaction, '⏳ استنى ثانية.');
    if (action === 'sellall') {
        if (!isHomeGuild(interaction.guildId)) return privately(interaction, '❌ الأمر ده مش متاح هنا.');
        await interaction.deferUpdate().catch(() => {});
        return interaction.editReply(await sellAllPayload(client, interaction.guildId, interaction.user, Number(args[0]))).catch(() => {});
    }

    await interaction.deferUpdate().catch(() => {});
    const [assetId, quantityText, priceText] = args;
    const quantity = Number(quantityText) || 1;
    const payload = await bourseTradePayload(client, interaction.guildId, interaction.user, action, assetId, quantity, Number(priceText));
    await interaction.editReply(payload).catch(() => {});
}

export default { name: BOURSE_BUTTON_PREFIX, execute };
