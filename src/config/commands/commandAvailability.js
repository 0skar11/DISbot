import { isBourseEnabled } from '../bourseFeature.js';

export function isMovedCCCommand(name) {
    return name === 'cc' || name === 'cctop';
}

export function isSilentCommand(name) {
    return isMovedCCCommand(name) || (name === 'bourse' && !isBourseEnabled());
}
