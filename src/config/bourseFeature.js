import { isFeatureEnabled } from './bot.js';

export const BOURSE_DISABLED_NOTICE = '📈 البورصة متوقفة في البوت ده.';
export const isBourseEnabled = () => isFeatureEnabled('bourse');

export function assertBourseEnabled() {
    if (!isBourseEnabled()) {
        const error = new Error(BOURSE_DISABLED_NOTICE);
        error.code = 'BOURSE_DISABLED';
        throw error;
    }
}

export const isBourseStoreItem = (item) => Boolean(item && (item.type === 'forecast' || item.roleKey === 'trader' || item.id === 'bourse_forecast' || item.id === 'trader_role'));
