// ccInviteGift.js — the CC bot's invite gift, as Aether's welcome tells it (src/services/welcomeInviteNote.js, GH #329).
//
// The CC bot (the CC-bot repo, its own database) tracks the invites and pays the gift; Aether only says, in its
// welcome, who invited the new member and what the inviter gets. So the numbers here are a COPY that must stay equal
// to the CC bot's: change both together.
//   - CC_INVITE_GIFT               = CC.inviteReward in CC-bot src/config/cc.js
//   - inviteGiftConditions()       = inviteConditions() in CC-bot src/services/cc/inviteRewardService.js
//   - formatGiftAmount()           = formatCC() in CC-bot src/config/cc.js
//   - DEFAULT_CC_LEVEL_CHANNEL_ID  = DEFAULT_LEVEL_CHANNEL_ID in CC-bot src/config/invites.js
// tests/welcomeInviteNote.test.js compares them with a CC-bot checkout next to this one (../CC-bot) when there is one.
//
// Railway variables of this bot (each one mirrors the CC bot's own):
//   - CC_INVITE_GIFT_ENABLED: the gift is told unless `false` (or `0`, `off`, `no`). Set it to false when the CC
//     bot's INVITE_REWARD_ENABLED is turned off (it is on today: the CC bot posted the gift note before GH #329).
//   - CC_LEVEL_CHANNEL_IDS: the CC bot's LEVEL_CHANNEL_IDS, comma-separated. Empty = DEFAULT_CC_LEVEL_CHANNEL_ID.
//     The CC bot tracks invites only in the servers of these rooms, so only there is the gift told.
//   - CC_BOT_ID: the CC bot's user ID. Empty = DEFAULT_CC_BOT_ID.

export const DEFAULT_CC_BOT_ID = '1567561044472103103';
export const DEFAULT_CC_LEVEL_CHANNEL_ID = '1571798045580984360';

/** CC.inviteReward of the CC bot: `amount` CC once the invited member reaches `level` and wrote `messages` messages. */
export const CC_INVITE_GIFT = Object.freeze({ amount: 5000, level: 5, messages: 50, minAccountAgeDays: 7 });
const CC_EMOJI = '🌀';
const CC_SHORT = 'CC';

const snowflake = /^\d{17,20}$/u;
const OFF = new Set(['false', '0', 'off', 'no']);
const idList = (value) => String(value ?? '').split(',').map((id) => id.trim()).filter((id) => snowflake.test(id));

/** Whether the gift is told at all (CC_INVITE_GIFT_ENABLED, on unless switched off). */
export const inviteGiftEnabled = (env = process.env) => !OFF.has(String(env.CC_INVITE_GIFT_ENABLED ?? '').trim().toLowerCase());

/** The CC bot's level-up rooms (CC_LEVEL_CHANNEL_IDS, else DEFAULT_CC_LEVEL_CHANNEL_ID): its invites are tracked in their servers. */
export function ccLevelChannelIds(env = process.env) {
  const list = idList(env.CC_LEVEL_CHANNEL_IDS);
  return new Set(list.length ? list : [DEFAULT_CC_LEVEL_CHANNEL_ID]);
}

/** The CC bot's user ID (CC_BOT_ID, else DEFAULT_CC_BOT_ID). */
export const ccBotId = (env = process.env) => idList(env.CC_BOT_ID)[0] ?? DEFAULT_CC_BOT_ID;

/** `**5,000** 🌀 CC`, like the CC bot's formatCC. */
export const formatGiftAmount = (amount = CC_INVITE_GIFT.amount) => `**${Number(amount || 0).toLocaleString('en-US')}** ${CC_EMOJI} ${CC_SHORT}`;

/** What the invited member has to do for the gift, like the CC bot's inviteConditions(): `يوصل لفل 5 ويكتب 50 رسالة`. */
export const inviteGiftConditions = () => `يوصل لفل ${CC_INVITE_GIFT.level} ويكتب ${CC_INVITE_GIFT.messages} رسالة`;
