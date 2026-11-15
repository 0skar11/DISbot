// homeGuild.js — our only server. The owner's rule: every update from now on is for this server only;
// other servers the bot is in keep what they had and get no new features unless the owner asks for it.
// New features check `isHomeGuild(guildId)` before doing anything.
export const HOME_GUILD_ID = '1155236281706627173';

export function isHomeGuild(guildId) {
    return String(guildId) === HOME_GUILD_ID;
}

// Zenith gets the same admin-role protection as the home server (owner's request).
export const ZENITH_GUILD_ID = '1569932761471524874';
export function isProtectedGuild(guildId) {
    return isHomeGuild(guildId) || String(guildId) === ZENITH_GUILD_ID;
}
