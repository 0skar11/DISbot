// chatFilterVariants.js — the spellings the bot adds by itself for the owner's own `automod` words, and the
// matcher that looks for them (and for the built-in English insults) in a message. Pure, no I/O.
//
// For every word the owner adds (automodStore.js) the bot generates and matches, without the owner typing them:
//   • the normalized Arabic form, with all the hidden spellings normalizeForFilter already undoes (spaces /
//     dots / symbols between letters, tashkeel, tatweel, zero-width, repeated letters, look-alike letters,
//     Latin letters inside the word) and the usual prefixes / endings (يا، ال، و / ك، ه، ها، كم...);
//   • franco / Arabizi spellings (ع=3/a, ح=7/h, خ=5/kh, ق=2/q/k/g/9, ص=s/9, ط=6/t, غ=gh/8, ش=sh/ch, ث=s/th,
//     ذ=z/d, ظ=z/6, ة=a/ah/eh, ي=y/i/ee, و=o/ou/oo/w, short vowels optional, "el" for ال), matched after a
//     franco fold so the many vowel spellings collapse to one ("sharmoota" = "sharmouta" = "sharmootah");
//     long words (4+ consonants) also through their consonant skeleton;
//   • the reverse: a franco / Latin word also matches its Arabic spellings ("kalb" → كلب، كالب);
//   • English equivalents from a small dictionary (كلب → dog, شرموطة → slut / whore, عرص → pimp...) with
//     their obfuscations (leetspeak, f*ck → fck, fvck, phuck, a$$, dicc). Everyday words (dog, donkey, pig,
//     trash, stupid...) only count right after "you / u / ya / stupid / dirty..." so "my dog" is fine.
// Short words are kept tight on purpose: no franco vowels are inserted in words under 3 letters, a word
// under 5 letters is never glued from two chunks, and franco / skeleton matches skip common English words.

import {
    ARABIC, arabicSkeleton, collapseToken, francoSkeleton, memoize, normalizeForFilter, normalizeKeepRepeats,
} from './chatFilterText.js';

export const MAX_VARIANTS = 160;
const FRANCO_CAP = 64;
const PHRASE_WORD_CAP = 12;
const REVERSE_CAP = 24;
const ENGLISH_CAP = 40;

// ---- common English words: franco / skeleton matches never fire on them ------------------
const COMMON_WORDS = `a about above after again all also am an and any are as at be because been before being below
between both but by can come could day did do does doing down during each even every few for from get give go
going good got had has have having he her here hers him his how i if in into is it its just know like look make
man many me more most much must my new no nor not now of off old on once one only or other our out over own people
same say see she should so some such take tell than that the their them then there these they thing think this
those through time to too two under until up us use very want was way we well were what when where which while who
whom why will with would year yes yet you your yours back big bad best better big bit boy call came car case cat
cause class cool cosmic dad did dog done eat end ever eye fact fall far feel fine first five fix four friend full
fun game gave girl god guy hand hard head hear hello help hey hi high hit hold home hope hot house idea job keep
kid kill kind kiss last late left less let life line list little live long lost lot love mad made mail main mask
mean meet mind miss mom more move music name need next nice night nick note nothing number ok okay open order page
part pass pay phone pick place plan play please point post put real right room run said sad saw school score
send set show side sign since small sorry start stay still stop story sure talk team test text thank thanks those
three told took top true try turn type wait walk war watch water week went white whole win word work world wow
wrong yeah zebra able act add age ago air almost alone along already always among angry another answer anyone
area arm army art ask away baby ball bank base bed beer bell bin bird black blue boat body book born box break
bring brother brown build bus buy cake camp cap card care carry catch chair chance change check child city clean
clear close club coat cold color cook cost count cup cut dark data dead deal dear deep door draw dream dress drink
drive drop dry early earth east easy edge egg else enjoy enough enter even exam face fair fan farm fast fat
fear field fight fill film find fire fish flat floor fly food foot force form free fresh front fruit funny gas
gift glass gold green ground group grow gun hair half hall hang happy hat heart heat heavy hill hole horse hour
huge human hurt ice ill inch iron island join joke jump just key king knee lady lake land large laugh law lay lead
learn leg lie lift light lip long loud low lunch map mark market math matter meal meat middle milk mine minute
model money month moon morning mother mouth nail near neck news noise none nose ocean office oil open pack pain
pair paper park party past path peace pen pie pig pink plane plant plate pool poor pop power press price pull push
quick quiet race rain rate read red rest rice rich ride ring river road rock roof rose round rule safe salt sand
save sea seat sell shape share ship shirt shoe shop shot shut sick silver sing sir sit size skin sky sleep slow
smile snow soft son song soon sound soup south space speak speed spend sport spring star step stone store street
strong study sugar summer sun swim table tall taste tea teach tear term thin throw tie tired today tomorrow tone
tool tooth touch town toy track train tree trip truck tv uncle upon usual value video view visit voice vote wall
warm wash wave wear weather west wet wheel wide wild wind window wine wing winter wire wish woman wood wool yard
yellow young lol lmao omg idk tbh ngl smh btw wtf pls plz thx ty np gg wp ez brb afk irl cnt slt bro sis dude
yo ya yah yep nah nope sup hmm umm ahh ohh haha hehe xd xp cos coz cuz bc tho though kinda gonna wanna gotta
send sent mars humor hammer kaleb caleb club kale mosque comic camel kebab salad sale sold`;
const COMMON_LATIN = new Set(COMMON_WORDS.split(/\s+/u).filter(Boolean).map(collapseToken));
const isCommonLatin = (token) => COMMON_LATIN.has(token);

// ---- folds ------------------------------------------------------------------------------
const FOLD = { 7: 'h', 6: 't', 5: 'kh', 8: 'gh', 4: 'a', 1: 'e', q: 'k', u: 'o', i: 'e', x: 'ks' };
const FOLD_PAIRS = { ch: 'sh', dh: 'z', ph: 'f' };
const FOLDED_VOWEL = new Set(['a', 'e', 'o']);

/**
 * One spelling per sound for franco tokens, applied to message tokens and to generated spellings alike:
 * 7→h 6→t 5→kh 8→gh 4→a 1→e q→k u→o i→e x→ks ch→sh dh→z ph→f, a vowel "y" → e, repeats collapsed and a
 * final "h" after a vowel dropped ("sharmouta" = "sharmoota" = "sharmootah" → "sharmota").
 */
export const francoFold = memoize(function francoFold(token) {
    let out = '';
    for (let i = 0; i < token.length; i += 1) {
        const ch = token[i];
        const pair = FOLD_PAIRS[ch + (token[i + 1] || '')];
        if (pair) {
            out += pair;
            i += 1;
            continue;
        }
        if (ch === 'y') {
            const next = token[i + 1];
            out += next !== undefined && FOLDED_VOWEL.has(FOLD[next] ?? next) ? 'y' : 'e';
            continue;
        }
        out += FOLD[ch] ?? ch;
    }
    out = collapseToken(out);
    return out.length > 2 && out.endsWith('h') && FOLDED_VOWEL.has(out[out.length - 2]) ? out.slice(0, -1) : out;
});

/** Leetspeak read as letters, vowels collapsed, consonants kept doubled ("a$$" → "ass", "n1gggga" → "nigga"). */
export const doubleFold = memoize(function doubleFold(token) {
    return token.replace(/0/gu, 'o').replace(/1/gu, 'i').replace(/3/gu, 'e').replace(/4/gu, 'a').replace(/5/gu, 's')
        .replace(/7/gu, 't').replace(/\$/gu, 's').replace(/@/gu, 'a')
        .replace(/([aeiouy])\1+/gu, '$1').replace(/([^aeiouy])\1{2,}/gu, '$1$1');
});

const ARABIC_MERGE = { ط: 'ت', ص: 'س', ض: 'د', ظ: 'ز', ذ: 'ز', ح: 'ه', ث: 'س', ء: '' };
/** Arabic letters that franco cannot tell apart, merged (for Latin words matched against Arabic text). */
export const arabicMerge = memoize(function arabicMerge(word) {
    return collapseToken(word.replace(/[طصضظذحثء]/gu, (ch) => ARABIC_MERGE[ch]));
});

// ---- Arabic → franco --------------------------------------------------------------------
const FRANCO_LETTERS = {
    ب: ['b'], ت: ['t'], ث: ['s', 'th', 't'], ج: ['g', 'j'], ح: ['h'], خ: ['kh'], د: ['d'], ذ: ['z', 'd'], ر: ['r'],
    ز: ['z'], س: ['s'], ش: ['sh'], ص: ['s', '9'], ض: ['d', 'z'], ط: ['t'], ظ: ['z', 't'], غ: ['gh'], ف: ['f'],
    ق: ['2', 'k', '9', 'g'], ك: ['k'], ل: ['l'], م: ['m'], ن: ['n'],
};
const SLOTS = ['', 'a', 'e', 'o'];

// [spelling, isVowel] for one letter, the most common spelling first (its index is its cost).
function francoOptions(ch, first, last) {
    switch (ch) {
        case 'ا': return first ? [['a', true], ['e', true], ['o', true]] : [['a', true]];
        case 'و': return first ? [['w', false], ['o', true]] : [['o', true], ['w', false]];
        case 'ي': return first ? [['y', false], ['e', true]] : [['e', true], ['y', false]];
        case 'ه': return last && !first ? [['a', true], ['e', true]] : [['h', false]];
        case 'ع': return [['3', false], ['a', true]];
        case 'ء': return [['2', false], ['', true]];
        default: return (FRANCO_LETTERS[ch] || [ch]).map((spelling) => [spelling, false]);
    }
}

/** Franco spellings of one normalized Arabic word, cheapest first (fewest unusual letters and added vowels). */
export function francoSpellings(word, cap = FRANCO_CAP) {
    const letters = [...word];
    if (!letters.length) return [];
    const slots = letters.length < 3 ? [''] : SLOTS;
    const found = new Map();
    let total = 20_000;
    for (let maxCost = 0; maxCost <= 6 && found.size < cap && total > 0; maxCost += 1) {
        const before = found.size;
        let budget = Math.min(6000, total);
        total -= budget;
        const visit = (i, prevConsonant, text, cost) => {
            if (budget <= 0) return;
            if (i === letters.length) {
                budget -= 1;
                const folded = francoFold(text);
                if (folded && (!found.has(folded) || found.get(folded) > cost)) found.set(folded, cost);
                return;
            }
            francoOptions(letters[i], i === 0, i === letters.length - 1).forEach(([spelling, vowel], index) => {
                const letterCost = cost + index;
                if (letterCost > maxCost) return;
                const consonant = !vowel && spelling !== '';
                if (prevConsonant && consonant) {
                    slots.forEach((slot, slotIndex) => {
                        const total = letterCost + (slotIndex ? 1 : 0);
                        if (total <= maxCost) visit(i + 1, true, text + slot + spelling, total);
                    });
                } else {
                    visit(i + 1, consonant || (prevConsonant && spelling === ''), text + spelling, letterCost);
                }
            });
        };
        visit(0, false, '', 0);
        if (found.size === before && maxCost > 0) break;
    }
    return [...found.entries()].sort((a, b) => a[1] - b[1]).slice(0, cap).map(([text]) => text);
}

// ---- Latin → Arabic (a franco / Latin word also matches its Arabic spellings) -------------
// A doubled vowel is a long vowel and is always written ("5anee2" → خانيق, never خانق); a single one may be dropped.
const LATIN_DIGRAPHS = {
    sh: ['ش'], ch: ['ش'], kh: ['خ'], gh: ['غ'], th: ['ث', 'ت'], dh: ['ذ', 'ز'], ou: ['و'], oo: ['و'], uu: ['و'], ee: ['ي'], ii: ['ي'], ei: ['ي'], aa: ['ا'],
};
const LATIN_LETTERS = {
    a: ['ا', ''], b: ['ب'], c: ['ك'], d: ['د'], e: ['ي', ''], f: ['ف'], g: ['ج'], h: ['ه'], i: ['ي', ''], j: ['ج'], k: ['ك'],
    l: ['ل'], m: ['م'], n: ['ن'], o: ['و', ''], p: ['ب'], q: ['ق'], r: ['ر'], s: ['س'], t: ['ت'], u: ['و', ''], v: ['ف'],
    w: ['و'], x: ['كس'], y: ['ي'], z: ['ز'], 2: ['ء', 'ق', ''], 3: ['ع'], 5: ['خ'], 6: ['ط'], 7: ['ح'], 8: ['غ'], 9: ['ق', 'ص'],
};

/** Arabic spellings of one Latin (franco) word, in the merged alphabet (see arabicMerge). */
export function arabicSpellings(word, cap = REVERSE_CAP) {
    const w = word.replace(/\$/gu, 's').replace(/@/gu, 'a').replace(/0/gu, 'o').replace(/1/gu, 'i').replace(/4/gu, 'a')
        .replace(/(?<=[aeiou])h$/u, '');
    const parts = [];
    for (let i = 0; i < w.length;) {
        const pair = w.slice(i, i + 2);
        const last = i + (LATIN_DIGRAPHS[pair] ? 2 : 1) >= w.length;
        if (LATIN_DIGRAPHS[pair]) {
            parts.push(i === 0 && 'aeiou'.includes(pair[0]) ? ['ا'] : LATIN_DIGRAPHS[pair]);
            i += 2;
            continue;
        }
        const ch = w[i];
        if (i === 0 && 'aeiou'.includes(ch)) parts.push(['ا']);
        else if (last && (ch === 'a' || ch === 'e') && i > 0) parts.push(['ه', ch === 'a' ? 'ا' : 'ي']);
        else parts.push(LATIN_LETTERS[ch] || [ch]);
        i += 1;
    }
    const found = new Map();
    const visit = (i, text, cost) => {
        if (found.size > cap * 8) return;
        if (i === parts.length) {
            const merged = arabicMerge(text);
            if (merged.length >= 2 && (!found.has(merged) || found.get(merged) > cost)) found.set(merged, cost);
            return;
        }
        parts[i].forEach((option, index) => visit(i + 1, text + option, cost + index));
    };
    visit(0, '', 0);
    return [...found.entries()].sort((a, b) => a[1] - b[1]).slice(0, cap).map(([text]) => text);
}

// ---- English ------------------------------------------------------------------------------
/** Obfuscated spellings of an English word or phrase (glued): fvck, phuck, fuk/fuq, b!tch → btch, bytch. */
export function englishSpellings(phrase, cap = ENGLISH_CAP) {
    const perWord = phrase.split(' ').filter(Boolean).map((word) => {
        const out = new Set([word]);
        if (word.includes('u')) out.add(word.replace(/u/gu, 'v'));
        if (word.includes('ph')) out.add(word.replace(/ph/gu, 'f'));
        if (word.startsWith('f')) out.add(`ph${word.slice(1)}`);
        if (word.includes('ck')) for (const r of ['k', 'q']) out.add(word.replace(/ck/gu, r));
        if (/[a-z]i[a-z]/u.test(word)) out.add(word.replace(/(?<=[a-z])i(?=[a-z])/u, 'y'));
        // A symbol in place of one vowel disappears when the message is normalized: "f*ck" → "fck".
        [...word].forEach((ch, i) => {
            if (i === 0 || i === word.length - 1 || !'aeiou'.includes(ch)) return;
            const dropped = word.slice(0, i) + word.slice(i + 1);
            if (collapseToken(dropped).length >= 3 && !isCommonLatin(collapseToken(dropped))) out.add(dropped);
        });
        return [...out].slice(0, Math.max(3, Math.floor(cap / 2)));
    });
    let forms = [''];
    for (const options of perWord) {
        const next = [];
        for (const head of forms) for (const option of options) if (next.length < cap) next.push(head + option);
        forms = next;
    }
    return [...new Set(forms)].filter(Boolean);
}

// Strong English insults and slurs. Forms are matched as whole tokens of the leetspeak view (repeated
// letters collapsed); `double` forms are matched with doubled consonants kept, for words whose collapsed
// form is a normal word ("nigger" → "niger").
const ENGLISH_INSULTS = [
    { word: 'fuck', forms: ['fuck', 'fuk', 'fuq', 'fck', 'fcuk', 'phuck', 'phuk', 'fvck', 'fking', 'fkin', 'fkn', 'fuckface', 'fuckhead', 'fuckwit', 'fucktard', 'fuckboy'] },
    { word: 'motherfucker', forms: ['motherfucker', 'motherfuker', 'mothafucka', 'muthafucka', 'mothafucker', 'muthafucker', 'motherfucka', 'motherfucking', 'motherfuckin', 'mothafuckin'] },
    { word: 'bitch', forms: ['bitch', 'biatch', 'bytch', 'btch', 'biotch', 'bitchass', 'sonofabitch', 'sonofbitch', 'sonuvabitch'] },
    { word: 'cunt', forms: ['cunt', 'cvnt'] },
    { word: 'whore', forms: ['whore', 'whor', 'whre'] },
    { word: 'slut', forms: ['slut', 'slvt'] },
    { word: 'dick', forms: ['dick', 'dck', 'dickhead', 'dickface'], double: ['dicc', 'dikk'] },
    { word: 'pussy', forms: ['pussy', 'pussies'] },
    { word: 'asshole', forms: ['asshole', 'azzhole', 'arsehole', 'asswipe', 'asshat'] },
    { word: 'dumbass', forms: ['dumbass', 'dumass', 'jackass', 'fatass'] },
    { word: 'bastard', forms: ['bastard', 'bastrd', 'basterd'] },
    { word: 'nigger', forms: [], double: ['nigger', 'nigga', 'niggah', 'nigguh', 'niggaz', 'niggers', 'niggas', 'sandnigger', 'sandnigga'] },
    { word: 'faggot', forms: ['faggot', 'fagot', 'faggit', 'fag'] },
    { word: 'retard', forms: ['retard', 'retarded'] },
    { word: 'twat', forms: ['twat'] },
    { word: 'wanker', forms: ['wanker', 'wank'] },
    { word: 'cocksucker', forms: ['cocksucker', 'cocksucka', 'cocksuka'] },
    { word: 'skank', forms: ['skank'] },
    { word: 'tranny', forms: ['tranny', 'trannie', 'trannies'] },
    { word: 'raghead', forms: ['raghead', 'towelhead'] },
    { word: 'wetback', forms: ['wetback'] },
];

/** The built-in English list: [{ word, forms, double }], forms already collapsed. */
export function englishBuiltIns() {
    return ENGLISH_INSULTS.map((entry) => Object.freeze({
        word: entry.word,
        forms: Object.freeze([...new Set(entry.forms.map(collapseToken))]),
        double: Object.freeze([...new Set((entry.double || []).map(doubleFold))]),
    }));
}

// Arabic insult → English equivalents. `true` = an everyday word: it only counts as an insult right after
// "you / u / ya / stupid / dirty..." ("you dog" yes, "my dog" no).
const ENGLISH_EQUIVALENTS = {
    كلب: [['dog', true], ['dawg', true], ['mutt', true]],
    كلبه: [['bitch'], ['dog', true]],
    كلاب: [['dogs', true]],
    حمار: [['donkey', true], ['ass', true]],
    حماره: [['donkey', true]],
    خنزير: [['pig', true], ['swine', true]],
    بقره: [['cow', true]],
    قرد: [['monkey', true], ['ape', true]],
    حيوان: [['animal', true], ['beast', true]],
    بهيم: [['animal', true], ['beast', true]],
    زباله: [['trash', true], ['garbage', true]],
    وسخ: [['scum'], ['dirty', true], ['filthy', true]],
    وسخه: [['scum'], ['dirty', true], ['filthy', true]],
    قذر: [['scum'], ['filthy', true]],
    غبي: [['stupid', true], ['idiot', true], ['dumb', true], ['moron']],
    اهبل: [['idiot', true], ['fool', true]],
    عبيط: [['idiot', true], ['fool', true]],
    متخلف: [['retard'], ['retarded']],
    شرموط: [['slut'], ['whore'], ['manwhore']],
    شرموطه: [['slut'], ['whore']],
    شراميط: [['sluts'], ['whores']],
    قحبه: [['whore'], ['slut'], ['hooker']],
    عاهره: [['whore'], ['prostitute'], ['hooker']],
    لبوه: [['slut'], ['whore']],
    زانيه: [['whore'], ['slut']],
    عرص: [['pimp']],
    معرص: [['pimp']],
    خول: [['faggot'], ['fag']],
    ديوث: [['cuck'], ['cuckold']],
    زب: [['dick'], ['cock']],
    زبي: [['dick'], ['cock']],
    زبر: [['dick'], ['cock']],
    طيز: [['ass'], ['butt', true]],
    كس: [['cunt'], ['pussy']],
    نيك: [['fuck']],
    انيك: [['fuck']],
    منيك: [['fucker']],
    متناك: [['fucker'], ['motherfucker'], ['fucked']],
    متناكه: [['fucker'], ['fucked']],
    منيوك: [['fucker'], ['fucked']],
    منيوكه: [['fucker'], ['fucked']],
    جزمه: [['shoe', true]],
    حقير: [['scumbag'], ['lowlife']],
    واطي: [['lowlife']],
    تافه: [['loser', true]],
    فاشل: [['loser', true]],
    حرام: [['bastard']],
};
const EQUIVALENT_SKELETONS = new Map();
for (const [arabic, list] of Object.entries(ENGLISH_EQUIVALENTS)) {
    const skeleton = arabicSkeleton(arabic);
    if (skeleton.length >= 3 && !EQUIVALENT_SKELETONS.has(skeleton)) EQUIVALENT_SKELETONS.set(skeleton, list);
}
const IBN_PHRASES = { 'ابن كلب': [['son of a bitch'], ['son of a dog']], 'بنت كلب': [['bitch']], 'ابن حرام': [['bastard']] };

const ARABIC_PREFIXES = ['وال', 'بال', 'فال', 'يال', 'يا', 'ال', 'و', 'ف', 'ب'];
const ARABIC_ENDINGS = ['كوا', 'كو', 'كم', 'ها', 'هم', 'ين', 'ات', 'اك', 'ك', 'ه'];
const stripArticle = (word) => word.replace(/^(?:يا|و|ف)?ال(?=..)/u, '');

/** English equivalents ([english, everyday]) of an Arabic word (normalized) or of a franco word (by its skeleton). */
function englishEquivalents(normalized, latin) {
    if (latin) {
        if (normalized.includes(' ')) return [];
        const skeleton = francoSkeleton(normalized);
        return skeleton.length >= 3 ? EQUIVALENT_SKELETONS.get(skeleton) || [] : [];
    }
    if (IBN_PHRASES[normalized]) return IBN_PHRASES[normalized];
    const ibn = normalized.match(/^(?:يا ?)?(ابن|بن|بنت) (.+)$/u);
    if (ibn) return equivalentsOfWord(ibn[2]).map(([english]) => [`${ibn[1] === 'بنت' ? 'daughter' : 'son'} of a ${english}`]);
    if (normalized.includes(' ')) return [];
    return equivalentsOfWord(normalized);
}
function equivalentsOfWord(word) {
    return ENGLISH_EQUIVALENTS[word] || ENGLISH_EQUIVALENTS[stripArticle(word)] || [];
}

// ---- variants -------------------------------------------------------------------------------
export const RULES = ['family', 'ibnAl', 'insult', 'banned'];
const LATIN_ONLY = /^[a-z0-9 ]+$/u;
const IBN_HEAD = /^(?:(?:يا ?)?(?:ابن|بن|بنت|يابن|يبن) (?:ال)?|(?:ya ?)?(?:ebn|ibn|bn|bint|bent) (?:el |al |l )?)/u;

/** The word as the filter sees it: normalized, and for "ابن ال..." only the insult after it. */
export function normalizeCustomWord(word, rule = 'insult') {
    let normalized = normalizeForFilter(word).replace(/\$/gu, 's').replace(/@/gu, 'a');
    if (rule === 'ibnAl') normalized = normalized.replace(IBN_HEAD, '').replace(/^ال(?=..)/u, '').trim();
    return normalized;
}

const groupCache = new Map();
const GROUP_CACHE_SIZE = 2000;

/**
 * Every spelling the filter uses for one owner word, by kind:
 * { word, rule, normalized, script, arabic, francoForms, arabicFromLatin, skeleton, english, englishEveryday,
 *   englishDouble, englishDoubleEveryday, spans, heads }. Phrases are glued (the filter glues neighbouring chunks of a message the same
 * way); `spans` says over how many message chunks a glued phrase form may be spread.
 */
export function variantGroups(word, rule = 'insult') {
    const safeRule = RULES.includes(rule) ? rule : 'insult';
    const key = `${safeRule}\u0000${word}`;
    if (groupCache.has(key)) return groupCache.get(key);
    const groups = buildGroups(String(word ?? ''), safeRule);
    if (groupCache.size >= GROUP_CACHE_SIZE) groupCache.delete(groupCache.keys().next().value);
    groupCache.set(key, groups);
    return groups;
}

function buildGroups(word, rule) {
    const normalized = normalizeCustomWord(word, rule);
    const words = normalized.split(' ').filter(Boolean);
    const groups = {
        word, rule, normalized, script: 'mixed', arabic: [], francoForms: [], arabicFromLatin: [], skeleton: [],
        english: [], englishEveryday: [], englishDouble: [], englishDoubleEveryday: [], spans: {},
        // The first chunk of each phrase form: a message is only glued over 3+ chunks from one of these.
        heads: { arabic: [], franco: [], arabicFromLatin: [], english: [] },
    };
    if (!words.length) return Object.freeze(groups);
    const glued = words.join('');
    const latin = LATIN_ONLY.test(normalized);
    const arabic = words.every((w) => ARABIC.test(w) && !/[a-z0-9]/u.test(w));
    groups.script = latin ? 'latin' : arabic ? 'arabic' : 'mixed';
    const span = (forms, count) => {
        if (count > 1) for (const form of forms) groups.spans[form] = Math.min(6, count + 2);
        return forms;
    };

    if (arabic) {
        groups.arabic = span([glued], words.length);
        const perWord = words.map((w) => francoSpellings(w, words.length > 1 ? PHRASE_WORD_CAP : FRANCO_CAP));
        groups.francoForms = span(productOf(perWord, FRANCO_CAP, joinCollapsed), words.length);
        if (words.length > 1) Object.assign(groups.heads, { arabic: [words[0]], franco: perWord[0] });
        if (words.length === 1 && arabicSkeleton(glued).length >= 4) groups.skeleton = [arabicSkeleton(glued)];
    } else if (latin) {
        groups.francoForms = span([words.map(francoFold).reduce(joinCollapsed, '')], words.length);
        // From the word with its repeated letters kept, so a doubled vowel stays a long vowel.
        const kept = normalizeKeepRepeats(word).replace(/\$/gu, 's').replace(/@/gu, 'a').split(' ').filter(Boolean).slice(-words.length);
        const spellFrom = kept.length === words.length ? kept : words;
        const perWord = spellFrom.map((w) => arabicSpellings(w.replace(/([^aeiou])\1+/gu, '$1').replace(/([aeiou])\1+/gu, '$1$1'), words.length > 1 ? 6 : REVERSE_CAP));
        groups.arabicFromLatin = span(productOf(perWord, REVERSE_CAP), words.length);
        if (words.length > 1) Object.assign(groups.heads, { franco: [francoFold(words[0])], arabicFromLatin: perWord[0] });
        if (words.length === 1 && francoSkeleton(glued).length >= 4) groups.skeleton = [francoSkeleton(glued)];
    } else {
        groups.arabic = span([glued], words.length);
        if (words.length > 1) groups.heads.arabic = [words[0]];
    }

    const englishWords = latin ? [[normalized, false]] : [];
    for (const [english, everyday] of groups.script === 'mixed' ? [] : englishEquivalents(normalized, latin)) {
        if (rule === 'ibnAl') {
            for (const head of ['son of a', 'son of', 'daughter of a']) englishWords.push([`${head} ${english}`, false]);
        } else {
            englishWords.push([english, Boolean(everyday)]);
        }
    }
    for (const [english, everyday] of englishWords) {
        const count = english.split(' ').length;
        for (const form of englishSpellings(english)) {
            const collapsed = collapseToken(form);
            // A word whose collapsed form is a normal word ("ass" → "as", "butt" → "but") keeps its doubled letters.
            const doubled = isCommonLatin(collapsed) && collapsed !== form;
            const list = doubled ? (everyday ? 'englishDoubleEveryday' : 'englishDouble') : everyday ? 'englishEveryday' : 'english';
            const key = doubled ? doubleFold(form) : collapsed;
            groups[list].push(key);
            if (count > 1) groups.spans[key] = Math.min(6, count + 1);
        }
        if (count > 1) groups.heads.english.push(...englishSpellings(english.split(' ')[0]).map(collapseToken));
    }
    for (const key of ['arabic', 'francoForms', 'arabicFromLatin', 'english', 'englishEveryday', 'englishDouble', 'englishDoubleEveryday']) {
        groups[key] = [...new Set(groups[key])].filter((form) => form.length >= 2);
    }
    // Never more than MAX_VARIANTS spellings for one word: franco is trimmed first, then the reverse Arabic.
    let total = countOf(groups);
    while (total > MAX_VARIANTS && groups.francoForms.length > 8) {
        groups.francoForms.pop();
        total -= 1;
    }
    while (total > MAX_VARIANTS && groups.arabicFromLatin.length > 4) {
        groups.arabicFromLatin.pop();
        total -= 1;
    }
    for (const key of ['arabic', 'francoForms', 'arabicFromLatin', 'skeleton', 'english', 'englishEveryday', 'englishDouble', 'englishDoubleEveryday']) Object.freeze(groups[key]);
    return Object.freeze(groups);
}
const countOf = (g) => g.arabic.length + g.francoForms.length + g.arabicFromLatin.length + g.skeleton.length
    + g.english.length + g.englishEveryday.length + g.englishDouble.length + g.englishDoubleEveryday.length;

/** Glues two collapsed chunks the way collapse() would ("sharm" + "mota" → "sharmota"). */
export const joinCollapsed = (a, b) => (a && b && a[a.length - 1] === b[0] ? a + b.slice(1) : a + b);
const joinPlain = (a, b) => a + b;

/** Glued combinations of per-word spellings, cheapest first (by the sum of the positions), at most `cap`. */
function productOf(lists, cap, join = joinPlain) {
    let forms = [''];
    for (const options of lists) {
        const next = [];
        for (let depth = 0; next.length < cap && depth < options.length + forms.length; depth += 1) {
            for (let i = 0; i <= depth && next.length < cap; i += 1) {
                const head = forms[i];
                const option = options[depth - i];
                if (head !== undefined && option !== undefined) next.push(join(head, option));
            }
        }
        forms = next;
    }
    return [...new Set(forms)].filter(Boolean);
}

/** The flat list of spellings the filter uses for one owner word (at most MAX_VARIANTS). */
export function generateVariants(word, rule = 'insult') {
    const g = variantGroups(word, rule);
    return [...new Set([...g.arabic, ...g.francoForms, ...g.arabicFromLatin, ...g.skeleton, ...g.english, ...g.englishEveryday, ...g.englishDouble, ...g.englishDoubleEveryday])];
}

// ---- compiled matcher --------------------------------------------------------------------------
function makeIndex() {
    return { map: new Map(), lengths: new Set(), heads: new Set(), maxLen: 0, span: 1 };
}
function addForm(index, form, ref, span = 0) {
    if (!form) return;
    let list = index.map.get(form);
    if (!list) index.map.set(form, list = []);
    const len = [...form].length;
    list.push({ ...ref, len, phrase: span > 1 });
    index.lengths.add(form.length);
    index.maxLen = Math.max(index.maxLen, form.length);
    // A long single word may be split in two chunks ("شر موطه"); a phrase spans its words and a chunk or two.
    index.span = Math.max(index.span, span > 1 ? span : len >= 5 ? 2 : 1);
}

/**
 * Compiles the owner's words ([{ word, rule }]) and the built-in English list (only the entries switched on)
 * into lookup tables for matchCustom.
 */
export function compileCustomRules(custom = [], { english = [] } = {}) {
    const index = {
        arabic: makeIndex(), merged: makeIndex(), franco: makeIndex(), english: makeIndex(), double: makeIndex(),
        skeleton: makeIndex(), skeletonArabic: makeIndex(), ibnArabic: makeIndex(), ibnMerged: makeIndex(), ibnFranco: makeIndex(),
        size: 0,
    };
    for (const entry of english) {
        const ref = { rule: 'insult', source: 'english', word: entry.word, affix: true };
        for (const form of entry.forms) addForm(index.english, form, ref);
        for (const form of entry.double) addForm(index.double, form, ref);
        index.size += 1;
    }
    for (const entry of custom) {
        const g = variantGroups(entry.word, entry.rule);
        if (!g.normalized) continue;
        const ref = { rule: g.rule, source: 'custom', word: entry.word, affix: [...g.normalized].length >= 3 };
        const add = (target, forms, extra = {}, heads = []) => {
            for (const form of forms) addForm(target, form, { ...ref, ...extra }, g.spans[form] || 0);
            for (const head of heads) target.heads.add(head);
        };
        if (g.rule === 'ibnAl') {
            add(index.ibnArabic, g.arabic);
            add(index.ibnFranco, g.francoForms);
            add(index.ibnMerged, g.arabicFromLatin);
        } else {
            add(index.arabic, g.arabic, {}, g.heads.arabic);
            add(index.franco, g.francoForms, {}, g.heads.franco);
            add(index.merged, g.arabicFromLatin, {}, g.heads.arabicFromLatin);
            add(index.skeleton, g.skeleton);
            if (g.script === 'latin') add(index.skeletonArabic, g.skeleton);
        }
        add(index.english, g.english, {}, g.heads.english);
        add(index.english, g.englishEveryday, { everyday: true }, g.heads.english);
        add(index.double, g.englishDouble, {}, g.heads.english);
        add(index.double, g.englishDoubleEveryday, { everyday: true }, g.heads.english);
        index.size += 1;
    }
    return index;
}

const FRANCO_PREFIXES = ['yal', 'ya', 'wel', 'el', 'al', 'we', 'wa'];
const FRANCO_ENDINGS = ['kom', 'aha', 'hom', 'ak', 'ek', 'ok', 'ko', 'ha', 'en', 'at', 'a', 'e'];
const ENGLISH_ENDINGS = ['ing', 'ers', 'in', 'er', 'ed', 'es', 's', 'y'];
const DOUBLE_ENDINGS = ['s', 'z'];
const SKELETON_PREFIXES = ['ال', 'ي', 'و'];
const SKELETON_ENDINGS = ['كم', 'ك', 'ت', 'ن'];
const IBN_ARABIC = ['يابنت', 'ياابن', 'يابن', 'وابن', 'فابن', 'ابن', 'بنت', 'يبن', 'بن'];
const IBN_FRANCO = ['yabn', 'yebn', 'webn', 'ebn', 'bent', 'bn'];
const ARTICLES_ARABIC = ['ال', 'ل'];
const ARTICLES_FRANCO = ['el', 'al', 'l'];
// "you dog", "ya dog", "stupid dog", "you're a dog" (normalized: "you rea dog"), "ur a dog" ("ura dog").
const EVERYDAY_CONTEXT = new Set(['you', 'u', 'ya', 'yo', 'youre', 'ure', 'ura', 'rea', 'yu', 'stupid', 'dirty', 'filthy', 'fucking',
    'fuckin', 'ugly', 'fat', 'dumb', 'lazy', 'little', 'lil', 'damn', 'bloody', 'such', 'sucha', 'يا', 'انت']);
const EVERYDAY_ARTICLE = new Set(['a', 'an']);
const EVERYDAY_BEFORE_ARTICLE = new Set(['you', 'youre', 'ure', 'ur', 'are', 'such', 'r', 'u', 'ura']);

function everydayContext(tokens, i) {
    const prev = tokens[i - 1];
    if (EVERYDAY_CONTEXT.has(prev)) return true;
    return EVERYDAY_ARTICLE.has(prev) && EVERYDAY_BEFORE_ARTICLE.has(tokens[i - 2]);
}

/**
 * Looks for a table's forms in a token list: every token, and up to `span` neighbouring tokens glued (a split
 * word or a phrase), with the given prefixes / endings taken off. Records the first hit per rule in `hits`.
 * `skip` (by index) leaves a token out on its own (common English words for the franco tables); `join` glues.
 */
function scan(tokens, table, hits, {
    prefixes = [], endings = [], skip = null, join = joinPlain, context = tokens, maxParts = Infinity, focus = null,
} = {}) {
    if (!table.map.size) return;
    const limit = table.maxLen + 6;
    const { lengths, map } = table;
    const n = tokens.length;
    const span = Math.min(Math.max(table.span, 2), maxParts);
    let i = 0;
    let parts = 0;
    let longParts = 0;
    // A short word is only glued from several chunks when at most one chunk is longer than 2 letters
    // ("b!tch" → "b" + "tch"); two real words never make up a short insult.
    const tryForm = (form, usedAffix) => {
        if (!lengths.has(form.length)) return;
        const refs = map.get(form);
        if (!refs) return;
        for (const ref of refs) {
            if (hits.has(ref.rule)) continue;
            if (parts > 1 && !ref.phrase && ref.len < 5 && longParts > 1) continue;
            if (usedAffix && !ref.affix) continue;
            if (ref.everyday && !everydayContext(context, i)) continue;
            hits.set(ref.rule, { source: ref.source, word: ref.word });
        }
    };
    const tryEndings = (form) => {
        for (const ending of endings) {
            const length = form.length - ending.length;
            if (length >= 2 && lengths.has(length) && form.endsWith(ending)) tryForm(form.slice(0, length), true);
        }
    };
    // `focus`: only the windows that touch a focused token (the mixed view only differs at a few tokens).
    let nextFocus = -1;
    for (i = 0; i < n; i += 1) {
        if (focus) {
            if (nextFocus < i) {
                nextFocus = i;
                while (nextFocus < n && !focus[nextFocus]) nextFocus += 1;
                if (nextFocus >= n) break;
            }
            if (nextFocus > i + span - 1) {
                i = nextFocus - span;
                continue;
            }
        }
        let form = '';
        longParts = 0;
        for (let k = i; k < n && k < i + span; k += 1) {
            const token = tokens[k];
            if (!token || token === '_') break;
            form = join(form, token);
            if (token.length > 2) longParts += 1;
            if (form.length > limit) break;
            parts = k - i + 1;
            if (parts > table.span && longParts > 1) break;
            // Three chunks or more only for a phrase, from its first word.
            if (parts > 2 && !table.heads.has(tokens[i])) break;
            if (parts === 1 && skip?.(k)) continue;
            tryForm(form, false);
            // A prefix (يا، ال، و / ya, el) belongs to the first chunk; an ending to the last one.
            if (parts === 1) {
                for (const prefix of prefixes) {
                    if (form.length - prefix.length < 2 || !form.startsWith(prefix)) continue;
                    const rest = form.slice(prefix.length);
                    tryForm(rest, true);
                    tryEndings(rest);
                }
            }
            tryEndings(form);
        }
    }
}

/** "ابن ال..." / "ebn el ..." followed by one of the owner's ibnAl words. */
function scanIbn(tokens, table, hits, { heads, articles, plural = [], join = joinPlain }) {
    if (!table.map.size || hits.has('ibnAl')) return;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const head = heads.find((h) => token === h || (token.startsWith(h) && token.length > h.length + 1));
        if (!head) continue;
        const rest = token.slice(head.length);
        const following = rest ? [rest, ...tokens.slice(i + 1, i + 4)] : tokens.slice(i + 1, i + 5);
        let glued = '';
        for (const part of following) {
            if (!part || part === '_') break;
            glued = join(glued, part);
            const candidates = [glued, ...articles.filter((a) => glued.startsWith(a) && glued.length > a.length + 1).map((a) => glued.slice(a.length))];
            for (const candidate of [...candidates]) {
                for (const ending of plural) if (candidate.endsWith(ending) && candidate.length > ending.length + 1) candidates.push(candidate.slice(0, -ending.length));
            }
            for (const candidate of candidates) {
                const ref = table.map.get(candidate)?.[0];
                if (ref) {
                    hits.set('ibnAl', { source: ref.source, word: ref.word });
                    return;
                }
            }
        }
    }
}

const MERGED_PREFIXES = ARABIC_PREFIXES.map((prefix) => arabicMerge(prefix));
const LATIN_TOKEN = /^[a-z0-9]+$/u;
const isArabicToken = memoize((token) => ARABIC.test(token));
const mergedToken = (t) => (isArabicToken(t) ? arabicMerge(t) : '_');
const skeletonOfArabic = memoize((t) => (isArabicToken(t) ? arabicSkeleton(stripArticle(t)) : '_'));

/**
 * The owner's words and the English insults in one message. `views` comes from viewsOf(normalized text),
 * `keepRepeats` is the same text normalized without collapsing repeated letters (same tokens, same order).
 * Returns Map<rule, { source, word }>.
 */
export function matchCustom(index, views, keepRepeats = '') {
    const hits = new Map();
    if (!index?.size) return hits;
    const { tokens, mixedTokens } = views;
    // The mixed view only differs where Latin letters were spelled in Arabic: only those windows are looked at again.
    const changed = tokens.map((t, i) => t !== mixedTokens[i]);
    const arabicLists = changed.some(Boolean) ? [[tokens, null], [mixedTokens, changed]] : [[tokens, null]];

    for (const [list, focus] of arabicLists) {
        scan(list, index.arabic, hits, { prefixes: ARABIC_PREFIXES, endings: ARABIC_ENDINGS, focus });
        scanIbn(list, index.ibnArabic, hits, { heads: IBN_ARABIC, articles: ARTICLES_ARABIC, plural: ['ين', 'ات'] });
        if (index.merged.map.size || index.ibnMerged.map.size) {
            const merged = list.map(mergedToken);
            scan(merged, index.merged, hits, { prefixes: MERGED_PREFIXES, endings: ARABIC_ENDINGS, focus });
            scanIbn(merged, index.ibnMerged, hits, { heads: IBN_ARABIC, articles: ARTICLES_ARABIC, plural: ['ين', 'ات'] });
        }
        if (index.skeletonArabic.map.size) scan(list.map(skeletonOfArabic), index.skeletonArabic, hits, { maxParts: 1, focus });
    }

    if (index.franco.map.size || index.ibnFranco.map.size) {
        const raw = views.latin[0].split(' ');
        const folded = raw.map((t) => (LATIN_TOKEN.test(t) ? francoFold(t) : '_'));
        scan(folded, index.franco, hits, {
            prefixes: FRANCO_PREFIXES, endings: FRANCO_ENDINGS, join: joinCollapsed, skip: (k) => isCommonLatin(raw[k]),
        });
        scanIbn(folded, index.ibnFranco, hits, { heads: IBN_FRANCO, articles: ARTICLES_FRANCO, plural: ['en', 'at'], join: joinCollapsed });
    }
    if (index.skeleton.map.size) {
        const skeletons = tokens.map((t, i) => (isCommonLatin(t) ? '_' : views.skeletonTokens[i]));
        // Single chunks, then neighbouring Latin chunks glued before taking the skeleton ("shar moota").
        scan(skeletons, index.skeleton, hits, { prefixes: SKELETON_PREFIXES, endings: SKELETON_ENDINGS, maxParts: 1 });
        scan(views.skeletonPairList, index.skeleton, hits, { prefixes: SKELETON_PREFIXES, endings: SKELETON_ENDINGS, maxParts: 1 });
    }
    if (index.english.map.size) {
        scan(views.latin[1].split(' '), index.english, hits, { endings: ENGLISH_ENDINGS, join: joinCollapsed });
    }
    if (index.double.map.size && keepRepeats) {
        // Only chunks that had repeated letters can hold a doubled form ("a$$", "nigga", "dicc").
        const kept = keepRepeats.split(' ');
        const doubled = kept.length === tokens.length ? kept.map((t, i) => (t === tokens[i] ? t : doubleFold(t))) : kept.map(doubleFold);
        scan(doubled, index.double, hits, { endings: DOUBLE_ENDINGS });
    }
    return hits;
}

// ---- names ------------------------------------------------------------------------------------
const NOT_A_NAME_BEFORE = new Set(['you', 'your', 'ur', 'u', 'ya', 'yo', 'hey', 'big', 'little', 'fat', 'stupid', 'suck', 'eat',
    'my', 'fucking', 'huge', 'small', 'that', 'this', 'the', 'a', 'such', 'what', 'oh', 'lol']);
const NOT_A_NAME_AFTER = new Set(['head', 'heads', 'face', 'sucker', 'move']);
const TITLE = /^[A-Z][a-z]*$/u;

/**
 * "Dick" next to another capitalised word is a name ("Moby Dick", "Dick Grayson", "Philip K. Dick"): it is
 * blanked out before the English insults are looked for. "you Dick", "Dick" alone or "DICK" are not names.
 */
export function maskNames(text) {
    const raw = String(text || '');
    if (!raw.includes('Dick')) return raw;
    return raw.replace(/(?<![A-Za-z])Dick(?![A-Za-z])/gu, (word, offset) => {
        const before = raw.slice(Math.max(0, offset - 40), offset).match(/([A-Za-z]+)\.?\s+$/u)?.[1];
        const after = raw.slice(offset + word.length, offset + word.length + 40).match(/^\s+([A-Za-z]+)/u)?.[1];
        const nameBefore = before && TITLE.test(before) && !NOT_A_NAME_BEFORE.has(before.toLowerCase());
        const nameAfter = after && TITLE.test(after) && !NOT_A_NAME_AFTER.has(after.toLowerCase());
        return nameBefore || nameAfter ? ' ' : word;
    });
}

/** Whether a Latin token is a common English word (franco / skeleton matches skip those). */
export { isCommonLatin };
