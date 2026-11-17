// chatFilterText.js — the text side of the chat filter: normalisation and the "views" of a message that
// the word rules (chatFilterRules.js) and the owner's own words (chatFilterVariants.js, `automod`) look at.
// Pure functions only. Moved out of chatFilterRules.js unchanged (plus the joined pair views, which give the
// same answers as checking every pair on its own, in one regex run instead of hundreds).
//
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

export const HOMOGLYPHS = {
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

export const collapse = (s) => s.replace(/([\p{L}\p{N}$@])\1+/gu, '$1');

/**
 * Caches a pure one-string function (chat repeats the same words all the time). The cache is simply emptied
 * when it gets big.
 */
export function memoize(fn, limit = 5000) {
    const cache = new Map();
    return (value) => {
        let result = cache.get(value);
        if (result === undefined) {
            if (cache.size >= limit) cache.clear();
            result = fn(value);
            cache.set(value, result);
        }
        return result;
    };
}

/** collapse() for a string made only of token characters (letters, digits, $ and @): a plain loop. */
export function collapseToken(s) {
    let out = '';
    let prev = '';
    for (const ch of s) {
        if (ch !== prev) out += ch;
        prev = ch;
    }
    return out;
}

/** Lowercase, no tashkeel/tatweel/invisibles, look-alikes unified, short chunks glued; repeats kept. */
export function normalizeKeepRepeats(text) {
    const s = String(text || '').toLowerCase().normalize('NFKD')
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
    return glued.join(' ');
}

/** Lowercase, no tashkeel/tatweel/invisibles, look-alikes unified, short chunks glued and no repeats. */
export function normalizeForFilter(text) {
    return collapse(normalizeKeepRepeats(text));
}

export const ARABIC = /\p{Script=Arabic}/u;
const LATINISH = /[a-z0-9$@]/u;

// ---- franco → Arabic ------------------------------------------------------------------
const DIGRAPHS = { sh: 'ش', ch: 'ش', kh: 'خ', gh: 'غ', th: 'ث', dh: 'ذ' };
// With vowels, for Latin chunks inside Arabic text ("كسmك", "ks امك").
const SPELL = {
    a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن',
    o: 'و', p: 'ب', q: 'ق', r: 'ر', s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز',
    2: '', 3: 'ع', 4: 'ا', 5: 'خ', 6: 'ط', 7: 'ح', 8: 'غ', 9: 'ق', 0: 'و', 1: 'ي', $: 'س', '@': 'ا',
};
export const spellInArabic = memoize(function spellInArabic(word) {
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
});

// Consonant skeleton: both sides use one letter per sound and drop vowels (except a word-initial one).
const SKELETON_MERGE = { ق: 'ك', ص: 'س', ط: 'ت', ض: 'د', ظ: 'ز', ذ: 'ز', ه: 'ح', ء: '', أ: 'ا' };
export const arabicSkeleton = memoize(function arabicSkeleton(word) {
    const s = word.replace(/ه$/u, '').replace(/./gu, (ch) => SKELETON_MERGE[ch] ?? ch);
    return collapse(s.slice(0, 1) + s.slice(1).replace(/[اويى]/gu, ''));
});
const SKELETON_LATIN = {
    b: 'ب', p: 'ب', t: 'ت', 6: 'ت', g: 'ج', j: 'ج', h: 'ح', 7: 'ح', 5: 'خ', d: 'د', r: 'ر', z: 'ز', s: 'س',
    c: 'ك', k: 'ك', q: 'ك', 9: 'ك', f: 'ف', v: 'ف', l: 'ل', m: 'م', n: 'ن', 3: 'ع', 8: 'غ', x: 'كس',
};
const SKELETON_DIGRAPHS = { sh: 'ش', ch: 'ش', kh: 'خ', gh: 'غ', th: 'ث', dh: 'ز' };
export const francoSkeleton = memoize(function francoSkeleton(word) {
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
    return collapseToken(out);
});
export const skeletonAlternatives = (words, min = 3) => [...new Set(words.map(arabicSkeleton))].filter((s) => s.length >= min).join('|');

export function leet(text) {
    return collapse(text.replace(/0/gu, 'o').replace(/1/gu, 'i').replace(/3/gu, 'e').replace(/4/gu, 'a')
        .replace(/5/gu, 's').replace(/7/gu, 't').replace(/\$/gu, 's').replace(/@/gu, 'a'));
}
export function latinOf(text) {
    return text.replace(/\$/gu, 's').replace(/0/gu, 'o').replace(/@/gu, 'a');
}

const pairsOf = (list) => list.slice(1).map((t, i) => collapseToken(list[i] + t));

/**
 * The views every rule is checked against (see the top of this file). The pair views are joined with
 * spaces: a rule that matches one glued pair matches the joined text and the other way round, because
 * the pairs themselves never contain a space and every rule ends on a letter boundary.
 */
export function viewsOf(normalized) {
    const tokens = normalized.split(' ');
    const isArabic = tokens.map((t) => ARABIC.test(t));
    const mixedTokens = tokens.map((t, i) => {
        if (isArabic[i]) return LATINISH.test(t) ? spellInArabic(t) : t;
        const nearArabic = isArabic[i - 1] || isArabic[i + 1];
        return nearArabic && t.length <= 3 && /[a-z]/u.test(t) ? spellInArabic(t) : t;
    });
    const skeletonTokens = tokens.map((t, i) => (!isArabic[i] && /[a-z]/u.test(t) ? francoSkeleton(t) : '_'));
    const latinTokens = tokens.filter((t, i) => !isArabic[i]);
    const latinPairs = pairsOf(latinTokens).join(' ');
    const skeletonPairList = pairsOf(latinTokens).map(francoSkeleton);
    return {
        normalized,
        tokens,
        mixedTokens,
        arabic: [normalized, mixedTokens.join(' ')],
        arabicPairs: [pairsOf(tokens).join(' '), pairsOf(mixedTokens).join(' ')],
        latin: [latinOf(normalized), leet(normalized)],
        latinPairs: [latinOf(latinPairs), leet(latinPairs)],
        skeleton: skeletonTokens.join(' '),
        skeletonTokens,
        skeletonPairs: skeletonPairList.join(' '),
        skeletonPairList,
    };
}
