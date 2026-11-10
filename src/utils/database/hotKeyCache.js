// hotKeyCache.js — a short in-memory cache for the few database keys that are read on every message.
//
// Before a typed command runs, the server's settings (`guild:<id>:config`) were read from PostgreSQL
// three or four times in a row, plus the counting game settings (`countingGame:<id>`). Each read is a
// round trip to the database, so every command waited on them. These keys are now kept in memory for a
// few seconds and dropped the moment this bot writes them.
//
// Every server the bot is in gets it (the owner asked for the speed-up everywhere, without exception).
// `DB_HOT_CACHE_TTL_MS=0` turns the cache off.

const DEFAULT_TTL_MS = 15_000;

// `cacheMisses`: also remember "nothing saved". Never for the server settings: a failed read looks the
// same as a missing row, and the settings (trusted lists, protection) must not fall back to defaults.
const HOT_KEYS = [
    { pattern: /^guild:\d+:config$/u, cacheMisses: false },
    { pattern: /^countingGame:\d+$/u, cacheMisses: true },
];

export function hotCacheTtlMs() {
    const raw = process.env.DB_HOT_CACHE_TTL_MS;
    if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
    const ttl = Number(raw);
    return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_MS;
}

/** The cache rule for a key, or null when the key is not cached. */
export function hotKeyRule(key) {
    if (typeof key !== 'string') return null;
    return HOT_KEYS.find((rule) => rule.pattern.test(key)) || null;
}

const MISSING = Symbol('missing');

export class HotKeyCache {
    constructor() {
        this.entries = new Map(); // key -> { value, expiresAt }
        this.loading = new Map(); // key -> promise of a read in flight (shared by concurrent readers)
        this.versions = new Map(); // key -> bumped on every write, so a read that started earlier is not kept
    }

    /**
     * Reads `key` through the cache. `load(missing)` must read the database and return `missing` when
     * nothing is saved. Every caller gets its own copy, so changing the result never changes the cache.
     */
    async get(key, defaultValue, load) {
        const rule = hotKeyRule(key);
        const ttl = hotCacheTtlMs();
        if (!rule || ttl <= 0) {
            const value = await load(MISSING);
            return value === MISSING ? defaultValue : value;
        }

        const cached = this.entries.get(key);
        if (cached && cached.expiresAt > Date.now()) return this.#result(cached.value, defaultValue);

        let pending = this.loading.get(key);
        if (!pending) {
            const version = this.versions.get(key) || 0;
            pending = Promise.resolve()
                .then(() => load(MISSING))
                .then((value) => {
                    const unchanged = (this.versions.get(key) || 0) === version;
                    if (unchanged && (value !== MISSING || rule.cacheMisses)) {
                        this.entries.set(key, { value, expiresAt: Date.now() + ttl });
                    }
                    return value;
                })
                .finally(() => {
                    if (this.loading.get(key) === pending) this.loading.delete(key);
                });
            this.loading.set(key, pending);
        }
        return this.#result(await pending, defaultValue);
    }

    /** Forgets `key`; called around every write so the next read sees the saved value. */
    invalidate(key) {
        if (!hotKeyRule(key)) return;
        this.versions.set(key, (this.versions.get(key) || 0) + 1);
        this.entries.delete(key);
        this.loading.delete(key);
    }

    clear() {
        this.entries.clear();
        this.loading.clear();
        this.versions.clear();
    }

    #result(value, defaultValue) {
        if (value === MISSING) return defaultValue;
        return value !== null && typeof value === 'object' ? structuredClone(value) : value;
    }
}
