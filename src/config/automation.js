// automation.js — one switch for everything the bot does by itself at startup: posting and refreshing boards,
// timers and sweeps, making rooms and roles, and re-syncing level roles and panels.
// It is paused while the owner reshapes the server, so the bot does not recreate or undo what they change.
// Commands, buttons, tickets and the protection events keep working. Resume with AUTOMATION_PAUSED=false.
export function isAutomationPaused() {
    return String(process.env.AUTOMATION_PAUSED ?? 'true').trim().toLowerCase() !== 'false';
}
