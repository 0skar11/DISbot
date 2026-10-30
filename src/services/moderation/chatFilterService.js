// chatFilterService.js — automatic punishment for insults and banned words (reports #146, #147, #151).
//
// Each rule has a punishment, from the strongest:
//   • kosomak   — "كسمك" and anything with the same meaning, even hidden ("ك س م ك", "كـسـمـك",
//                 "kosomak", "k$mk"): message deleted + 1 hour timeout.
//   • ibnAl     — "ابن ال..." with any word ("ابن الكلب", "يا ابن ال...", "ebn el ..."): message deleted
//                 + a warning (the owner changed it from a 15 minute timeout). A few friendly phrases
//                 are left alone (IBN_AL_ALLOWED).
//   • insult    — strong insults (INSULTS in chatFilterRules): message deleted + a warning (3 warnings = timeout).
//   • banned    — words that are only deleted, with no punishment ("الحفره").
// Owners, trusted staff (the Anti-Nuke trusted list, members or roles), bots and the report channel
// (reports quote insults) are never checked. Edit the lists
// in chatFilterRules.js to add or remove words.

import { isServerOwner } from '../../config/serverOwners.js';
import { canLiftHardBan } from './hardBanService.js';
import { REPORT_CHANNEL_ID } from '../reportChannelService.js';
import { issueWarning } from './warnEscalation.js';
import { sendModerationActionLog } from './moderationActionLogService.js';
import { logger } from '../../utils/logger.js';
import { checkText } from './chatFilterRules.js';
export { checkText, normalizeForFilter, IBN_AL_ALLOWED, INSULTS, BANNED_WORDS } from './chatFilterRules.js';

const NOTICE_DELETE_MS = 5_000;
const HOUR = 60 * 60_000;

const RULES = {
    // The owner's own reply for this one, instead of the usual notice.
    kosomak: { label: 'شتيمة (كسمك)', timeoutMs: HOUR, reply: (userId) => `<@${userId}> كسمين امك خد تايم يبنالمتناكه` },
    ibnAl: { label: 'شتيمة (ابن ال...)', warn: true },
    insult: { label: 'شتيمة', warn: true },
    banned: { label: 'كلمة ممنوعة' },
};

async function notice(message, text) {
    const sent = await message.channel.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), NOTICE_DELETE_MS).unref?.();
}

/** Deletes and punishes a message that breaks a rule. Returns true when the message was handled. */
export async function handleChatFilter(message) {
    if (!message.guild || message.author?.bot || isServerOwner(message.author?.id)) return false;
    // Reports quote what someone else said, so the report channel is never filtered.
    if (message.channelId === REPORT_CHANNEL_ID) return false;
    const ruleName = checkText(message.content);
    if (!ruleName) return false;
    // Trusted staff (the Anti-Nuke trusted list: members or roles) may swear.
    if (await canLiftHardBan(message.guild, message.author.id).catch(() => false)) return false;
    const rule = RULES[ruleName];

    await message.delete().catch(() => {});
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const me = message.guild.members.me;
    const reason = `فلتر الشات: ${rule.label}`;
    let punishment = '🗑️ الرسالة اتمسحت';

    try {
        if (rule.timeoutMs && member?.moderatable) {
            await member.timeout(rule.timeoutMs, reason);
            punishment = `⏳ تايم ${rule.timeoutMs >= HOUR ? 'ساعة' : `${rule.timeoutMs / 60_000} دقيقة`}`;
            await sendModerationActionLog(message.guild, { action: 'timeout', targetUser: message.author, moderatorUser: message.client.user, reason, durationMs: rule.timeoutMs, channel: message.channel, repliedMessage: message });
        } else if (rule.warn && member && me) {
            const result = await issueWarning({ guild: message.guild, member, moderator: me, reason });
            punishment = `⚠️ وارن (${result.totalCount})${result.timeoutApplied ? ' + تايم' : ''}`;
            await sendModerationActionLog(message.guild, { action: 'warn', targetUser: message.author, moderatorUser: message.client.user, reason, warnings: result.totalCount, channel: message.channel, repliedMessage: message });
        }
    } catch (error) {
        logger.warn(`Chat filter could not punish ${message.author.id}: ${error.message}`);
    }

    await notice(message, rule.reply ? rule.reply(message.author.id) : `🚫 <@${message.author.id}> ${rule.label} ممنوعة هنا ・ ${punishment}`);
    return true;
}
