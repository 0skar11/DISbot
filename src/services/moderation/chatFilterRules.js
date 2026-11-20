// Pure word policy shared by chat moderation and company names. Permission/trust
// exemptions and punishments belong to chatFilterService, not this matcher (the rule
// table is documented at the top of chatFilterService.js).
//
// Every message is looked at through several "views" so hidden spellings are caught (chatFilterText.js):
// arabic, mixed Arabic/Latin, latin (franco digits kept / leetspeak), and the franco consonant skeleton.
//
// Two rule sets are kept:
//   • legacy   — exactly the original built-in lists below (`checkText(text, { legacy: true })`); the tests use it to
//                prove the built-in lists are unchanged.
//   • current  — every server and company names (`checkText(text)`): the same built-in lists minus the words the owner switched
//                off with `automod`, plus the strong English insults (INSULTS_ENGLISH) and the owner's own
//                words with their generated spellings (chatFilterVariants.js). setCustomRules() rebuilds it
//                (automodStore.js calls it on startup and after every edit), so changes apply at once.
// The built-in regex families (كسمك..., زانية, دين امك, يلعن..., ميتين امك, the franco family spellings and
// "ebn el zanya/a7ba/labwa") are patterns, not word lists, so they cannot be switched off word by word.

import {
    collapse, normalizeForFilter, normalizeKeepRepeats, viewsOf, skeletonAlternatives,
} from './chatFilterText.js';
import { compileCustomRules, englishBuiltIns, matchCustom, maskNames } from './chatFilterVariants.js';

export { normalizeForFilter };

export const IBN_AL_ALLOWED = ['الحلال', 'الناس', 'الاصول', 'العم', 'الخال', 'البلد', 'الجيران', 'الحته', 'الحاره'];
// Only these completions of "ابن ال..." / "بنت ال..." are insults (normalized: ة→ه, no doubled letters).
export const IBN_AL_INSULTS = [
    'جزمه', 'جزم', 'كلب', 'كلبه', 'كلاب', 'حمار', 'حماره', 'وسخه', 'وسخ', 'متناكه', 'متناك',
    'شرموطه', 'شرموط', 'قحبه', 'زانيه', 'حرام', 'زباله', 'منيوكه', 'منيوك', 'عاهره', 'خنزير', 'لبوه',
];

const ENDINGS = '(?:ك|كو|كم|ه|ها|هم|ين|ات|اك)?';
export const INSULTS = [
    'شرموط', 'شرموطه', 'شراميط',
    'متناك', 'متناكه', 'منيوك', 'منيوكه', 'نيك', 'انيك', 'هنيك', 'اتناك',
    'خول', 'خولات',
    'عرص', 'معرص', 'معرصين', 'عرصه',
    'زبي', 'زبر', 'زب',
    'طيز',
    'لبوه', 'قحبه', 'قحاب',
    'ديوث',
];
export const INSULTS_LATIN = [
    'sharmot', 'sharmota', 'metnak', 'mitnak', 'metnaka', 'manyok', 'manyak', 'khawal', 'a3ars', '3ars', 'm3ars',
    'zobr', 'zeby', 'teez', 'tez', 'labwa', 'a7ba',
    // franco spellings of the same words (repeated letters are collapsed first: "sharmoota" → "sharmota")
    'sharmouta', 'shrmota', 'metnaka', 'mtnak', 'manyouk', 'manyoka', 'mnyok', 'khawl', 'khwal', '5awal', '5wal', 'khawalat', '5awalat',
    'me3ars', 'mo3ars', 'm3rs', 'm3arsin', 'dayoth', 'dayouth', 'zobry', '2a7ba', '9a7ba', 'qa7ba', 'ka7ba',
    'anikak', 'anekak', 'hanikak', 'hanekak',
];
// The long insults also caught through the franco skeleton ("sharmoota", "metnaak"): short skeletons
// (خول → "خل", منيوك → "منك") collide with normal words.
const SKELETON_INSULTS = ['شرموط', 'شراميط', 'متناك'];

// Strong English insults and slurs (every server, `insult`: deleted + a warning). Matched as whole words
// after the leetspeak view ("f*ck" → "fck", "b!tch" → "btch", "a$$hole", "fvck", "phuck"), with the usual
// endings (fucker, fucking, bitches, dickhead...). Judgement calls (kept out on purpose, see the tests):
// "ass" alone, "shit", "damn", "hoe", "prick", "cock", "chink", "gay", "idiot"/"stupid" (too common or too
// mild); "pussycat", "Scunthorpe", "class", "assassin", "cocktail", "Dickens", "Niger", "snigger" are words,
// not insults; "Dick" next to another capitalised word ("Moby Dick", "Dick Grayson") is a name.
export const INSULTS_ENGLISH = englishBuiltIns();

// "الحفره" used to be here; it is allowed now (in every server). Add patterns here to delete a word without punishment.
export const BANNED_WORDS = [];

// Every built-in list word belongs to one word: its Arabic forms, its franco spellings and the "ابن ال..."
// completions of the same word (the first entry names it). `automod remove` / `automod enable` switch the
// whole word off or on (owner's request: a removed word disappears from the list in all its spellings).
// An English entry (INSULTS_ENGLISH) is a word of its own with its spellings.
export const BUILT_IN_FAMILIES = [
    ['شرموط', 'شرموطه', 'شراميط', 'sharmot', 'sharmota', 'sharmouta', 'shrmota'],
    ['متناك', 'متناكه', 'اتناك', 'metnak', 'mitnak', 'metnaka', 'mtnak'],
    ['منيوك', 'منيوكه', 'manyok', 'manyak', 'manyouk', 'manyoka', 'mnyok'],
    ['نيك', 'انيك', 'هنيك', 'anikak', 'anekak', 'hanikak', 'hanekak'],
    ['خول', 'خولات', 'khawal', 'khawl', 'khwal', '5awal', '5wal', 'khawalat', '5awalat'],
    ['عرص', 'عرصه', 'معرص', 'معرصين', '3ars', 'a3ars', 'm3ars', 'me3ars', 'mo3ars', 'm3rs', 'm3arsin'],
    ['زب', 'زبي', 'زبر', 'zobr', 'zeby', 'zobry'],
    ['طيز', 'teez', 'tez'],
    ['لبوه', 'labwa'],
    ['قحبه', 'قحاب', 'a7ba', '2a7ba', '9a7ba', 'qa7ba', 'ka7ba'],
    ['ديوث', 'dayoth', 'dayouth'],
    ['كلب', 'كلبه', 'كلاب'],
    ['جزمه', 'جزم'],
    ['حمار', 'حماره'],
    ['وسخ', 'وسخه'],
    ['زانيه'],
    ['حرام'],
    ['زباله'],
    ['عاهره'],
    ['خنزير'],
];
const FAMILY_OF = new Map(BUILT_IN_FAMILIES.flatMap((family) => family.map((word) => [word, family])));

/** The whole built-in word a list entry belongs to: { head, words } (a word outside the lists is its own). */
export function builtInFamilyOf(word) {
    const family = FAMILY_OF.get(word);
    return family ? { head: family[0], words: [...family] } : { head: word, words: [word] };
}

// ---- patterns -------------------------------------------------------------------------
const START = '(?<!\\p{L})';
const END = '(?!\\p{L})';
const PREFIX = '(?:يا\\s?|و|ف|ب|ال|وال|بال|يال)?';
const YOUR = '(?:كوا|كو|كم|كي|ك|ها|هم|ه)';
const NEVER = '(?!)';
const alternatives = (list) => (list.length ? list.join('|') : NEVER);

const IBN_AL_LATIN = /(?<![a-z])(?:ya\s?)?(?:[ie]?bn|bint)\s?(?:[ae]?l)?\s?(?:zan(?:i|y|e|ey|iy|ee)y?(?:a|ah|eh|at)|[2]?a7ba|labwa)(?![a-z])/u;
const NOT_INSULTS = new Set(['خوله']);

const FAMILY = '(?:ام|ابو|اب|اهل|اخت|اجداد|جدود|جد|سلسفيل|عيلت|ستات)';
const FAMILY_PATTERNS = [
    // كسمك / كس امك / كسومك / كس ام ...
    new RegExp(`${START}${PREFIX}كو?س\\s?(?:ا|و)?\\s?م(?:كوا|كو|كم|كي|ك|ها|هم|ه|ي|نا|ين)?${END}`, 'u'),
    // كس اختك / كس ابوك / كس اهلك / كس دين ...
    new RegExp(`${START}${PREFIX}كو?س\\s?(?:ا?خت|ابو|اهل|دين|عيلت|خالت|عمت|مرات|جد)(?:${YOUR}|ي)?${END}`, 'u'),
    // زانيه / الزانيه / زاني
    new RegExp(`${START}${PREFIX}زاني(?:ه|ات)?${END}`, 'u'),
    // دين امك / دين ابوك (only "your")
    new RegExp(`${START}(?:و|ف)?دين\\s?(?:ام|ابو|اب|اهل|اخت|اجداد)(?:كوا|كو|كم|كي|ك)${END}`, 'u'),
    // يلعن دين ... / يلعن ابوك / يلعن ابو امك / يلعن سلسفيل اهلك
    new RegExp(`${START}(?:و|ف)?(?:ي|ا)لعن\\s?دين`, 'u'),
    new RegExp(`${START}(?:و|ف)?(?:ي|ا)لعن\\s?(?:(?:ابو|اب|سلسفيل)\\s?)?${FAMILY}${YOUR}${END}`, 'u'),
    // ميتين امك / ميتين ام / ميتين ابو(ك) / ميتين دين(ك) / ميتين اهل(ك) — never the number word alone
    new RegExp(`${START}(?:يا\\s?|و)?ميتين\\s?(?:(?:ام|ابو|اهل|دين)${YOUR}?|(?:اب|اخت|جد|اجداد|جدود|عيلت)${YOUR})${END}`, 'u'),
];
const FAMILY_LATIN = [
    /(?<![a-z])(?:ya\s?)?k[ou]?s\s?[ou]?m(?:ak|ek|ok|ik|k|kom|ko|ha|aha|hom|ahom|ena|na)?(?![a-z])/u,
    /(?<![a-z])(?:ya\s?)?k[ou]?s\s?[aoe]?(?:5|kh)t(?:ak|ek|ik|k|ha|ko|kom)?(?![a-z])/u,
    /(?<![a-z])(?:ya\s?)?k[ou]?s\s?a?bo(?:k|ki|kom|ha|ko)(?![a-z])/u,
    /(?<![a-z0-9])x\s?[ou]?m(?:ak|ek|ok|k)(?![a-z])/u,
    /(?<![a-z])(?:el|al)?\s?zan(?:i|y|e|ey|iy|ee)y?(?:a|ah|eh|at)(?![a-z])/u,
];
const YOUR_SKELETON = skeletonAlternatives(['امك', 'امكم', 'امها', 'ابوك', 'ابوكي', 'ابوكم', 'اهلك', 'اهلكم', 'اختك', 'جدك', 'دينك']);
const FAMILY_SKELETON = [
    new RegExp(`${START}متن\\s?(?:${YOUR_SKELETON})${END}`, 'u'),
    new RegExp(`${START}[يا]?لعن\\s?(?:(?:دن|اب)\\s?)?(?:${YOUR_SKELETON})${END}`, 'u'),
    new RegExp(`${START}[يا]?لعن\\s?دن`, 'u'),
    new RegExp(`${START}دن\\s?(?:${YOUR_SKELETON})${END}`, 'u'),
];

/** The built-in regex families, shown read-only by `automod` (they are patterns, not word lists). */
export const BUILT_IN_GROUPS = {
    family: [
        'كسمك / كس امك / كسومك / كس ام (وكل الضماير: كسمها، كسمكم...)',
        'كس اختك / كس ابوك / كس اهلك / كس دين...',
        'زانية / الزانية / زاني',
        'دين امك / دين ابوك / دين اهلك (مع "ك" بس)',
        'يلعن دين... / يلعن ابوك / يلعن ابو امك / يلعن سلسفيل اهلك',
        'ميتين امك / ميتين ابو / ميتين دين / ميتين اهل (رقم "ميتين" لوحده مسموح)',
        'فرانكو: ksomak, kos okhtak, kos abook, x omak, zanya, meteen omak, yel3an deenak',
    ],
    ibnAl: ['فرانكو: ebn el zanya / ebn el a7ba / ebn el labwa'],
};

// Every rule returns the matched fragment (a string) or null, so the service can hand the insult back.
const firstMatch = (patterns, texts) => {
    for (const text of texts) {
        for (const pattern of patterns) {
            const found = pattern.exec(text);
            if (found) return found[0];
        }
    }
    return null;
};
const anyMatch = (patterns, texts) => Boolean(firstMatch(patterns, texts));

/** The source tokens behind a match in a view made of `viewTokens` joined with spaces (the skeleton views). */
function tokensAt(found, viewTokens, sourceTokens) {
    if (!found) return null;
    const start = found.index;
    const end = start + found[0].length;
    const picked = [];
    let offset = 0;
    viewTokens.forEach((token, i) => {
        if (offset < end && offset + token.length > start && sourceTokens[i]) picked.push(sourceTokens[i]);
        offset += token.length + 1;
    });
    return picked.join(' ') || found[0];
}

function skeletonMatch(patterns, v) {
    for (const pattern of patterns) {
        const found = pattern.exec(v.skeleton);
        if (found) return tokensAt(found, v.skeletonTokens, v.tokens);
    }
    return null;
}

/**
 * Compiles the built-in rules. `disabled` (normalized words the owner switched off) removes words from the
 * built-in word lists; `english` adds INSULTS_ENGLISH; `custom` is a compiled list of the owner's words.
 * With no options it is exactly the original filter (the legacy set).
 */
function buildRuleSet({ disabled = new Set(), english = false, custom = null } = {}) {
    const on = (list) => list.filter((word) => !disabled.has(word));
    const insults = on(INSULTS);
    const ibnAlInsults = on(IBN_AL_INSULTS);
    const insultsLatin = on(INSULTS_LATIN);

    const ibnAlPattern = new RegExp(`${START}(?:يا\\s?|و|ف)?(?:ا?بن|بنت)\\s?(?:ال|ل)?\\s?(?:${alternatives(ibnAlInsults.map((w) => [...w].join('\\s?')))})(?:ين|ات)?${END}`, 'u');
    const ibnAlSkeleton = new RegExp(`${START}(?:ي\\s?)?(?:ا?بن|بنت)\\s?(?:ا?ل)?\\s?(?:${skeletonAlternatives(ibnAlInsults) || NEVER})(?:ن|ت)?${END}`, 'u');
    const insultPattern = new RegExp(`${START}${PREFIX}((?:${alternatives(insults)})${ENDINGS})${END}`, 'gu');
    const insultLatinPattern = new RegExp(`(?<![a-z0-9])(?:ya\\s?)?((?:${alternatives(insultsLatin)})(?:ak|ek|a|ين)?)(?![a-z0-9])`, 'gu');
    const insultSkeleton = new RegExp(`${START}(?:ي\\s?)?(?:${skeletonAlternatives(on(SKELETON_INSULTS), 4) || NEVER})(?:ك|كم|ت|ن)?${END}`, 'u');
    const englishOn = english ? INSULTS_ENGLISH.filter((entry) => !disabled.has(entry.word)) : [];

    const insultIn = (texts, minLength = 0) => {
        for (const text of texts) {
            const found = [...text.matchAll(insultPattern)].find((match) => !NOT_INSULTS.has(match[1]) && match[1].length >= minLength);
            if (found) return found[1];
        }
        return null;
    };
    const latinInsultIn = (texts, minLength = 0) => {
        for (const text of texts) {
            const found = [...text.matchAll(insultLatinPattern)].find((match) => match[1].length >= minLength);
            if (found) return found[1];
        }
        return null;
    };

    // Each returns the matched fragment or null (a skeleton match gives back the chunks it came from).
    const builtIn = {
        ibnAl: (v) => firstMatch([ibnAlPattern], v.arabic) || firstMatch([IBN_AL_LATIN], v.latin) || skeletonMatch([ibnAlSkeleton], v),
        insult: (v) => insultIn(v.arabic) || latinInsultIn(v.latin) || skeletonMatch([insultSkeleton], v)
            || insultIn(v.arabicPairs, 5) || latinInsultIn(v.latinPairs, 5)
            || tokensAt(insultSkeleton.exec(v.skeletonPairs), v.skeletonPairList, v.latinPairList),
        family: (v) => firstMatch(FAMILY_PATTERNS, v.arabic) || firstMatch(FAMILY_LATIN, v.latin) || skeletonMatch(FAMILY_SKELETON, v),
        banned: (v) => firstMatch(BANNED_WORDS, [...v.arabic, ...v.latin]),
    };
    const extra = english || custom ? compileCustomRules(custom || [], { english: englishOn }) : null;
    return { builtIn, extra, extended: Boolean(extra) };
}

const RULE_ORDER = ['ibnAl', 'insult', 'family', 'banned'];
const LEGACY = buildRuleSet();
let current = buildRuleSet({ english: true });
let currentRules = { custom: [], disabled: [] };

/**
 * Applies the owner's `automod` edits: `custom` words ({ word, rule }) and `disabled` built-in words
 * (normalized). Synchronous and never throws; bad entries are skipped. Takes effect for the next message.
 */
export function setCustomRules(rules = {}) {
    const custom = Array.isArray(rules?.custom) ? rules.custom.filter((entry) => entry && typeof entry.word === 'string' && RULE_ORDER.includes(entry.rule)) : [];
    const disabled = Array.isArray(rules?.disabled) ? rules.disabled.filter((word) => typeof word === 'string') : [];
    current = buildRuleSet({ disabled: new Set(disabled), english: true, custom });
    currentRules = { custom: custom.map((entry) => ({ ...entry })), disabled: [...disabled] };
}

/** The owner's edits as last applied (for the `automod` list). */
export function getCustomRules() {
    return { custom: currentRules.custom.map((entry) => ({ ...entry })), disabled: [...currentRules.disabled] };
}

/** Rule name (and what matched) for one text, with a given rule set. `fragment` adds the matched text itself. */
function matchOf(text, set, fragment = false) {
    const source = set.extended ? maskNames(text) : text;
    // normalizeForFilter(source) in two steps, keeping the repeated letters for the English "a$$" / "nigga" forms.
    const keepRepeats = normalizeKeepRepeats(source);
    const normalized = collapse(keepRepeats);
    if (!normalized) return null;
    const views = viewsOf(normalized);
    let extraHits;
    const extraHit = (rule) => {
        if (!set.extra) return null;
        extraHits ??= matchCustom(set.extra, views, keepRepeats);
        return extraHits.get(rule) || null;
    };
    for (const rule of RULE_ORDER) {
        const found = set.builtIn[rule](views);
        if (found) return fragment ? { rule, source: 'builtin', fragment: found } : { rule, source: 'builtin' };
        const hit = extraHit(rule);
        if (hit) return fragment ? { rule, source: hit.source, word: hit.word, fragment: hit.word } : { rule, source: hit.source, word: hit.word };
    }
    return null;
}

// The path/query of a link holds random ids ("watch?v=ksmk123", invite codes), so a match that lies
// entirely inside the path of a valid ASCII link is ignored. The host, the text around the link and any
// non-ASCII path are always checked ("https://ksomak", "www.kosomak.com", "discord.gg/ibn el gazma").
const LINK = /(?:\bhttps?:\/\/|\bwww\.|\b(?=discord(?:app)?\.(?:gg|com)\/))([^\s/?#]+)([/?#]\S*)?/giu;
const ASCII_HOST = /^[a-z0-9.-]+(?::\d+)?$/iu;
const ASCII_PATH = /^[\x21-\x7e]*$/u;

function explainWith(text, set, fragment = false) {
    const raw = String(text || '');
    const paths = [];
    const stripped = raw.replace(LINK, (link, host, path = '') => {
        if (!path || !ASCII_HOST.test(host) || !ASCII_PATH.test(path)) return link;
        paths.push(path);
        return link.slice(0, link.length - path.length) + ' ';
    });
    const match = matchOf(stripped, set, fragment);
    if (match || !paths.length) return match;
    // Only a link path changed the answer: ignore it when that path alone explains the match.
    const withPaths = matchOf(raw, set, fragment);
    return withPaths && !paths.some((path) => matchOf(path, set)) ? withPaths : null;
}

/**
 * Strongest matched rule, without a role bypass or any side effects: the built-in lists, the English insults and
 * the owner's `automod` edits (every server). `legacy: true` uses only the original built-in lists.
 */
export function checkText(text, { legacy = false } = {}) {
    return explainWith(text, legacy ? LEGACY : current)?.rule ?? null;
}

/** Like checkText, with where the match came from: { rule, source: 'builtin'|'english'|'custom', word? } or null. */
export function explainText(text, { legacy = false } = {}) {
    return explainWith(text, legacy ? LEGACY : current);
}

/**
 * Like explainText (current rules), plus `fragment`: the matched text itself, normalized (a built-in match gives the
 * normalized Arabic or franco words as written, an `automod` / English match gives the listed word). Null when clean.
 */
export function matchedFragment(text) {
    return explainWith(text, current, true);
}
