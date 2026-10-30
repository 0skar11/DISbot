// Shared by the confirm buttons and explicitly confirmed commands. All mutations still go through
// the locked bourse services, with the price the member was quoted.
import { getProfile } from './ccService.js';
import { invest, sell, getHoldings, hourOf } from './bourseService.js';
import {
    PRICE_CHANGED_NOTE, bourseFailureText, confirmInvestPayload, confirmSellPayload,
    confirmSellAllPayload, investReceiptEmbed, sellReceiptEmbed, sellAllReceiptEmbed,
} from './bourseUi.js';

const failed = (content) => ({ content, embeds: [], components: [], allowedMentions: { parse: [] } });

export async function bourseTradePayload(client, guildId, user, action, assetId, quantity, expectedPrice) {
    const trade = action === 'buy' ? invest : sell;
    const result = await trade(client, guildId, user.id, assetId, quantity, { expectedPrice });
    if (result.ok) {
        const embed = action === 'buy' ? investReceiptEmbed(user, result) : sellReceiptEmbed(user, result);
        return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
    }
    if (result.reason !== 'price_changed') return failed(bourseFailureText(result));
    const { asset, price } = result;
    if (action === 'buy') {
        const { cc } = await getProfile(client, guildId, user.id);
        return confirmInvestPayload(asset, quantity, price, user.id, cc, { note: PRICE_CHANGED_NOTE });
    }
    const held = (await getHoldings(client, guildId, user.id)).rows.find((row) => row.asset.id === asset.id);
    if (!held || held.qty < quantity) return failed(bourseFailureText({ reason: 'not_owned', asset, owned: held?.qty || 0 }));
    return confirmSellPayload(asset, quantity, price, user.id, { owned: held.qty, paid: held.paid }, { note: PRICE_CHANGED_NOTE });
}

/** A new hour requires confirmation again, including when it changes during a sale of all assets. */
export async function sellAllPayload(client, guildId, user, hour) {
    const { rows } = await getHoldings(client, guildId, user.id);
    if (!rows.length) return failed('💼 معندكش حاجة تبيعها.');
    if (hourOf() !== hour) return confirmSellAllPayload(rows, user.id, hourOf(), { note: PRICE_CHANGED_NOTE });
    const results = [];
    for (const row of rows) {
        const result = await sell(client, guildId, user.id, row.asset.id, row.qty, { expectedPrice: row.price });
        if (!result.ok) break;
        results.push(result);
    }
    const receipt = results.length
        ? [sellAllReceiptEmbed(user, results, { before: results[0].before, balance: results[results.length - 1].balance })]
        : [];
    if (results.length === rows.length) return { content: '', embeds: receipt, components: [], allowedMentions: { parse: [] } };
    const left = (await getHoldings(client, guildId, user.id)).rows;
    const again = confirmSellAllPayload(left, user.id, hourOf(), { note: PRICE_CHANGED_NOTE });
    return { ...again, embeds: [...receipt, ...again.embeds] };
}
