// chatFilterRepeats.js — "warn only when it is repeated a lot" counter for the chat filter.
// In memory: a restart forgets the counts, which only ever makes the filter milder.

const MAX_KEYS = 10_000;
const hits = new Map();

/**
 * Counts one hit for `key`. Hits older than `windowMs` are forgotten. When `limit` hits are reached
 * inside the window, `reached` is true and the counter starts again from zero.
 */
export function recordRepeat(key, { limit, windowMs }, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((at) => now - at < windowMs);
    recent.push(now);
    hits.delete(key);
    if (recent.length >= limit) return { count: recent.length, reached: true };
    hits.set(key, recent);
    if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value);
    return { count: recent.length, reached: false };
}

/** Tests only. */
export function clearRepeats() {
    hits.clear();
}
