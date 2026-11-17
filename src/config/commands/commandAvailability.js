import { isBourseEnabled } from '../bourseFeature.js';
import { MUSIC_COMMAND_NAMES, musicEnabled } from '../music/musicFeature.js';

// Commands that live in the CC bot now: not loaded, not registered as slash commands, and the typed words
// (`cc`, `شرح`...) get no answer here. `guide` (`شرح`, report #287): the guide moved to the CC bot; its files
// (commands/Games/guide.js, services/cc/guideUi.js, selectMenus/guide/) stay until they are deleted.
export const MOVED_TO_CC_BOT = new Set(['cc', 'cctop', 'guide', 'invite', 'invitetop']);

export function isMovedCCCommand(name) {
    return MOVED_TO_CC_BOT.has(name);
}

/** Switched off in this bot: moved to the CC bot, or the music commands while MUSIC_ENABLED is off. */
export function isOffCommand(name) {
    return isMovedCCCommand(name) || (MUSIC_COMMAND_NAMES.has(name) && !musicEnabled());
}

export function isSilentCommand(name) {
    return isOffCommand(name) || (name === 'bourse' && !isBourseEnabled());
}
