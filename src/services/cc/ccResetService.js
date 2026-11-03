// ccResetService.js — `resetcc`: sets everyone's CC to 0 and clears their bourse holdings (the owner's
// request). CC is one balance for every server (config/sharedEconomy.js), so this resets it everywhere.
// Owner only, our server only, and only after pressing Confirm; stats and store items are left alone.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getEconomyPrefix } from '../../utils/database/keys.js';
import { economyScope } from '../../config/sharedEconomy.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { updateCCState } from './ccService.js';
import { logger } from '../../utils/logger.js';

export const RESET_CC_WORD = 'resetcc';
export const RESET_CONFIRM_WINDOW_MS = 60_000;

/** Sets every member's CC to 0 and empties their bourse holdings. Returns `{ members, cleared, holdings }`. */
export async function resetAllCC(client) {
    const scope = economyScope(null);
    const prefix = getEconomyPrefix(scope);
    const keys = await client.db.list(prefix);
    let members = 0;
    let cleared = 0;
    let holdings = 0;
    for (const key of Array.isArray(keys) ? keys : []) {
        const userId = key.slice(prefix.length);
        const result = await updateCCState(client, scope, userId, (state, record) => {
            const had = state.cc;
            const held = Object.keys(record.ccBourse || {}).length;
            if (!had && !held) return { skipSave: true, had: 0, held: 0 };
            state.cc = 0;
            record.ccBourse = {};
            return { had, held };
        });
        members += 1;
        cleared += result.had || 0;
        holdings += result.held || 0;
    }
    logger.info('[CC] Everyone reset to 0', { members, cleared, holdings });
    return { members, cleared, holdings };
}

export function buildResetConfirmation(ownerId) {
    const expiresAt = Date.now() + RESET_CONFIRM_WINDOW_MS;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`resetcc_confirm:${ownerId}:${expiresAt}`).setLabel('Confirm').setEmoji('⚠️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`resetcc_cancel:${ownerId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return {
        content: '⚠️ **ريسيت CC** — كل الناس في **كل السيرفرات** هيرجع رصيدهم **0** وممتلكات البورصة هتتمسح. مفيش رجوع. اضغط Confirm خلال دقيقة.',
        components: [row],
        allowedMentions: { parse: [] },
    };
}

/** `resetcc` typed by the owner in our server: asks for confirmation. Returns true when it handled the message. */
export async function handleResetCcCommand(message) {
    if (!isHomeGuild(message.guild?.id) || !isServerOwner(message.author?.id)) return false;
    await message.channel.send(buildResetConfirmation(message.author.id)).catch(() => {});
    return true;
}
