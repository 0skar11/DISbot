// An explicit final word is the member's confirmation; ordinary chat is never confirmation.
export const isInlineConfirmation = (word) => word === 'تأكيد' || word === 'تاكيد';
