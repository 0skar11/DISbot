// perfProbe.js — measures where the bot's time goes, to tell a slow host from slow code (the owner saw ~2 s replies).
// Every minute one line: `[PERF] ping=…ms lag(msg)=…ms loop(avg/max)=…ms cpu=…% rss=…MB db(n/avg/max)=… events=…`
//   ping      Discord gateway heartbeat round trip (a far or throttled host shows here)
//   lag(msg)  how old a message was when the bot's handler started (gateway + network delivery)
//   loop      event-loop delay: high = the CPU is starved or something blocks the process
//   cpu       share of one core this process used over the interval
//   db        PostgreSQL queries seen by the pool wrapper: count, average and slowest ms (+ the slowest statement)
//   events    per event: count, average and slowest handler ms
// Any single handler over SLOW_EVENT_MS or query over SLOW_QUERY_MS also gets its own line. PERF_PROBE=off disables it.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import logger from './logger.js';

const SLOW_EVENT_MS = Number(process.env.PERF_SLOW_EVENT_MS) || 800;
const SLOW_QUERY_MS = Number(process.env.PERF_SLOW_QUERY_MS) || 300;
const MAX_EVENT_NAMES = 30;

const fresh = () => ({ db: { n: 0, sum: 0, max: 0, sql: '' }, events: new Map(), lag: { n: 0, sum: 0, max: 0 } });
let stats = fresh();

export function recordDb(ms, text = '') {
    const db = stats.db;
    db.n += 1; db.sum += ms;
    if (ms > db.max) { db.max = ms; db.sql = String(text).replace(/\s+/gu, ' ').slice(0, 70); }
    if (ms >= SLOW_QUERY_MS) logger.info(`[PERF] slow query ${Math.round(ms)}ms: ${String(text).replace(/\s+/gu, ' ').slice(0, 90)}`);
}

export function recordEvent(name, ms, lagMs = null) {
    const item = stats.events.get(name) || (stats.events.size < MAX_EVENT_NAMES ? { n: 0, sum: 0, max: 0 } : null);
    if (item) {
        item.n += 1; item.sum += ms;
        if (ms > item.max) item.max = ms;
        stats.events.set(name, item);
    }
    if (Number.isFinite(lagMs) && lagMs >= 0 && lagMs < 60_000) {
        stats.lag.n += 1; stats.lag.sum += lagMs;
        if (lagMs > stats.lag.max) stats.lag.max = lagMs;
    }
    if (ms >= SLOW_EVENT_MS) logger.info(`[PERF] slow event ${name}: ${Math.round(ms)}ms${Number.isFinite(lagMs) ? ` (message was ${Math.round(lagMs)}ms old when handled)` : ''}`);
}

/** Wraps an event handler: runs it and records its duration (and a message's age for messageCreate). */
export async function timedEvent(name, args, run) {
    const startedAt = performance.now();
    const created = args?.[0]?.createdTimestamp;
    const lag = name === 'messageCreate' && Number.isFinite(created) ? Date.now() - created : null;
    try { return await run(); } finally { recordEvent(name, performance.now() - startedAt, lag); }
}

/** Wraps `pool.query` so every statement is timed. Safe to call once per pool. */
export function instrumentPool(pool) {
    if (!pool || pool.__perfWrapped || typeof pool.query !== 'function') return pool;
    const original = pool.query.bind(pool);
    pool.query = async (text, ...rest) => {
        const startedAt = performance.now();
        try { return await original(text, ...rest); } finally { recordDb(performance.now() - startedAt, typeof text === 'string' ? text : text?.text); }
    };
    pool.__perfWrapped = true;
    return pool;
}

export function startPerfProbe(client, { intervalMs = Number(process.env.PERF_PROBE_MS) || 60_000 } = {}) {
    if (process.env.PERF_PROBE === 'off') return null;
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    let lastCpu = process.cpuUsage();
    let lastAt = performance.now();
    const timer = setInterval(() => {
        try {
            const now = performance.now();
            const cpu = process.cpuUsage(lastCpu);
            const cpuPct = ((cpu.user + cpu.system) / 1000) / Math.max(1, now - lastAt) * 100;
            lastCpu = process.cpuUsage(); lastAt = now;
            const memory = process.memoryUsage();
            const { db, events, lag } = stats;
            const eventText = [...events.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 4)
                .map(([name, item]) => `${name} ${item.n}x avg${Math.round(item.sum / item.n)}/max${Math.round(item.max)}ms`).join(', ') || '-';
            logger.info(`[PERF] ping=${client?.ws?.ping ?? '?'}ms lag(msg)=${lag.n ? `${Math.round(lag.sum / lag.n)}/${Math.round(lag.max)}` : '-'}ms loop(avg/max)=${(loop.mean / 1e6).toFixed(0)}/${(loop.max / 1e6).toFixed(0)}ms cpu=${cpuPct.toFixed(0)}% rss=${Math.round(memory.rss / 1048576)}MB db(n/avg/max)=${db.n}/${db.n ? Math.round(db.sum / db.n) : 0}/${Math.round(db.max)}ms${db.sql ? ` [${db.sql}]` : ''} events: ${eventText}`);
            loop.reset();
            stats = fresh();
        } catch { /* the probe never breaks the bot */ }
    }, intervalMs);
    timer.unref?.();
    return timer;
}
