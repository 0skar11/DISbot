// Pure word policy shared by chat moderation and company names. Permission/trust
// exemptions and punishments belong to chatFilterService, not this matcher.
export const IBN_AL_ALLOWED = ['الحلال', 'الناس', 'الاصول', 'العم', 'الخال', 'البلد', 'الجيران', 'الحته', 'الحاره'];

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
const INSULTS_LATIN = ['sharmot', 'sharmota', 'metnak', 'mitnak', 'metnaka', 'manyok', 'manyak', 'khawal', 'a3ars', '3ars', 'm3ars', 'zobr', 'zeby', 'teez', 'tez', 'labwa', 'a7ba'];

export const BANNED_WORDS = [/(?<!\p{L})ال\s?حفره(?!\p{L})/u, /(?<![a-z])[ae]l\s?7ofr?a(?![a-z])/u];

/** Lowercase, no tashkeel/tatweel/invisibles, consistent letter shapes and no repeats. */
export function normalizeForFilter(text) {
    let s = String(text || '').toLowerCase()
        .replace(/[ً-ٰٟـ​-‏‪-‮⁠﻿]/gu, '')
        .replace(/[أإآٱ]/gu, 'ا')
        .replace(/ة/gu, 'ه')
        .replace(/ى/gu, 'ي')
        .replace(/ؤ/gu, 'و')
        .replace(/ئ/gu, 'ي');
    const tokens = s.split(/[^\p{L}\p{N}$@]+/u).filter(Boolean);
    const glued = [];
    let run = '';
    for (const token of tokens) {
        if (token.length <= 2) {
            run += token;
            continue;
        }
        if (run) glued.push(run);
        run = '';
        glued.push(token);
    }
    if (run) glued.push(run);
    s = glued.join(' ');
    return s.replace(/(\p{L})\1+/gu, '$1');
}

function latinOf(text) {
    return text.replace(/\$/gu, 's').replace(/0/gu, 'o').replace(/@/gu, 'a');
}

const START = '(?<!\\p{L})';
const END = '(?!\\p{L})';
const PREFIX = '(?:يا\\s?|و|ف|ب|ال|وال|بال|يال)?';
const KOSOMAK_PATTERNS = [
    new RegExp(`${START}${PREFIX}كس\\s?(?:ا|و)?\\s?م`, 'u'),
    new RegExp(`${START}${PREFIX}كس\\s?ا?خت`, 'u'),
    new RegExp(`${START}${PREFIX}كس\\s?ابو`, 'u'),
    /(?<![a-z])k[ou]?s+\s?[ou]?m+(?:[ao]k|k|ak)?(?![a-z]{2})/u,
    /(?<![a-z])k[ou]?s+\s?[ou]?(?:5|kh)t/u,
];
const IBN_AL_ARABIC = new RegExp(`${START}(?:يا\\s?)?ا?بن\\s?ال(\\p{L}*)`, 'gu');
const IBN_AL_LATIN = /(?<![a-z])(?:ya\s?)?[ie]?bn\s?[ae]l\s?[a-z0-9]{2,}/u;
const INSULT_PATTERN = new RegExp(`${START}${PREFIX}((?:${INSULTS.join('|')})${ENDINGS})${END}`, 'gu');
const NOT_INSULTS = new Set(['خوله']);
const INSULT_LATIN_PATTERN = new RegExp(`(?<![a-z0-9])(?:ya\\s?)?(?:${INSULTS_LATIN.join('|')})(?:ak|ek|a|ين)?(?![a-z0-9])`, 'u');

function hasIbnAl(text) {
    for (const match of text.matchAll(IBN_AL_ARABIC)) {
        if (!match[1] || !IBN_AL_ALLOWED.includes(`ال${match[1]}`)) return true;
    }
    return IBN_AL_LATIN.test(latinOf(text));
}

/** Strongest matched rule, without a role bypass or any side effects. */
export function checkText(text) {
    const normalized = normalizeForFilter(text);
    if (!normalized) return null;
    const latin = latinOf(normalized);
    if (KOSOMAK_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(latin))) return 'kosomak';
    if (hasIbnAl(normalized)) return 'ibnAl';
    if ([...normalized.matchAll(INSULT_PATTERN)].some((match) => !NOT_INSULTS.has(match[1])) || INSULT_LATIN_PATTERN.test(latin)) return 'insult';
    if (BANNED_WORDS.some((pattern) => pattern.test(normalized) || pattern.test(latin))) return 'banned';
    return null;
}
