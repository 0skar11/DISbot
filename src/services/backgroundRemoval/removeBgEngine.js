// removeBgEngine.js: runs the background removal (removeBgWorker.js) in one worker thread and hands back the PNG.
//
// The model: an ONNX file of the U2-Net family (Apache-2.0), chosen with REMOVEBG_MODEL (default `u2net`, see
// MODELS). It is read from REMOVEBG_MODEL_PATH when set, otherwise downloaded once from its rembg release into
// REMOVEBG_MODEL_DIR (default `data/models`, point it at a volume to keep it across deploys); REMOVEBG_MODEL_SHA256
// checks the file when given. The worker keeps the model loaded and stops after IDLE_MS without work, which frees
// its memory. A job that runs past its timeout stops the worker (the next job starts a fresh one).
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import 'sharp'; // loaded in the main thread before any worker, as sharp asks.
import { logger } from '../../utils/logger.js';

export const MODELS = {
    u2net: {
        size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
    },
    u2netp: {
        size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    },
    'isnet-general-use': {
        size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1],
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    },
};
export const DEFAULT_TIMEOUT_MS = 60_000;
const IDLE_MS = 3 * 60_000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_MODEL_BYTES = 400 * 1024 * 1024;

function fail(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

export function modelSettings(env = process.env) {
    const name = String(env.REMOVEBG_MODEL || 'u2net').trim();
    const model = MODELS[name];
    if (!model) throw fail('unavailable', `unknown REMOVEBG_MODEL "${name}"`);
    const dir = env.REMOVEBG_MODEL_DIR || path.join(process.cwd(), 'data', 'models');
    return {
        name,
        model,
        path: env.REMOVEBG_MODEL_PATH || path.join(dir, `${name}.onnx`),
        downloadable: !env.REMOVEBG_MODEL_PATH,
        sha256: String(env.REMOVEBG_MODEL_SHA256 || '').trim().toLowerCase() || null,
        threads: Math.max(1, Math.min(8, Number.parseInt(env.REMOVEBG_THREADS, 10) || 2)),
    };
}

async function downloadModel(settings, fetchImpl = fetch) {
    await fs.promises.mkdir(path.dirname(settings.path), { recursive: true });
    const partial = `${settings.path}.part`;
    logger.info(`[REMOVEBG] downloading the ${settings.name} model`);
    const response = await fetchImpl(settings.model.url, { signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw fail('unavailable', `model download failed (${response.status})`);
    const hash = createHash('sha256');
    const out = fs.createWriteStream(partial);
    let total = 0;
    try {
        for await (const chunk of response.body) {
            total += chunk.length;
            if (total > MAX_MODEL_BYTES) throw fail('unavailable', 'model file too big');
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        }
        await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
        const digest = hash.digest('hex');
        if (settings.sha256 && digest !== settings.sha256) throw fail('unavailable', `model checksum mismatch (${digest})`);
        await fs.promises.rename(partial, settings.path);
        logger.info(`[REMOVEBG] model ready (${(total / 1024 / 1024).toFixed(1)} MB, sha256 ${digest})`);
    } catch (error) {
        out.destroy();
        await fs.promises.rm(partial, { force: true }).catch(() => {});
        throw error;
    }
}

let modelReady = null;

/** The model file's path, downloading it the first time. Concurrent callers share one download. */
export function ensureModel(settings = modelSettings(), deps = {}) {
    if (fs.existsSync(settings.path)) return Promise.resolve(settings.path);
    if (!settings.downloadable) return Promise.reject(fail('unavailable', `model not found at ${settings.path}`));
    modelReady ??= downloadModel(settings, deps.fetch).then(() => settings.path).finally(() => { modelReady = null; });
    return modelReady;
}

let worker = null;
let idleTimer = null;
let nextJobId = 0;

function startWorker() {
    const created = new Worker(new URL('./removeBgWorker.js', import.meta.url));
    created.unref();
    created.on('error', (error) => logger.warn(`[REMOVEBG] worker error: ${error.message}`));
    created.on('exit', () => { if (worker === created) worker = null; });
    return created;
}

function stopWorker() {
    const current = worker;
    worker = null;
    current?.terminate().catch(() => {});
}

/**
 * Picture bytes in, PNG with a transparent background out. Errors carry a `code`: 'timeout', 'unavailable'
 * (no model / onnxruntime), 'not image', 'too big' or 'failed'. Callers run one job at a time (removeBgService.js).
 */
export async function removeBackground(bytes, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const settings = modelSettings();
    const modelPath = await ensureModel(settings);
    clearTimeout(idleTimer);
    worker ??= startWorker();
    const current = worker;
    const id = ++nextJobId;
    try {
        return await new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                current.off('message', onMessage);
                current.off('error', onError);
                current.off('exit', onExit);
            };
            const timer = setTimeout(() => {
                cleanup();
                if (worker === current) stopWorker();
                reject(fail('timeout'));
            }, timeoutMs);
            const onMessage = (message) => {
                if (message?.id !== id) return;
                cleanup();
                if (message.ok) resolve(Buffer.from(message.png));
                else reject(fail(message.code || 'failed', message.error));
            };
            const onError = (error) => { cleanup(); reject(fail('failed', error.message)); };
            const onExit = () => { cleanup(); reject(fail('failed', 'worker stopped')); };
            current.on('message', onMessage);
            current.on('error', onError);
            current.on('exit', onExit);
            current.postMessage({ id, input: bytes, model: settings.model, modelPath, threads: settings.threads });
        });
    } finally {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(stopWorker, IDLE_MS);
        idleTimer.unref?.();
    }
}
