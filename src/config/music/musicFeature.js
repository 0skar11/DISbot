// The music feature (`شغل`, `/play`, `/music`...) is OFF in DISbot (owner, 2026-11-17): its commands are not
// loaded or registered, the typed words get no answer, and no Lavalink connection is made at startup.
// Nothing was deleted: MUSIC_ENABLED=true in the environment turns it all back on after a restart.
export const MUSIC_COMMAND_NAMES = new Set(['join', 'music', 'nowplaying', 'play', 'queue']);

export function musicEnabled(env = process.env) {
    return String(env.MUSIC_ENABLED || '').trim().toLowerCase() === 'true';
}
