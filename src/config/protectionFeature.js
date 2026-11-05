// Keep the original bot responsible until the replacement has been verified.
export function protectionEnabled() {
    return process.env.CHAOS_PROTECTION_ENABLED !== 'false';
}

const protectionCommands = new Set([
    'autoverify', 'ban', 'cases', 'clear', 'dm', 'kick', 'lock', 'massban',
    'masskick', 'purge', 'say', 'timeout', 'unban', 'unlock', 'untimeout',
    'usernotes', 'verification', 'verify', 'warn', 'warnings',
]);
const protectionBoards = new Set(['moderation-commands', 'admin-permissions', 'trusted']);
const protectionEvents = new Set([
    '00_antiNukeOwnerGuard.js', '01_arabicModeration.js', '02_commandFeedback.js',
    'dangerListAudit.js', 'globalLoggingSetup.js', 'hardBanEnforcement.js', 'hardBanJoinEnforcement.js',
    'mediaRole.js', 'rejoinRestore.js', 'rejoinSave.js', 'securityCleanup.js',
    'staffRoleGuard.js', 'staffRoleHierarchy.js',
]);
const protectionInteractionPaths = new Set(['moderation', 'purge', 'verification', 'warnings']);
const protectionComponentIds = new Set([
    'purge_confirm', 'purge_cancel', 'rejoinroles', 'verify_user',
    'warning_delete_specific', 'warning_clear_all', 'warning_delete_modal', 'warning_clear_confirm_modal',
]);

export function isDisabledProtectionCommand(name) {
    return !protectionEnabled() && protectionCommands.has(name);
}

export function isDisabledProtectionBoard(name, subcommand) {
    return !protectionEnabled() && name === 'publish-board' && protectionBoards.has(subcommand);
}

export function isDisabledProtectionEvent(file) {
    return !protectionEnabled() && (
        protectionEvents.has(file) || file.startsWith('antiRaid') || file.startsWith('antiNuke')
    );
}

export function isDisabledProtectionInteractionPath(relativePath) {
    return !protectionEnabled() && protectionInteractionPaths.has(relativePath.split('/')[1]);
}

export function isDisabledProtectionComponent(customId) {
    return !protectionEnabled() && protectionComponentIds.has(customId?.split(':')[0]);
}
