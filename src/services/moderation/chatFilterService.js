// chatFilterService.js — automatic punishment for insults and banned words (reports #146, #147, #151).
//
// The message is ALWAYS deleted, whatever the rule. Rules, checked in this order (the first match wins):
//   • ibnAl  — "ابن ال..." / "بنت ال..." only with a real insult after it (IBN_AL_INSULTS: الجزمة,
//              الكلب, الحمار, الوسخة, المتناكة, الشرموطة, القحبة, الزانية, الحرام, الزبالة, الخنزير...;
//              "ebn el gazma", "ibn el kalb", "ebn el 7mar"): deleted + a warning every time.
//              "ابن الناس", "ابن الحلال", "ابن البلد", "ابن عمي", "ابن الكلية"... are normal words.
//   • insult — strong insults (INSULTS / INSULTS_LATIN: شرموط, متناك, خول, عرص, طيز, ديوث...; "sharmoota",
//              "khawal", "3ars"): deleted + a warning every time (unchanged).
//   • family — insults aimed at the family or its religion: كسمك / كس امك / كس اختك, زانية, دين امك,
//              يلعن دينك / يلعن ابوك, ميتين امك / ميتين ابو / ميتين دين / ميتين اهل ("ksomak", "zanya",
//              "meteen omak"). The bare number "ميتين" is fine. Deleted every time, no timeout; the 3rd hit
//              by the same member within 30 minutes gives ONE warning and the count starts again.
//   • banned — words that are only deleted, with no punishment (none at the moment).
// A warning goes through warnEscalation, so 3 warnings still give the automatic timeout.
// Hidden spellings count too (dots/spaces/symbols between letters, tashkeel, tatweel, zero-width,
// repeated letters, mixed Arabic/Latin, look-alike letters, leetspeak, franco): see chatFilterRules.js.
// Owners, trusted staff (the Anti-Nuke trusted list, members or roles), bots and the report channel
// (reports quote insults) are never checked. Edit the lists in chatFilterRules.js to add or remove words.
// Our server only: the strong English insults (INSULTS_ENGLISH, rule insult) and the owner's own edits made
// with the `automod` command (automodCommand.js / automodStore.js): added words in any of the four rules above
// with the same punishments, their generated franco / English / hidden spellings, and built-in words switched off.

import { isServerOwner } from '../../config/serverOwners.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { canLiftHardBan } from './hardBanService.js';
import { REPORT_CHANNEL_ID } from '../reportChannelService.js';
import { issueWarning } from './warnEscalation.js';
import { sendModerationActionLog } from './moderationActionLogService.js';
import { postAuditRoom } from '../logging/auditRooms.js';
import { logger } from '../../utils/logger.js';
import { checkText } from './chatFilterRules.js';
import { recordRepeat } from './chatFilterRepeats.js';
export { checkText, normalizeForFilter, IBN_AL_ALLOWED, IBN_AL_INSULTS, INSULTS, BANNED_WORDS } from './chatFilterRules.js';

const NOTICE_DELETE_MS = 5_000;
export const FAMILY_REPEAT = { limit: 3, windowMs: 30 * 60_000 };

const RULES = {
    // Quiet (owner request): only the deletion, unless the repeat gives a warning.
    family: { label: 'شتيمة للأهل', repeat: FAMILY_REPEAT, silent: true },
    ibnAl: { label: 'شتيمة (ابن ال...)', warn: true },
    insult: { label: 'شتيمة', warn: true },
    banned: { label: 'كلمة ممنوعة' },
};

async function notice(message, text) {
    const sent = await message.channel.send({ content: text, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), NOTICE_DELETE_MS).unref?.();
}

/**
 * Deletes and punishes a message that breaks a rule. Returns true when the message was handled.
 * `now` and `warn` are for tests.
 */
export async function handleChatFilter(message, { now = Date.now(), warn = issueWarning } = {}) {
    if (!message.guild || message.author?.bot || isServerOwner(message.author?.id)) return false;
    // Reports quote what someone else said, so the report channel is never filtered.
    if (message.channelId === REPORT_CHANNEL_ID) return false;
    // Our server: the owner's `automod` edits and the English insults count too; other servers keep the
    // original built-in lists exactly (CLAUDE.md: new features are for our server only).
    const ruleName = checkText(message.content, { legacy: !isHomeGuild(message.guild.id) });
    if (!ruleName) return false;
    // Trusted staff (the Anti-Nuke trusted list: members or roles) may swear.
    if (await canLiftHardBan(message.guild, message.author.id).catch(() => false)) return false;
    const rule = RULES[ruleName];

    await message.delete().catch(() => {});
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const me = message.guild.members.me;
    const reason = `فلتر الشات: ${rule.label}`;
    let punishment = '🗑️ الرسالة اتمسحت';
    let shouldWarn = Boolean(rule.warn);
    if (rule.repeat) {
        const { count, reached } = recordRepeat(`${message.guild.id}:${message.author.id}`, rule.repeat, now);
        shouldWarn = reached;
        if (!reached) punishment += ` (${count}/${rule.repeat.limit})`;
    }

    try {
        if (shouldWarn && member && me) {
            const result = await warn({ guild: message.guild, member, moderator: me, reason });
            punishment = `⚠️ وارن (${result.totalCount})${result.timeoutApplied ? ' + تايم' : ''}`;
            await sendModerationActionLog(message.guild, { action: 'warn', targetUser: message.author, moderatorUser: message.client.user, reason, warnings: result.totalCount, channel: message.channel, repliedMessage: message });
        }
    } catch (error) {
        logger.warn(`Chat filter could not punish ${message.author.id}: ${error.message}`);
    }

    try {
        const lines = [
            `👤 **العضو:** <@${message.author.id}> (${message.author.tag || message.author.id})`,
            `💬 **الروم:** <#${message.channel.id}>`,
            `🚫 **المخالفة:** ${rule.label} (\`${ruleName}\`)`,
            `⚖️ **الإجراء:** ${punishment}`,
            `📝 **الرسالة:** ${message.content.slice(0, 1000)}`,
            `🤖 **المنفذ:** <@${message.client?.user?.id}> (بوت)`,
        ];
        await postAuditRoom(message.guild, 'automode', {
            color: 0xe74c3c,
            title: '🛡️ أوتومود — فلتر الشات',
            description: lines.join('\n'),
            timestamp: new Date().toISOString(),
        });
    } catch (auditErr) {
        logger.debug('Failed to post chat filter action to automode room:', auditErr);
    }

    if (!rule.silent || shouldWarn) await notice(message, `🚫 <@${message.author.id}> ${rule.label} ممنوعة هنا ・ ${punishment}`);
    return true;
}
