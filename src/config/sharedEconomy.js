// sharedEconomy.js — the CC balance and the bourse are one for every server the bot is in (the owner's
// rule): a member has the same CC and the same holdings everywhere, and the market has the same prices.
// Everything is saved under the home server's keys (src/config/homeGuild.js). What other servers saved
// before is left in the database untouched, just no longer read.
import { HOME_GUILD_ID } from './homeGuild.js';

/** The guild whose economy keys hold the shared CC and bourse data. */
export function economyScope(_guildId) {
    return HOME_GUILD_ID;
}
