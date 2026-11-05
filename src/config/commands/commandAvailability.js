import { isBourseEnabled } from '../bourseFeature.js';
import { isDisabledProtectionCommand } from '../protectionFeature.js';

export function isMovedCCCommand(name) {
    return name === 'cc' || name === 'cctop';
}

export function isSilentCommand(name) {
    return isMovedCCCommand(name) || isDisabledProtectionCommand(name) || (name === 'bourse' && !isBourseEnabled());
}
