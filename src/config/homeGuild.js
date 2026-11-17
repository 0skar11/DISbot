// homeGuild.js — our main server (CHAOS Club). The older rule "every update is for this server only" was
// replaced by the owner on 2026-11-17: every change from now on applies to ALL servers the bot is in.
// `isHomeGuild(guildId)` stays for the features made before that which are still for this server only.
export const HOME_GUILD_ID = '1155236281706627173';

export function isHomeGuild(guildId) {
    return String(guildId) === HOME_GUILD_ID;
}

// Zenith gets the same admin-role protection as the home server (owner's request).
export const ZENITH_GUILD_ID = '1569932761471524874';
export function isProtectedGuild(guildId) {
    return isHomeGuild(guildId) || String(guildId) === ZENITH_GUILD_ID;
}
