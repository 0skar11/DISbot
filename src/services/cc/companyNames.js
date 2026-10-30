// Keep moderation policy separate from saved-data validation so an old unsafe name can
// still be read and archived without damaging its financial record.
import { checkText, normalizeForFilter } from '../moderation/chatFilterRules.js';

const EXPLICIT_WORDS = ['دعاره', 'عاهره', 'عاهرات', 'اباحي', 'اباحيه', 'اباحيات', 'بورنو', 'سكس', 'جنس', 'زنا',
    'sex', 'porn', 'porno', 'pornography', 'brothel', 'prostitution'];
const SEPARATED_EXPLICIT_WORDS = EXPLICIT_WORDS.map((word) => [...word].join('[^\\p{L}\\p{N}]*'));
const EXPLICIT_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:ال|وال|بال|لل|و|ب|ف)?(?:${SEPARATED_EXPLICIT_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'u');

function hasSeparatedServerWord(tokens) {
    // Company names are at most 32 characters. Bound work when masking old data too.
    if (tokens.length > 32 || tokens.join('').length > 64) return false;
    for (let start = 0; start < tokens.length; start += 1) {
        let joined = '';
        for (let end = start; end < tokens.length; end += 1) {
            joined += tokens[end];
            const rule = checkText(joined);
            // "ibn al" depends on its following word; checking truncated windows
            // would incorrectly reject allowed phrases such as "ابن العم".
            if (rule && rule !== 'ibnAl') return true;
        }
    }
    return false;
}
export function normalizeCompanyName(name) {
    return String(name ?? '').normalize('NFKD').toLowerCase()
        .replace(/[\p{M}\p{Cf}\u0640]/gu, '')
        .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
        .replace(/ک/gu, 'ك').replace(/ی/gu, 'ي')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

export function forbiddenCompanyName(name) {
    const text = String(name ?? '').normalize('NFKD');
    // Do not use handleChatFilter: its Trusted/owner exemptions are for chat only.
    // The pure rule applies to every company owner and moderator identically.
    if (checkText(text)) return true;
    // Normalize tokens individually: the chat matcher glues runs of short words,
    // which can otherwise hide "my s e x" or fail on mixed chunks like "دع اره".
    const tokens = text.replace(/[\p{M}\p{Cf}\u0640]/gu, '').split(/[^\p{L}\p{N}$@]+/u)
        .filter(Boolean).map(normalizeForFilter);
    if (hasSeparatedServerWord(tokens)) return true;
    const words = tokens.join(' ')
        .replace(/0/gu, 'o').replace(/3/gu, 'e').replace(/1/gu, 'i')
        .replace(/\$/gu, 's').replace(/@/gu, 'a');
    if (EXPLICIT_PATTERN.test(words)) return true;
    const normalized = normalizeCompanyName(name).replace(/0/gu, 'o').replace(/3/gu, 'e').replace(/1/gu, 'i');
    return /(?:سكس|جنس)(?:ال|لل|ل)?(?:اطفال|طفل|صغار)|(?:اطفال|طفل)(?:ال)?(?:سكس|جنس)/u.test(normalized)
        || /child(?:ren)?(?:sex|porn)|(?:sex|porn)(?:with)?(?:children|kids)|kids?porn/u.test(normalized);
}

export function companyNameIssue(name) {
    if (typeof name !== 'string') return 'name';
    const trimmed = name.trim();
    const length = [...trimmed].length;
    if (length < 2 || length > 32) return 'name';
    if (forbiddenCompanyName(trimmed)) return 'forbidden_name';
    return /^[\p{L}\p{N} _.-]+$/u.test(trimmed) ? null : 'name';
}

export function publicCompanyName(name) {
    return forbiddenCompanyName(name) ? 'اسم شركة محجوب' : name;
}
