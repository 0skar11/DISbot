// automodCommand.js — `automod` (our server, the server owners only): the chat filter's insult lists, edited
// from the bot (owner's request). Typed `automod`, `!automod`, `.automod` or `اوتومود`:
//   automod                         the list, sent privately (DM; DMs closed → in the room, deleted after 60 s)
//   automod add <rule> <word>       adds a word (rule: عيلة/family, ابن/ibn, شتيمة/insult, ممنوع/banned; default insult)
//   automod remove <word>           removes your word, or switches a built-in list word off
//   automod enable <word>           switches a built-in word back on
//   automod variants <word>         the spellings the bot generates and catches (franco, English, hidden)
//   automod test <text>             which rule would catch the text (nothing is punished)
// The list has ➕ / ➖ / 🧪 buttons with forms (src/interactions/buttons/moderation/automod.js and
// src/interactions/modals/moderation/automod.js), for the owners only. Anyone else typing the word gets
// no answer at all (it is just chat), and every change is written in the automod log room.

import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
    TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { postAuditRoom } from '../logging/auditRooms.js';
import { logger } from '../../utils/logger.js';
import {
    BUILT_IN_GROUPS, IBN_AL_INSULTS, INSULTS, INSULTS_ENGLISH, INSULTS_LATIN, explainText,
} from './chatFilterRules.js';
import { variantGroups } from './chatFilterVariants.js';
import {
    MAX_CUSTOM_WORDS, WORD_MAX_LENGTH, WORD_MIN_LENGTH, addAutomodWord, enableAutomodWord, getAutomodState, removeAutomodWord,
} from './automodStore.js';

export const AUTOMOD_BUTTON = 'automod';
export const AUTOMOD_FORM = 'automodform';
export const ROOM_REPLY_DELETE_MS = 60_000;
const COLOR = 0xe74c3c;
const PAGE_CHARS = 5500;
const EMBED_CHARS = 3900;

const COMMAND_WORDS = new Set(['automod', 'اوتومود', 'أوتومود', 'اوتو-مود']);
const SUBCOMMANDS = new Map([
    ...['add', 'اضف', 'أضف', 'ضيف', 'زود'].map((w) => [w, 'add']),
    ...['remove', 'delete', 'del', 'شيل', 'امسح', 'مسح'].map((w) => [w, 'remove']),
    ...['enable', 'on', 'رجع', 'فعل'].map((w) => [w, 'enable']),
    ...['variants', 'variant', 'اشكال', 'أشكال'].map((w) => [w, 'variants']),
    ...['test', 'check', 'جرب', 'اختبر'].map((w) => [w, 'test']),
    ...['list', 'show', 'القايمة', 'لستة'].map((w) => [w, 'list']),
]);
export const RULE_WORDS = new Map([
    ...['family', 'عيلة', 'عيله', 'اهل', 'أهل'].map((w) => [w, 'family']),
    ...['ibn', 'ibnal', 'ابن', 'بنت'].map((w) => [w, 'ibnAl']),
    ...['insult', 'شتيمة', 'شتيمه', 'شتيمه'].map((w) => [w, 'insult']),
    ...['banned', 'ban', 'ممنوع', 'ممنوعة', 'ممنوعه'].map((w) => [w, 'banned']),
]);

export const RULE_INFO = {
    insult: { emoji: '🤬', label: 'شتيمة', punishment: 'مسح + وارن كل مرة' },
    family: { emoji: '👪', label: 'شتيمة للأهل', punishment: 'مسح، والتالتة خلال 30 دقيقة = وارن' },
    ibnAl: { emoji: '🐕', label: 'ابن ال...', punishment: 'مسح + وارن كل مرة' },
    banned: { emoji: '🚫', label: 'كلمة ممنوعة', punishment: 'مسح بس' },
};
const ruleText = (rule) => `${RULE_INFO[rule].emoji} ${RULE_INFO[rule].label} (${RULE_INFO[rule].punishment})`;
const escape = (text) => String(text).replace(/([\\*_~`|>])/gu, '\\$1');

export const USAGE = [
    '**أوامر الأوتومود** (للأونرز بس):',
    '`automod` القايمة',
    '`automod add <نوع> <كلمة>` إضافة: النوع عيلة / ابن / شتيمة / ممنوع (من غيره = شتيمة)',
    '`automod remove <كلمة>` تشيل كلمتك، أو توقف كلمة من القايمة الأساسية',
    '`automod enable <كلمة>` ترجع كلمة أساسية وقفتها',
    '`automod variants <كلمة>` الأشكال اللي البوت بيمسكها لوحده',
    '`automod test <كلام>` تجرب الفلتر (من غير أي عقاب)',
].join('\n');

/**
 * `automod ...` typed as the first word (with `!`, `.` or the prefix, or without). Returns null for anything
 * else, or { sub: 'list'|'add'|'remove'|'enable'|'variants'|'test'|'usage', rule, text }.
 */
export function parseAutomod(content, prefix = '!') {
    let text = String(content || '').trim();
    for (const mark of [prefix, '!', '.']) {
        if (mark && text.startsWith(mark)) {
            text = text.slice(mark.length).trimStart();
            break;
        }
    }
    const [first = '', ...restWords] = text.split(/\s+/u);
    if (!COMMAND_WORDS.has(first.toLowerCase())) return null;
    const rest = text.slice(first.length).trim();
    if (!rest) return { sub: 'list', rule: null, text: '' };
    const [subWord] = restWords;
    const sub = SUBCOMMANDS.get(subWord.toLowerCase());
    if (!sub) return { sub: 'usage', rule: null, text: rest };
    let after = rest.slice(subWord.length).trim();
    let rule = null;
    if (sub === 'add') {
        const [ruleWord = ''] = after.split(/\s+/u);
        rule = RULE_WORDS.get(ruleWord.toLowerCase()) || null;
        if (rule) after = after.slice(ruleWord.length).trim();
        rule ||= 'insult';
    }
    return { sub, rule, text: after };
}

/** Whether `message` is an owner's `automod` command in our server (messageCreate's report-channel check). */
export function isAutomodCommand(message, prefix) {
    return Boolean(message?.guild && isHomeGuild(message.guild.id) && isServerOwner(message.author?.id) && parseAutomod(message.content, prefix));
}

// ---- the list ----------------------------------------------------------------------------------
function chunks(text, size = EMBED_CHARS) {
    const out = [];
    let rest = text;
    while (rest.length > size) {
        let cut = Math.max(rest.lastIndexOf('\n', size), rest.lastIndexOf('، ', size), rest.lastIndexOf(', ', size));
        if (cut < size / 2) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^(?:\n|، |, )/u, '');
    }
    if (rest) out.push(rest);
    return out;
}

const listLine = (label, words, separator = '، ') => `${label} ${words.length ? words.map(escape).join(separator) : '*مفيش*'}`;

/** The list's sections (rule classes), each { title, text }. */
export function automodSections(state = getAutomodState()) {
    const off = new Set(state.disabled);
    const on = (list) => list.filter((word) => !off.has(word));
    const custom = (rule) => state.custom.filter((entry) => entry.rule === rule).map((entry) => entry.word);
    return [
        {
            title: ruleText('insult'),
            text: [
                listLine('**الأساسية (عربي):**', on(INSULTS)),
                listLine('**الأساسية (فرانكو):**', on(INSULTS_LATIN), ', '),
                listLine('**الأساسية (إنجليزي):**', INSULTS_ENGLISH.filter((entry) => !off.has(entry.word)).map((entry) => entry.word), ', '),
                listLine('**كلماتك:**', custom('insult')),
            ].join('\n'),
        },
        {
            title: ruleText('family'),
            text: [
                '🔒 **أنماط ثابتة (للقراية بس):**',
                ...BUILT_IN_GROUPS.family.map((line) => `> ${line}`),
                listLine('**كلماتك:**', custom('family')),
            ].join('\n'),
        },
        {
            title: ruleText('ibnAl'),
            text: [
                listLine('**الأساسية (ابن ال + ...):**', on(IBN_AL_INSULTS)),
                ...BUILT_IN_GROUPS.ibnAl.map((line) => `🔒 ${line}`),
                listLine('**كلماتك (بعد ابن ال...):**', custom('ibnAl')),
            ].join('\n'),
        },
        { title: ruleText('banned'), text: listLine('**كلماتك:**', custom('banned')) },
        { title: '⏸️ كلمات أساسية موقفة', text: listLine('', state.disabled).trim() },
    ];
}

const HEADER = [
    'دي الكلمات اللي الفلتر بيمسحها (السيرفر ده بس). الأونرز والتراستد مش بيتفلتروا.',
    '🤖 كل كلمة بتضيفها البوت بيمسك أشكالها لوحده: الفرانكو (3=ع، 7=ح، 5=خ، 2=ق...)، الإنجليزي (كلب = dog...)، '
        + 'والكتابة المستخبية (مسافات ونقط ورموز بين الحروف، تشكيل وتطويل، حروف مكررة أو شبيهة، leetspeak).',
    '🔒 الأنماط الثابتة (كسمك، كس امك، زانية، دين امك، يلعن...، ميتين امك) مكتوبة كـ regex بيمسك مئات الكتابات مرة واحدة، '
        + 'فمينفعش تتشال كلمة كلمة؛ عشان كده بتظهر للقراية بس.',
    '',
    USAGE,
].join('\n');

/** All the list's embeds split into pages (each under Discord's 6000 characters and 10 embeds). */
export function automodPages(state = getAutomodState()) {
    const embeds = [{ color: COLOR, title: '🛡️ أوتومود — فلتر الشتايم', description: HEADER }];
    for (const section of automodSections(state)) {
        chunks(section.text).forEach((part, index) => embeds.push({ color: COLOR, title: index ? `${section.title} (تابع)` : section.title, description: part }));
    }
    const pages = [];
    let page = [];
    let size = 0;
    for (const embed of embeds) {
        const length = embed.title.length + embed.description.length;
        if (page.length && (size + length > PAGE_CHARS || page.length >= 9)) {
            pages.push(page);
            page = [];
            size = 0;
        }
        page.push(embed);
        size += length;
    }
    if (page.length) pages.push(page);
    return pages;
}

/** One page of the list with its buttons: `automod:<action>:<guildId>:<page>`. */
export function automodListPayload(guildId, pageIndex = 0, state = getAutomodState()) {
    const pages = automodPages(state);
    const page = Math.min(Math.max(Number(pageIndex) || 0, 0), pages.length - 1);
    const embeds = pages[page].map((embed) => ({ ...embed }));
    embeds[embeds.length - 1].footer = { text: `صفحة ${page + 1}/${pages.length} ・ كلماتك ${state.custom.length}/${MAX_CUSTOM_WORDS}${state.loaded === false ? ' ・ ⚠️ القايمة المحفوظة ما اتقرتش' : ''}` };
    const id = (action, target = page) => `${AUTOMOD_BUTTON}:${action}:${guildId}:${target}`;
    const rows = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('add')).setLabel('إضافة').setEmoji('➕').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(id('remove')).setLabel('شيل / وقف').setEmoji('➖').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(id('test')).setLabel('تجربة').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('page')).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    )];
    if (pages.length > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(id('page', page - 1)).setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId(id('page', page + 1)).setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(page === pages.length - 1),
        ));
    }
    return { content: '', embeds, components: rows, allowedMentions: { parse: [] } };
}

// ---- answers ------------------------------------------------------------------------------------
const FAILURE = {
    length: `❌ الكلمة لازم تكون من ${WORD_MIN_LENGTH} لـ ${WORD_MAX_LENGTH} حرف.`,
    link: '❌ ممنوع منشن أو لينك في الكلمة.',
    rule: '❌ النوع لازم يكون: عيلة / ابن / شتيمة / ممنوع.',
    empty: '❌ الكلمة لازم يكون فيها حروف.',
    common: '❌ دي كلمة عادية جداً، لو اتفلترت هتمسح نص الشات.',
    duplicate: '⚠️ الكلمة دي موجودة في كلماتك.',
    full: `❌ وصلت للحد (${MAX_CUSTOM_WORDS} كلمة). شيل كلمة الأول.`,
    not_loaded: '⚠️ القايمة المحفوظة ما اتقرتش من الداتابيز، مفيش تعديل لحد ما تتقري (عشان ما تتمسحش). جرب كمان شوية.',
    not_found: '⚠️ الكلمة دي مش في القايمة.',
    not_off: '⚠️ الكلمة دي مش موقفة.',
};

export function addResultText(result) {
    if (!result.ok) {
        if (result.reason === 'builtin') return `⚠️ **${escape(result.builtIn.word)}** موجودة في القايمة الأساسية. لو عايز تغير نوعها: \`automod remove ${result.builtIn.word}\` وبعدين ضيفها تاني.`;
        if (result.reason === 'already') return `⚠️ الفلتر بيمسكها خلاص: ${ruleText(result.rule)}${result.word ? ` (من **${escape(result.word)}**)` : ''}.`;
        return FAILURE[result.reason] || '❌ حصلت مشكلة.';
    }
    const g = result.variants;
    const englishCount = g.english.length + g.englishEveryday.length + g.englishDouble.length + g.englishDoubleEveryday.length;
    const count = g.arabic.length + g.francoForms.length + g.arabicFromLatin.length + g.skeleton.length + englishCount;
    return [
        `✅ اتضافت **${escape(result.entry.word)}** ・ ${ruleText(result.entry.rule)}`,
        `🤖 البوت هيمسك معاها ${count} شكل (فرانكو${englishCount ? ' وإنجليزي' : ''} وكتابة مستخبية). \`automod variants ${result.entry.word}\` يعرضهم.`,
        ...savedNote(result),
    ].join('\n');
}

export function removeResultText(result) {
    if (!result.ok) {
        if (result.reason === 'already_off') return `⚠️ **${escape(result.builtIn.word)}** موقفة خلاص.`;
        if (result.reason === 'readonly') return `🔒 دي بتتمسك بنمط ثابت (${ruleText(result.rule)})، والأنماط دي مينفعش تتشال كلمة كلمة.`;
        return FAILURE[result.reason] || '❌ حصلت مشكلة.';
    }
    if (result.kind === 'custom') return [`🗑️ اتشالت **${escape(result.entry.word)}** من كلماتك.`, ...savedNote(result)].join('\n');
    return [
        `⏸️ اتوقفت **${escape(result.builtIn.word)}** من القايمة الأساسية. \`automod enable ${result.builtIn.word}\` يرجعها.`,
        ...(result.related?.length ? [`ℹ️ كتابات تانية لنفس الكلمة لسه شغالة: ${result.related.map(escape).join('، ')}`] : []),
        ...savedNote(result),
    ].join('\n');
}

export function enableResultText(result) {
    if (!result.ok) return FAILURE[result.reason] || '❌ حصلت مشكلة.';
    return [`▶️ رجعت **${escape(result.word)}** للقايمة الأساسية.`, ...savedNote(result)].join('\n');
}

function savedNote(result) {
    if (result.saved === false) return ['⚠️ ما اتحفظتش في الداتابيز (شغالة لحد ما البوت يعيد تشغيل).'];
    if (result.persistent === false) return ['⚠️ الداتابيز مش شغالة: التعديل شغال لحد ما البوت يعيد تشغيل.'];
    return [];
}

const sample = (list, max = 40) => (list.length > max ? `${list.slice(0, max).map(escape).join(', ')} … (+${list.length - max})` : list.map(escape).join(', '));

export function variantsText(word, rule) {
    const g = variantGroups(word, rule);
    if (!g.normalized) return FAILURE.empty;
    const lines = [
        `🔎 **الأشكال اللي البوت بيمسكها لـ "${escape(word)}"** ・ ${ruleText(g.rule)}`,
        g.rule === 'ibnAl' ? `بعد "ابن ال / بنت ال / ebn el": **${escape(g.normalized)}**` : `عربي: **${escape(g.normalized)}** (+ يا/ال/و/ب قبلها و ك/ه/ها/كم بعدها)`,
    ];
    if (g.francoForms.length) lines.push(`فرانكو (${g.francoForms.length}): ${sample(g.francoForms)}`);
    if (g.arabicFromLatin.length) lines.push(`عربي من الفرانكو (${g.arabicFromLatin.length}): ${sample(g.arabicFromLatin)}`);
    if (g.skeleton.length) lines.push(`هيكل الحروف (للكلمات الطويلة): ${g.skeleton.map(escape).join(', ')}`);
    const english = [...g.english, ...g.englishDouble];
    if (english.length) lines.push(`إنجليزي (${english.length}): ${sample(english)}`);
    const everyday = [...g.englishEveryday, ...g.englishDoubleEveryday];
    if (everyday.length) lines.push(`إنجليزي بعد you / ya / stupid بس (${everyday.length}): ${sample(everyday)}`);
    lines.push('➕ وكمان: المسافات والنقط والرموز بين الحروف، التشكيل والتطويل، الحروف المكررة والشبيهة والـ leetspeak بتتشال قبل المقارنة.');
    return lines.join('\n').slice(0, 3900);
}

export function testText(text) {
    if (!String(text || '').trim()) return '⚠️ اكتب الكلام بعد `automod test`.';
    const found = explainText(text);
    if (!found) return '✅ مفيش حاجة هتتمسح في الكلام ده.';
    const source = found.source === 'custom' ? `من كلماتك: **${escape(found.word)}**`
        : found.source === 'english' ? `من الإنجليزي الأساسي: **${escape(found.word)}**` : 'من القايمة / الأنماط الأساسية';
    return `🛑 هتتمسح: ${ruleText(found.rule)}\n${source}\nℹ️ تجربة بس: محدش اتعاقب، والأونرز والتراستد مش بيتفلتروا أصلاً.`;
}

// ---- sending -------------------------------------------------------------------------------------
/**
 * Sends `payload` to the message's author in DM; when their DMs are closed, in the room with a mention,
 * deleted after ROOM_REPLY_DELETE_MS. Returns 'dm', 'room' or 'none'.
 */
export async function sendPrivately(message, payload, { deleteAfterMs = ROOM_REPLY_DELETE_MS } = {}) {
    const dm = await message.author?.send?.(payload).catch(() => null);
    if (dm) return 'dm';
    const room = await message.channel?.send?.({
        ...payload,
        content: [`<@${message.author.id}>`, payload.content].filter(Boolean).join(' '),
        allowedMentions: { users: [message.author.id] },
    }).catch(() => null);
    if (!room) return 'none';
    setTimeout(() => room.delete?.().catch(() => {}), deleteAfterMs).unref?.();
    return 'room';
}

const textPayload = (text) => ({ content: '', embeds: [{ color: COLOR, description: text }], allowedMentions: { parse: [] } });

/** Writes one change in the automod log room. */
export async function logAutomodChange(guild, user, action, details) {
    if (!guild) return;
    try {
        await postAuditRoom(guild, 'automode', {
            color: 0xf39c12,
            title: '🛡️ أوتومود — تعديل فلتر الشتايم',
            description: [
                `👤 **الأونر:** <@${user.id}> (${user.tag || user.username || user.id})`,
                `⚙️ **العملية:** ${action}`,
                ...details,
            ].join('\n').slice(0, 4000),
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        logger.debug('Failed to log an automod change:', error);
    }
}

const ACTION_NAMES = { add: '➕ إضافة كلمة', custom: '🗑️ شيل كلمة', disabled: '⏸️ وقف كلمة أساسية', enable: '▶️ رجوع كلمة أساسية' };

/** Runs one edit (add / remove / enable) and logs it. Returns the answer text. */
export async function runAutomodEdit(client, guild, user, sub, { word, rule = 'insult' }) {
    if (!String(word || '').trim()) return `⚠️ اكتب الكلمة.\n${USAGE}`;
    if (sub === 'add') {
        const result = await addAutomodWord(client, { word, rule, by: user.id });
        if (result.ok) await logAutomodChange(guild, user, ACTION_NAMES.add, [`📝 **الكلمة:** ${escape(result.entry.word)}`, `🚫 **النوع:** ${ruleText(result.entry.rule)}`]);
        return addResultText(result);
    }
    if (sub === 'remove') {
        const result = await removeAutomodWord(client, { word });
        if (result.ok) {
            const shown = result.kind === 'custom' ? result.entry.word : result.builtIn.word;
            await logAutomodChange(guild, user, ACTION_NAMES[result.kind], [`📝 **الكلمة:** ${escape(shown)}`,
                ...(result.kind === 'custom' ? [`🚫 **النوع:** ${ruleText(result.entry.rule)}`] : [])]);
        }
        return removeResultText(result);
    }
    const result = await enableAutomodWord(client, { word });
    if (result.ok) await logAutomodChange(guild, user, ACTION_NAMES.enable, [`📝 **الكلمة:** ${escape(result.word)}`]);
    return enableResultText(result);
}

/**
 * `automod ...` typed in our server by an owner. Returns true when handled; false (nothing sent, the message
 * goes on as chat) for anyone else, another server, or a message that is not this command.
 */
export async function handleAutomodMessage(message, { prefix = '!' } = {}) {
    if (!message?.guild || message.author?.bot || !isHomeGuild(message.guild.id)) return false;
    const parsed = parseAutomod(message.content, prefix);
    if (!parsed || !isServerOwner(message.author.id)) return false;
    const client = message.client;
    // The words stay private: the typed command is removed from the room.
    await message.delete?.().catch(() => {});
    if (parsed.sub === 'list') {
        await sendPrivately(message, automodListPayload(message.guild.id, 0));
        return true;
    }
    let text;
    if (parsed.sub === 'usage') text = USAGE;
    else if (parsed.sub === 'variants') {
        const custom = getAutomodState().custom.find((entry) => entry.word === parsed.text);
        text = parsed.text ? variantsText(parsed.text, custom?.rule || 'insult') : `⚠️ اكتب الكلمة.\n${USAGE}`;
    } else if (parsed.sub === 'test') text = testText(parsed.text);
    else text = await runAutomodEdit(client, message.guild, message.author, parsed.sub, { word: parsed.text, rule: parsed.rule });
    await sendPrivately(message, textPayload(text));
    return true;
}

// ---- buttons and forms ------------------------------------------------------------------------------
const NOT_OWNER = '🚫 الأوتومود للأونرز بس.';
const STALE = 'ℹ️ القايمة دي قديمة، اكتب `automod` تاني.';
const privately = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});

export function automodModal(action, guildId, page = 0) {
    const modal = new ModalBuilder().setCustomId(`${AUTOMOD_FORM}:${action}:${guildId}:${page}`);
    const textInput = (id, style, max, placeholder) => new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setPlaceholder(placeholder).setRequired(true);
    if (action === 'add') {
        return modal.setTitle('➕ إضافة كلمة للفلتر').addLabelComponents(
            new LabelBuilder().setLabel('الكلمة').setDescription('البوت هيمسك الفرانكو والإنجليزي والكتابة المستخبية لوحده')
                .setTextInputComponent(textInput('word', TextInputStyle.Short, WORD_MAX_LENGTH, 'مثلاً: كلب')),
            new LabelBuilder().setLabel('النوع').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('rule').setMinValues(1).setMaxValues(1)
                .addOptions(['insult', 'family', 'ibnAl', 'banned'].map((rule) => ({
                    label: `${RULE_INFO[rule].label}`, description: RULE_INFO[rule].punishment, emoji: RULE_INFO[rule].emoji, value: rule, default: rule === 'insult',
                })))),
        );
    }
    if (action === 'remove') {
        return modal.setTitle('➖ شيل / وقف كلمة').addLabelComponents(
            new LabelBuilder().setLabel('الكلمة').setDescription('كلمتك بتتشال، والكلمة الأساسية بتتوقف (enable يرجعها)')
                .setTextInputComponent(textInput('word', TextInputStyle.Short, WORD_MAX_LENGTH, 'الكلمة زي ما هي في القايمة')),
        );
    }
    return modal.setTitle('🧪 تجربة الفلتر').addLabelComponents(
        new LabelBuilder().setLabel('الكلام').setDescription('محدش هيتعاقب، دي تجربة بس')
            .setTextInputComponent(textInput('text', TextInputStyle.Paragraph, 1000, 'اكتب أي كلام')),
    );
}

/** The list's buttons: `automod:<page|add|remove|test>:<guildId>:<page>`. Owners only. */
export async function handleAutomodButton(interaction, client, [action, guildId, page] = []) {
    if (!isServerOwner(interaction.user?.id)) return privately(interaction, NOT_OWNER);
    if (!isHomeGuild(guildId) || !['page', 'add', 'remove', 'test'].includes(action)) return privately(interaction, STALE);
    if (action === 'page') return interaction.update(automodListPayload(guildId, page)).catch(() => privately(interaction, STALE));
    return interaction.showModal(automodModal(action, guildId, Number(page) || 0)).catch(() => privately(interaction, STALE));
}

/** The forms: `automodform:<add|remove|test>:<guildId>:<page>`. Owners only. */
export async function handleAutomodForm(interaction, client, [action, guildId, page] = []) {
    if (!isServerOwner(interaction.user?.id)) return privately(interaction, NOT_OWNER);
    if (!isHomeGuild(guildId) || !['add', 'remove', 'test'].includes(action)) return privately(interaction, STALE);
    const field = (id) => {
        try {
            return interaction.fields.getTextInputValue(id);
        } catch {
            return '';
        }
    };
    if (action === 'test') return privately(interaction, testText(field('text')));
    let rule = 'insult';
    try {
        rule = interaction.fields.getStringSelectValues('rule')?.[0] || 'insult';
    } catch {
        rule = 'insult';
    }
    const guild = client?.guilds?.cache?.get(guildId) || (interaction.guild?.id === guildId ? interaction.guild : null);
    const text = await runAutomodEdit(client, guild, interaction.user, action, { word: field('word'), rule });
    await privately(interaction, text);
    // The list the buttons came from shows the change.
    await interaction.message?.edit?.(automodListPayload(guildId, page)).catch(() => {});
    return true;
}
