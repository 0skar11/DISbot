// automation.js — one switch for everything the bot does by itself at startup: posting and refreshing boards,
// timers and sweeps, making rooms and roles, and re-syncing level roles and panels.
// It is paused while the owner reshapes the server, so the bot does not recreate or undo what they change.
// Commands, buttons, tickets and the protection events keep working. Resume with AUTOMATION_PAUSED=false.
export function isAutomationPaused() {
    return String(process.env.AUTOMATION_PAUSED ?? 'true').trim().toLowerCase() !== 'false';
}

// A second, narrower switch (report #258): while on, the bot makes no new channel or role in our server
// at all — not even ones a member asks for (a ticket, a temp voice room, a bought custom role). Everything
// else (replies, moderation, existing rooms) keeps working. Our server only; other servers are never
// affected. On by default, same as AUTOMATION_PAUSED, while the owner reshapes the server.
// Resume with NO_NEW_CHANNELS_OR_ROLES=false.
export function isChannelRoleCreationPaused() {
    return String(process.env.NO_NEW_CHANNELS_OR_ROLES ?? 'true').trim().toLowerCase() !== 'false';
}
