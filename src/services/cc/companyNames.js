// Keep moderation policy separate from saved-data validation so an old unsafe name can
// still be read and archived without damaging its financial record.
export function normalizeCompanyName(name) {
    return String(name ?? '').normalize('NFKD').toLowerCase()
        .replace(/[\p{M}\p{Cf}\u0640]/gu, '')
        .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه')
        .replace(/ک/gu, 'ك').replace(/ی/gu, 'ي')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

export function forbiddenCompanyName(name) {
    const normalized = normalizeCompanyName(name).replace(/0/gu, 'o').replace(/3/gu, 'e').replace(/1/gu, 'i');
    return /(?:سكس|جنس)(?:ال|لل|ل)?(?:اطفال|طفل|صغار)|(?:اطفال|طفل)(?:ال)?(?:سكس|جنس)/u.test(normalized)
        || /child(?:ren)?(?:sex|porn)|(?:sex|porn)(?:with)?(?:children|kids)|kids?porn/u.test(normalized);
}

export function companyNameIssue(name) {
    if (forbiddenCompanyName(name)) return 'forbidden_name';
    return typeof name === 'string' && /^[\p{L}\p{N} _.-]{2,32}$/u.test(name.trim()) ? null : 'name';
}

export function publicCompanyName(name) {
    return forbiddenCompanyName(name) ? 'اسم شركة محجوب' : name;
}
