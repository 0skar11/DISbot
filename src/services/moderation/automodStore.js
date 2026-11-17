// automodStore.js — the owner's `automod` edits to the chat filter (our server only, CLAUDE.md):
//   { custom: [{ word, rule: 'family'|'ibnAl'|'insult'|'banned', addedBy, at }], disabled: [built-in words switched off] }
// Saved under one database key (AUTOMOD_KEY), read once at startup (ready.js) and kept in memory; every change
// is handed to the filter at once (setCustomRules, chatFilterRules.js). A failed save never breaks the filter:
// the change stays in memory and the failure is logged. If the saved list could not be read, edits are refused
// (so an empty list never overwrites the real one) until a later read works.

import { HOME_GUILD_ID } from '../../config/homeGuild.js';
import { Mutex } from '../../utils/mutex.js';
import { logger } from '../../utils/logger.js';
import {
    IBN_AL_INSULTS, INSULTS, INSULTS_ENGLISH, INSULTS_LATIN, explainText, setCustomRules,
} from './chatFilterRules.js';
import { RULES, isCommonLatin, normalizeCustomWord, variantGroups } from './chatFilterVariants.js';
import { collapseToken, normalizeForFilter } from './chatFilterText.js';

export const AUTOMOD_KEY = `guild:${HOME_GUILD_ID}:automodRules`;
export const MAX_CUSTOM_WORDS = 500;
export const WORD_MIN_LENGTH = 2;
export const WORD_MAX_LENGTH = 30;
const LOCK = 'automod-rules';

// Words so common that filtering them would delete half the chat (owner protection against a typo).
const COMMON_ARABIC = new Set(['في', 'من', 'علي', 'على', 'الي', 'الى', 'انا', 'انت', 'انتي', 'هو', 'هي', 'ده', 'دي', 'دا', 'ايه', 'لا',
    'مش', 'كده', 'كدا', 'بس', 'عشان', 'يا', 'ما', 'لو', 'او', 'اه', 'ايوه', 'تمام', 'شكرا', 'والله', 'الله', 'ان', 'عن', 'مع', 'كل', 'حد',
    'هنا', 'هناك', 'فين', 'ليه', 'امتي', 'ازاي', 'مين', 'اللي', 'كان', 'يكون', 'احنا', 'انتو', 'هما'].map((w) => normalizeForFilter(w)));
const LINK_OR_MENTION = /<[@#][!&]?\d+>|@(?:everyone|here)|https?:\/\/|www\.|discord(?:app)?\.(?:gg|com)|\b[a-z0-9-]+\.(?:com|net|org|gg|io|me|xyz|ly|co|tv)\b/iu;

let state = { custom: [], disabled: [] };
let loaded = false;
let persistent = true;

const copy = (value) => ({ custom: value.custom.map((entry) => ({ ...entry })), disabled: [...value.disabled] });
const apply = () => setCustomRules(state);

/** The current edits (a copy) and whether the saved list was read. */
export function getAutomodState() {
    return { ...copy(state), loaded, persistent };
}

/** Tests only: forget everything (the filter goes back to the built-in lists). */
export function resetAutomodStore() {
    state = { custom: [], disabled: [] };
    loaded = false;
    persistent = true;
    apply();
}

// ---- built-in lists ---------------------------------------------------------------------------
/**
 * Where a built-in word lives: { list: 'insult'|'ibnAl'|'latin'|'english', word } (the word as stored), or null.
 * `ibnAl`: true = only the "ابن ال..." list, false = every list but that one, undefined = all lists.
 */
export function findBuiltIn(word, { ibnAl } = {}) {
    const normalized = normalizeForFilter(word);
    if (!normalized) return null;
    if (ibnAl !== false) {
        const ibn = normalizeCustomWord(word, 'ibnAl');
        const inIbn = [normalized, ibn].find((w) => IBN_AL_INSULTS.includes(w));
        if (ibnAl === true) return inIbn ? { list: 'ibnAl', word: inIbn, words: [inIbn] } : null;
        if (inIbn && !INSULTS.includes(normalized)) return { list: 'ibnAl', word: inIbn, words: [inIbn] };
    }
    if (INSULTS.includes(normalized)) return { list: 'insult', word: normalized, words: [normalized] };
    // The franco list has a few uncollapsed spellings ("teez" next to "tez"): they go off and on together.
    const typed = String(word).trim().toLowerCase();
    const latinEntries = [...new Set(INSULTS_LATIN.filter((entry) => collapseToken(entry) === normalized))];
    if (latinEntries.length) return { list: 'latin', word: latinEntries.includes(typed) ? typed : latinEntries[0], words: latinEntries };
    const latin = collapseToken(normalized.replace(/\$/gu, 's').replace(/@/gu, 'a').replace(/0/gu, 'o'));
    const english = INSULTS_ENGLISH.find((entry) => entry.word === latin || entry.forms.includes(latin) || entry.double.includes(latin));
    if (english) return { list: 'english', word: english.word, words: [english.word] };
    return null;
}
const isBuiltInWord = (word) => INSULTS.includes(word) || IBN_AL_INSULTS.includes(word) || INSULTS_LATIN.includes(word)
    || INSULTS_ENGLISH.some((entry) => entry.word === word);

/** Built-in words with the same consonant skeleton (the other spellings that stay on when one is switched off). */
export function relatedBuiltIns(word) {
    const groups = variantGroups(word, 'insult');
    const keys = new Set([...groups.skeleton, ...groups.francoForms, ...groups.arabicFromLatin].filter(Boolean));
    if (!keys.size) return [];
    const normalized = normalizeForFilter(word);
    const related = [...INSULTS_LATIN, ...INSULTS].filter((entry) => entry !== normalized && !state.disabled.includes(entry)
        && variantGroups(entry, 'insult').francoForms.some((form) => keys.has(form)));
    return [...new Set(related)].slice(0, 8);
}

// ---- persistence ------------------------------------------------------------------------------
function sanitize(stored) {
    const custom = [];
    const seen = new Set();
    for (const entry of Array.isArray(stored?.custom) ? stored.custom : []) {
        if (!entry || typeof entry.word !== 'string' || !RULES.includes(entry.rule)) continue;
        const word = entry.word.trim().slice(0, WORD_MAX_LENGTH);
        const key = normalizeCustomWord(word, entry.rule);
        if (!key || seen.has(key) || custom.length >= MAX_CUSTOM_WORDS) continue;
        seen.add(key);
        custom.push({ word, rule: entry.rule, addedBy: String(entry.addedBy || ''), at: Number(entry.at) || 0 });
    }
    const disabled = [...new Set((Array.isArray(stored?.disabled) ? stored.disabled : []).filter((w) => typeof w === 'string' && isBuiltInWord(w)))];
    return { custom, disabled };
}

async function readStored(client) {
    const db = client?.db;
    if (!db?.get) throw new Error('no database');
    // A real read failure must not look like an empty list (that would overwrite the saved one on the next edit).
    const strict = typeof db.getStrict === 'function' && db.isAvailable?.() !== false && !db.isDegraded?.();
    persistent = !(db.isDegraded?.() || db.isAvailable?.() === false);
    return strict ? db.getStrict(AUTOMOD_KEY, null) : db.get(AUTOMOD_KEY, null);
}

/** Reads the saved edits into memory and hands them to the filter. Never throws. */
export async function loadAutomodRules(client) {
    try {
        state = sanitize(await readStored(client));
        loaded = true;
    } catch (error) {
        loaded = false;
        logger.warn(`[AUTOMOD] Could not read the saved filter edits (built-in lists stay on): ${error.message}`);
    }
    apply();
    return { loaded, custom: state.custom.length, disabled: state.disabled.length };
}

async function save(client) {
    try {
        const ok = await client.db.set(AUTOMOD_KEY, { custom: state.custom, disabled: state.disabled });
        if (ok === false) throw new Error('database refused the write');
        return true;
    } catch (error) {
        logger.warn(`[AUTOMOD] Could not save the filter edits (they work until the next restart): ${error.message}`);
        return false;
    }
}

/** Runs one edit: loads first if needed, refuses when the saved list cannot be read. */
function edit(client, change) {
    return Mutex.runExclusive(LOCK, async () => {
        if (!loaded) await loadAutomodRules(client);
        if (!loaded) return { ok: false, reason: 'not_loaded' };
        const result = change();
        if (!result.ok) return result;
        apply();
        return { ...result, saved: await save(client), persistent };
    });
}

// ---- edits ------------------------------------------------------------------------------------
/** Why a word cannot be added (or null): length, link, empty, common, duplicate, builtin, already, full. */
export function validateWord(word, rule = 'insult') {
    const text = String(word ?? '').trim();
    const length = [...text].length;
    if (length < WORD_MIN_LENGTH || length > WORD_MAX_LENGTH) return { reason: 'length' };
    if (LINK_OR_MENTION.test(text)) return { reason: 'link' };
    if (!RULES.includes(rule)) return { reason: 'rule' };
    const key = normalizeCustomWord(text, rule);
    if ([...key.replace(/\s/gu, '')].length < WORD_MIN_LENGTH || !/\p{L}/u.test(key)) return { reason: 'empty' };
    if (isCommonLatin(collapseToken(key)) || COMMON_ARABIC.has(key)) return { reason: 'common' };
    if (state.custom.some((entry) => normalizeCustomWord(entry.word, entry.rule) === key)) return { reason: 'duplicate' };
    const builtIn = findBuiltIn(rule === 'ibnAl' ? key : text, { ibnAl: rule === 'ibnAl' });
    if (builtIn && builtIn.words.some((entry) => !state.disabled.includes(entry))) return { reason: 'builtin', builtIn };
    const already = explainText(rule === 'ibnAl' ? `ابن ال${key}` : text);
    if (already) return { reason: 'already', rule: already.rule, word: already.word };
    if (state.custom.length >= MAX_CUSTOM_WORDS) return { reason: 'full' };
    return null;
}

/** Adds an owner word. Returns { ok: true, entry, variants, saved } or { ok: false, reason, ... }. */
export function addAutomodWord(client, { word, rule = 'insult', by = '', now = Date.now() }) {
    return edit(client, () => {
        const problem = validateWord(word, rule);
        if (problem) return { ok: false, ...problem };
        const entry = { word: String(word).trim(), rule, addedBy: String(by), at: now };
        state = { ...state, custom: [...state.custom, entry] };
        return { ok: true, entry: { ...entry }, variants: variantGroups(entry.word, rule) };
    });
}

/**
 * Removes an owner word, or switches a built-in list word off. Returns { ok: true, kind: 'custom', entry } |
 * { ok: true, kind: 'disabled', builtIn, related } | { ok: false, reason: 'not_found'|'already_off'|'readonly', rule }.
 */
export function removeAutomodWord(client, { word }) {
    return edit(client, () => {
        const text = String(word ?? '').trim();
        const custom = state.custom.find((entry) => entry.word === text)
            || state.custom.find((entry) => normalizeCustomWord(entry.word, entry.rule) === normalizeCustomWord(text, entry.rule));
        if (custom) {
            state = { ...state, custom: state.custom.filter((entry) => entry !== custom) };
            return { ok: true, kind: 'custom', entry: { ...custom } };
        }
        const builtIn = findBuiltIn(text);
        if (builtIn) {
            const off = builtIn.words.filter((entry) => !state.disabled.includes(entry));
            if (!off.length) return { ok: false, reason: 'already_off', builtIn };
            state = { ...state, disabled: [...state.disabled, ...off] };
            return { ok: true, kind: 'disabled', builtIn, related: relatedBuiltIns(builtIn.word).filter((entry) => !builtIn.words.includes(entry)) };
        }
        // Caught by a built-in pattern (كسمك, زانية, دين امك...): those groups cannot be switched off word by word.
        const caught = explainText(text);
        return caught ? { ok: false, reason: 'readonly', rule: caught.rule, source: caught.source } : { ok: false, reason: 'not_found' };
    });
}

/** Switches a built-in word back on. Returns { ok: true, word } or { ok: false, reason: 'not_off' }. */
export function enableAutomodWord(client, { word }) {
    return edit(client, () => {
        const builtIn = findBuiltIn(word);
        const targets = builtIn?.words || [normalizeForFilter(word)];
        if (!targets.some((entry) => state.disabled.includes(entry))) return { ok: false, reason: 'not_off' };
        state = { ...state, disabled: state.disabled.filter((entry) => !targets.includes(entry)) };
        return { ok: true, word: builtIn?.word || targets[0], builtIn };
    });
}
