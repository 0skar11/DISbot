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
//              Exception (owner, 2026-11-18): كسمك / كسمكو / كس امك / ksomak aimed at a member (a reply to a member's
//              message or a mention of a member) = deleted + a one-hour timeout + the line "كسمين امك خد تايم يبن
//              الشرموطه 🖕" that deletes itself after 5 seconds.
//   • banned — words that are only deleted, with no punishment (none at the moment).
// A warning goes through warnEscalation, so 3 warnings still give the automatic timeout.
// Hidden spellings count too (dots/spaces/symbols between letters, tashkeel, tatweel, zero-width,
// repeated letters, mixed Arabic/Latin, look-alike letters, leetspeak, franco): see chatFilterRules.js.
// Owners, trusted staff (the Anti-Nuke trusted list, members or roles), bots and the report channel
// (reports quote insults) are never checked. Edit the lists in chatFilterRules.js to add or remove words.
// Every server (owner's rule of 2026-11-17: changes apply to all servers): the strong English insults (INSULTS_ENGLISH, rule insult) and the owner's own edits made
// with the `automod` command (automodCommand.js / automodStore.js): added words in any of the four rules above
// with the same punishments, their generated franco / English / hidden spellings, and built-in words switched off.
// Hand-back (owner, 2026-11-20): an insult of the rules ibnAl / insult / family (built-in or `automod`) that mentions a
// server owner or replies to an owner's message, or any such insult from a member who joined less than 5 hours ago,
// gets "<@swearer> متشتمش الاونر يا <the matched word>" instead of the usual notice line (deleted after 5 seconds).
// The punishments stay the same; the كسمك timeout line above keeps its own reply.

import { isServerOwner, SERVER_OWNER_IDS } from '../../config/serverOwners.js';
import { canLiftHardBan } from './hardBanService.js';
import { REPORT_CHANNEL_ID } from '../reportChannelService.js';
import { issueWarning } from './warnEscalation.js';
import { sendModerationActionLog } from './moderationActionLogService.js';
import { postAuditRoom } from '../logging/auditRooms.js';
import { logger } from '../../utils/logger.js';
import { matchedFragment, normalizeForFilter } from './chatFilterRules.js';
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

// `كسمك` / `كسمكو` / `كس امك` / ksomak aimed at a member (a reply to someone's message, or a mention of someone):
// the owner's rule (2026-11-18): the message is deleted, the swearer gets a one-hour timeout and the bot answers with
// the owner's line, which deletes itself after 5 seconds. Said to nobody in particular it stays a plain family insult.
const KOSOMAK = /(?<![\p{L}])(?:كسمك|كس امك|ksomak|kosomak)/u;
const KOSOMAK_TIMEOUT_MS = 60 * 60_000;
const kosomakReply = (userId) => `<@${userId}> كسمين امك خد تايم يبن الشرموطه 🖕`;

// The insults handed back to the swearer, and the time a new member counts as new.
const HANDBACK_RULES = new Set(['ibnAl', 'insult', 'family']);
export const NEW_MEMBER_MS = 5 * 60 * 60_000;
const HANDBACK_MAX = 30;
const handbackReply = (userId, word) => `<@${userId}> متشتمش الاونر يا ${word}`;

/** The matched insult made safe to echo: no "يا" in front, no mentions, markdown escaped, at most 30 characters. */
export function handbackWord(fragment) {
    const word = String(fragment || '')
        .replace(/<[@#][!&]?\d+>|<a?:\w+:\d+>|@(?:everyone|here)/giu, ' ')
        .replace(/[@<>]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/^(?:يا|ya)(?:\s+|$)/iu, '')
        .slice(0, HANDBACK_MAX)
        .trim();
    return word.replace(/[\\*_~`|[\]()#-]/gu, (char) => `\\${char}`);
}

/** The author of the message this one replies to (fetched once; null when it is not a reply or is gone). */
function repliedAuthor(message) {
    if (!message.reference?.messageId) return Promise.resolve(null);
    return (message.fetchReference?.() ?? Promise.resolve(null)).then((replied) => replied?.author || null, () => null);
}

/** Whether the message is addressed to another member: a reply to a member's message, or a mention of a member. */
async function isAimedAtMember(message, replied) {
    const self = message.author?.id;
    const mentioned = message.mentions?.users;
    if (mentioned && [...mentioned.values()].some((user) => user && !user.bot && user.id !== self)) return true;
    const author = await replied;
    return Boolean(author && !author.bot && author.id !== self);
}

/** Whether the message mentions a server owner or replies to an owner's message. */
async function isAimedAtOwner(message, replied) {
    const mentioned = message.mentions?.users;
    if (mentioned && SERVER_OWNER_IDS.some((id) => mentioned.has?.(id))) return true;
    const author = await replied;
    return Boolean(author && isServerOwner(author.id));
}

/** Joined the server less than 5 hours ago (unknown join time: no). */
function isNewMember(member, now) {
    const joined = member?.joinedTimestamp;
    return Number.isFinite(joined) && joined > 0 && now - joined < NEW_MEMBER_MS;
}

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
    // In every server: the built-in lists, the English insults and the owner's shared `automod` edits.
    const match = matchedFragment(message.content);
    const ruleName = match?.rule;
    if (!ruleName) return false;
    // Trusted staff (the Anti-Nuke trusted list: members or roles) may swear.
    if (await canLiftHardBan(message.guild, message.author.id).catch(() => false)) return false;
    let rule = RULES[ruleName];
    // The reference of a deleted message is gone: look at who it is aimed at first.
    const handbackRule = HANDBACK_RULES.has(ruleName);
    const replied = handbackRule ? repliedAuthor(message) : Promise.resolve(null);
    const aimedKosomak = ruleName === 'family' && KOSOMAK.test(normalizeForFilter(message.content)) && await isAimedAtMember(message, replied);
    const atOwner = handbackRule && await isAimedAtOwner(message, replied);

    await message.delete().catch(() => {});
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    const me = message.guild.members.me;
    let reason = `فلتر الشات: ${rule.label}`;
    let punishment = '🗑️ الرسالة اتمسحت';
    let timedOut = false;
    if (aimedKosomak && member?.moderatable) {
        reason = 'فلتر الشات: شتيمة (كسمك) لعضو';
        timedOut = await member.timeout(KOSOMAK_TIMEOUT_MS, reason).then(() => true).catch(() => false);
        if (timedOut) {
            rule = { label: 'شتيمة (كسمك) لعضو', silent: true };
            punishment = '⏳ تايم ساعة';
        }
    }
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

    const echo = handbackRule ? handbackWord(match.fragment) : '';
    if (timedOut) await notice(message, kosomakReply(message.author.id));
    else if (echo && (atOwner || isNewMember(member, now))) await notice(message, handbackReply(message.author.id, echo));
    else if (!rule.silent || shouldWarn) await notice(message, `🚫 <@${message.author.id}> ${rule.label} ممنوعة هنا ・ ${punishment}`);
    return true;
}
