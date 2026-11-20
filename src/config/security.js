// security.js — one-time security cleanup asked for by the owner (reports #145, #149, #150, #152).
// Applied once per server on startup (services/securityCleanupService.js); bump CLEANUP_VERSION to
// run it again after changing the lists.

export const CLEANUP_VERSION = 2;

// The main invite link (report #152). Invites are never deleted by the bot (owner request).
export const MAIN_INVITE_CODE = '2mJmzqVy5';
export const MAIN_INVITE_URL = `https://discord.gg/${MAIN_INVITE_CODE}`;

// Taken out of the Anti-Nuke / Anti-Raid trusted list (reports #149, #150).
// 1265049672024854559 (the last attack's executor, and the second account) is no longer an owner nor trusted anywhere.
export const UNTRUST_USER_IDS = ['1308224908576428079', '1265049672024854559'];
export const UNTRUST_ROLE_IDS = ['1547448260661084161'];
