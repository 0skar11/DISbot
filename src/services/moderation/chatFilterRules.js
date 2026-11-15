// Pure word policy shared by chat moderation and company names. Permission/trust
// exemptions and punishments belong to chatFilterService, not this matcher (the rule
// table is documented at the top of chatFilterService.js).
//
// Every message is looked at through several "views" so hidden spellings are caught:
//   • arabic   — normalized text (see normalizeForFilter): NFKD + no marks/tashkeel/tatweel/
//                zero-width, NFKC look-alikes (fullwidth, math alphabets, presentation forms),
//                a homoglyph map (Cyrillic/Greek/Persian), one letter shape per sound, runs of
//                1-2 letter chunks glued back ("ك.س.م.ك", "k*s*m*k"), repeated letters collapsed.
//   • mixed    — like arabic, but Latin letters, digits and $/@ inside Arabic words (and short Latin
//                chunks next to Arabic words) are spelled in Arabic ("كسmك", "ك$مك", "ks امك").
//   • latin    — Latin lists, once with franco digits kept ("3ars") and once with leetspeak
//                read as letters ("sh4rm0ta", "k0s0mak").
//   • skeleton — franco/Arabizi words as an Arabic consonant skeleton (3=ع 7=ح 5=خ 2=ء 9=ق 8=غ
//                6=ط, sh/ch=ش kh=خ gh=غ th=ث, vowels incl. ou/oo dropped), compared with the
//                skeleton of the Arabic words ("sharmoota", "ebn el gazma", "meteen omak").
// Two neighbouring chunks are also tried glued ("شر موطه") for the long insults.

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
const INSULTS_LATIN = [
    'sharmot', 'sharmota', 'metnak', 'mitnak', 'metnaka', 'manyok', 'manyak', 'khawal', 'a3ars', '3ars', 'm3ars',
    'zobr', 'zeby', 'teez', 'tez', 'labwa', 'a7ba',
    // franco spellings of the same words (repeated letters are collapsed first: "sharmoota" → "sharmota")
    'sharmouta', 'shrmota', 'metnaka', 'mtnak', 'manyouk', 'manyoka', 'mnyok', 'khawl', 'khwal', '5awal', '5wal', 'khawalat', '5awalat',
    'me3ars', 'mo3ars', 'm3rs', 'm3arsin', 'dayoth', 'dayouth', 'zobry', '2a7ba', '9a7ba', 'qa7ba', 'ka7ba',
    'anikak', 'anekak', 'hanikak', 'hanekak',
];

// "الحفره" used to be here; it is allowed now (in every server). Add patterns here to delete a word without punishment.
export const BANNED_WORDS = [];

const HOMOGLYPHS = {
    // Cyrillic
    а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
    ѕ: 's', і: 'i', ї: 'i', ј: 'j', һ: 'h', ԁ: 'd', ӏ: 'l', ո: 'n', ս: 'u',
    // Greek
    α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o', ρ: 'p', σ: 's', ς: 's', τ: 't', υ: 'u', χ: 'x', ω: 'w',
    // Persian/Urdu letter shapes and the wasla
    ک: 'ك', ڪ: 'ك', گ: 'ج', ی: 'ي', ې: 'ي', ۍ: 'ي', ے: 'ي', ہ: 'ه', ھ: 'ه', ۃ: 'ه', ٱ: 'ا', ة: 'ه', ى: 'ي',
    // Arabic-Indic digits
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

const collapse = (s) => s.replace(/([\p{L}\p{N}$@])\1+/gu, '$1');

/** Lowercase, no tashkeel/tatweel/invisibles, look-alikes unified, short chunks glued and no repeats. */
export function normalizeForFilter(text) {
    let s = String(text || '').toLowerCase().normalize('NFKD')
        .replace(/[\p{M}\p{Cf}ـ]/gu, '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\x00-\x7f]/gu, (ch) => HOMOGLYPHS[ch] ?? ch)
        .replace(/[أإآ]/gu, 'ا')
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
    return collapse(glued.join(' '));
}

const ARABIC = /\p{Script=Arabic}/u;
const LATINISH = /[a-z0-9$@]/u;

// ---- franco → Arabic ------------------------------------------------------------------
const DIGRAPHS = { sh: 'ش', ch: 'ش', kh: 'خ', gh: 'غ', th: 'ث', dh: 'ذ' };
// With vowels, for Latin chunks inside Arabic text ("كسmك", "ks امك").
const SPELL = {
    a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن',
    o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز',
    2: '', 3: 'ع', 4: 'ا', 5: 'خ', 6: 'ط', 7: 'ح', 8: 'غ', 9: 'ق', 0: 'و', 1: 'ي', $: 'س', '@': 'ا',
};
function spellInArabic(word) {
    let out = '';
    for (let i = 0; i < word.length;) {
        const pair = DIGRAPHS[word.slice(i, i + 2)];
        if (pair) {
            out += pair;
            i += 2;
            continue;
        }
        const ch = word[i];
        out += i === 0 && 'aeiou'.includes(ch) ? 'ا' : SPELL[ch] ?? ch;
        i += 1;
    }
    return collapse(out);
}

// Consonant skeleton: both sides use one letter per sound and drop vowels (except a word-initial one).
const SKELETON_MERGE = { ق: 'ك', ص: 'س', ط: 'ت', ض: 'د', ظ: 'ز', ذ: 'ز', ه: 'ح', ء: '', أ: 'ا' };
function arabicSkeleton(word) {
    const s = word.replace(/ه$/u, '').replace(/./gu, (ch) => SKELETON_MERGE[ch] ?? ch);
    return collapse(s.slice(0, 1) + s.slice(1).replace(/[اويى]/gu, ''));
}
const SKELETON_LATIN = {
    b: 'ب', p: 'ب', t: 'ت', 6: 'ت', g: 'ج', j: 'ج', h: 'ح', 7: 'ح', 5: 'خ', d: 'د', r: 'ر', z: 'ز', s: 'س',
    c: 'ك', k: 'ك', q: 'ك', 9: 'ك', f: 'ف', v: 'ف', l: 'ل', m: 'م', n: 'ن', 3: 'ع', 8: 'غ', x: 'كس',
};
const SKELETON_DIGRAPHS = { sh: 'ش', ch: 'ش', kh: 'خ', gh: 'غ', th: 'ث', dh: 'ز' };
function francoSkeleton(word) {
    const w = word.replace(/\$/gu, 's').replace(/@/gu, 'a').replace(/0/gu, 'o').replace(/1/gu, 'i').replace(/4/gu, 'a')
        .replace(/(?<=[aeiou])h$/u, '');
    let out = '';
    for (let i = 0; i < w.length;) {
        const pair = SKELETON_DIGRAPHS[w.slice(i, i + 2)];
        if (pair) {
            out += pair;
            i += 2;
            continue;
        }
        const ch = w[i];
        if ('aeiouyw2'.includes(ch)) {
            if (i === 0) out += ch === 'w' ? 'و' : ch === 'y' ? 'ي' : 'ا';
        } else {
            out += SKELETON_LATIN[ch] ?? '';
        }
        i += 1;
    }
    return collapse(out);
}
const skeletonAlternatives = (words, min = 3) => [...new Set(words.map(arabicSkeleton))].filter((s) => s.length >= min).join('|');

function leet(text) {
    return collapse(text.replace(/0/gu, 'o').replace(/1/gu, 'i').replace(/3/gu, 'e').replace(/4/gu, 'a')
        .replace(/5/gu, 's').replace(/7/gu, 't').replace(/\$/gu, 's').replace(/@/gu, 'a'));
}
function latinOf(text) {
    return text.replace(/\$/gu, 's').replace(/0/gu, 'o').replace(/@/gu, 'a');
}

// ---- patterns -------------------------------------------------------------------------
const START = '(?<!\\p{L})';
const END = '(?!\\p{L})';
const PREFIX = '(?:يا\\s?|و|ف|ب|ال|وال|بال|يال)?';
const YOUR = '(?:كوا|كو|كم|كي|ك|ها|هم|ه)';

const IBN_AL_PATTERN = new RegExp(`${START}(?:يا\\s?|و|ف)?(?:ا?بن|بنت)\\s?(?:ال|ل)?\\s?(?:${IBN_AL_INSULTS.map((w) => [...w].join('\\s?')).join('|')})(?:ين|ات)?${END}`, 'u');
const IBN_AL_LATIN = /(?<![a-z])(?:ya\s?)?(?:[ie]?bn|bint)\s?(?:[ae]?l)?\s?(?:zan(?:i|y|e|ey|iy|ee)y?(?:a|ah|eh|at)|[2]?a7ba|labwa)(?![a-z])/u;
const IBN_AL_SKELETON = new RegExp(`${START}(?:ي\\s?)?(?:ا?بن|بنت)\\s?(?:ا?ل)?\\s?(?:${skeletonAlternatives(IBN_AL_INSULTS)})(?:ن|ت)?${END}`, 'u');

const INSULT_PATTERN = new RegExp(`${START}${PREFIX}((?:${INSULTS.join('|')})${ENDINGS})${END}`, 'gu');
const NOT_INSULTS = new Set(['خوله']);
const INSULT_LATIN_PATTERN = new RegExp(`(?<![a-z0-9])(?:ya\\s?)?((?:${INSULTS_LATIN.join('|')})(?:ak|ek|a|ين)?)(?![a-z0-9])`, 'gu');
// Only the long, unambiguous words: short skeletons (خول → "خل", منيوك → "منك") collide with normal words.
const INSULT_SKELETON = new RegExp(`${START}(?:ي\\s?)?(?:${skeletonAlternatives(['شرموط', 'شراميط', 'متناك'], 4)})(?:ك|كم|ت|ن)?${END}`, 'u');

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

/** The views every rule is checked against (see the top of this file). */
function viewsOf(normalized) {
    const tokens = normalized.split(' ');
    const isArabic = tokens.map((t) => ARABIC.test(t));
    const mixedTokens = tokens.map((t, i) => {
        if (isArabic[i]) return LATINISH.test(t) ? spellInArabic(t) : t;
        const nearArabic = isArabic[i - 1] || isArabic[i + 1];
        return nearArabic && t.length <= 3 && /[a-z]/u.test(t) ? spellInArabic(t) : t;
    });
    const skeletonTokens = tokens.map((t, i) => (!isArabic[i] && /[a-z]/u.test(t) ? francoSkeleton(t) : '_'));
    const pairs = (list) => list.slice(1).map((t, i) => collapse(list[i] + t));
    const latinTokens = tokens.filter((t, i) => !isArabic[i]);
    return {
        arabic: [normalized, mixedTokens.join(' ')],
        arabicPairs: [...pairs(tokens), ...pairs(mixedTokens)],
        latin: [latinOf(normalized), leet(normalized)],
        latinPairs: pairs(latinTokens).flatMap((t) => [latinOf(t), leet(t)]),
        skeleton: skeletonTokens.join(' '),
        skeletonPairs: pairs(latinTokens).map(francoSkeleton),
    };
}

const anyMatch = (patterns, texts) => texts.some((text) => patterns.some((pattern) => pattern.test(text)));
function insultIn(text, minLength = 0) {
    return [...text.matchAll(INSULT_PATTERN)].some((match) => !NOT_INSULTS.has(match[1]) && match[1].length >= minLength);
}
function latinInsultIn(text, minLength = 0) {
    return [...text.matchAll(INSULT_LATIN_PATTERN)].some((match) => match[1].length >= minLength);
}

const RULE_CHECKS = [
    ['ibnAl', (v) => anyMatch([IBN_AL_PATTERN], v.arabic) || anyMatch([IBN_AL_LATIN], v.latin) || IBN_AL_SKELETON.test(v.skeleton)],
    ['insult', (v) => v.arabic.some((t) => insultIn(t)) || v.latin.some((t) => latinInsultIn(t)) || INSULT_SKELETON.test(v.skeleton)
        || v.arabicPairs.some((t) => insultIn(t, 5)) || v.latinPairs.some((t) => latinInsultIn(t, 5))
        || v.skeletonPairs.some((t) => INSULT_SKELETON.test(t))],
    ['family', (v) => anyMatch(FAMILY_PATTERNS, v.arabic) || anyMatch(FAMILY_LATIN, v.latin) || anyMatch(FAMILY_SKELETON, [v.skeleton])],
    ['banned', (v) => anyMatch(BANNED_WORDS, [...v.arabic, ...v.latin])],
];

// Links (and the random ids inside them) are not words.
const LINKS = /\b(?:https?:\/\/|www\.|discord(?:\.gg|app\.com\/invite|\.com\/invite)\/)\S+/giu;

/** Strongest matched rule, without a role bypass or any side effects. */
export function checkText(text) {
    const normalized = normalizeForFilter(String(text || '').replace(LINKS, ' '));
    if (!normalized) return null;
    const views = viewsOf(normalized);
    for (const [rule, matches] of RULE_CHECKS) if (matches(views)) return rule;
    return null;
}
