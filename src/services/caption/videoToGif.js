// videoToGif.js: a short video becomes an animated GIF with ffmpeg, so `.caption` can write on every frame.
// A GIF sent from Discord's GIF picker is often only a video (an mp4 / webm embed, no .gif link) and members upload
// videos too: sharp cannot read either. ffmpeg comes from the ffmpeg-static npm package, since neither the Docker
// image nor a plain Node host has one; the FFMPEG_BIN environment variable points ffmpeg-static at another binary.
//
// Safety: the bytes go to a new folder in os.tmpdir() that is always removed. ffmpeg runs without a shell, its
// arguments an array, reading only that file: the demuxer is picked from the file's first bytes (mp4 / mov, webm / mkv,
// gif), so a playlist or a concat list is never opened, and no protocol but `file` is allowed. At most the first
// MAX_SECONDS are read, pictures over 4K are refused, and ffmpeg is killed after FFMPEG_TIMEOUT_MS.
// MAX_PARALLEL conversions run at once, MAX_WAITING more wait for their turn, any more get 'busy'.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../../utils/logger.js';

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_SECONDS = 10;
export const FPS = 12;
// Fits inside MAX_SIDE x MAX_SIDE (never enlarged): 480 wide at most, and a tall video does not get huge frames.
export const MAX_SIDE = 480;
export const FFMPEG_TIMEOUT_MS = 30_000;
export const MAX_PARALLEL = 1;
export const MAX_WAITING = 2;
const MAX_FRAMES = MAX_SECONDS * FPS;
const MAX_GIF_BYTES = 40 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 3840 * 2160;
const KILL_GRACE_MS = 5_000;
const TEMP_PREFIX = 'disbot-caption-';
const STALE_TEMP_MS = 15 * 60 * 1000;

const require = createRequire(import.meta.url);

/** The ffmpeg to run (ffmpeg-static's binary, or FFMPEG_BIN), or null when there is none. */
export function ffmpegBinary() {
  let binary = null;
  try {
    binary = require('ffmpeg-static');
  } catch {
    return null;
  }
  if (typeof binary !== 'string' || !binary) return null;
  if (path.isAbsolute(binary) && !existsSync(binary)) return null;
  return binary;
}

/** The ffmpeg demuxer for these bytes: 'mov' (mp4 / mov), 'matroska' (webm / mkv), 'gif', or null. */
export function videoFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  const box = bytes.toString('latin1', 4, 8);
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box)) return 'mov';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'matroska';
  const head = bytes.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  return null;
}

const COMMON_ARGS = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const SCALE = `scale=w='min(${MAX_SIDE},iw)':h='min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease:flags=lanczos`;

function inputArgs(format, input) {
  return [
    '-protocol_whitelist', 'file',
    '-f', format,
    '-threads', '2',
    '-max_pixels', String(MAX_SOURCE_PIXELS),
    '-t', String(MAX_SECONDS),
    '-i', input,
  ];
}

/** Pass 1: one palette for the whole clip (two passes, so the frames are never all held in memory). */
export function paletteArgs(format, input, palette) {
  return [
    ...COMMON_ARGS,
    ...inputArgs(format, input),
    '-map', '0:v:0',
    '-vf', `fps=${FPS},${SCALE},palettegen=max_colors=256`,
    '-frames:v', '1',
    '-update', '1',
    palette,
  ];
}

/** Pass 2: the GIF, every frame drawn with that palette. */
export function gifArgs(format, input, palette, output) {
  return [
    ...COMMON_ARGS,
    ...inputArgs(format, input),
    '-i', palette,
    '-filter_complex', `[0:v:0]fps=${FPS},${SCALE}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[out]`,
    '-map', '[out]',
    '-frames:v', String(MAX_FRAMES),
    '-loop', '0',
    '-fs', String(MAX_GIF_BYTES),
    '-f', 'gif',
    output,
  ];
}

/** Runs ffmpeg once; rejects on a non-zero exit, and kills it (error 'ffmpeg timeout') after `timeoutMs`. */
export function runFfmpeg(binary, args, { spawn = nodeSpawn, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new Error('ffmpeg timeout'));
      return;
    }
    let child;
    try {
      child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      // Waits for the exit so the temporary files are no longer in use, but not forever.
      killTimer = setTimeout(() => finish(new Error('ffmpeg timeout')), KILL_GRACE_MS);
    }, timeoutMs);
    child.stderr?.on?.('data', (chunk) => { stderr = (stderr + chunk).slice(-2_000); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (timedOut) return finish(new Error('ffmpeg timeout'));
      if (code === 0) return finish();
      const last = stderr.trim().split(/\r?\n/u).pop() || '';
      return finish(new Error(`ffmpeg failed (${code ?? signal})${last ? `: ${last}` : ''}`));
    });
  });
}

let active = 0;
const waiting = [];

/** For tests. */
export function resetVideoState() {
  active = 0;
  waiting.length = 0;
}

async function withSlot(job) {
  if (active < MAX_PARALLEL) {
    active += 1;
  } else {
    if (waiting.length >= MAX_WAITING) throw new Error('busy');
    // The slot is handed over by the job that finishes, so `active` stays the same.
    await new Promise((resolve) => waiting.push(resolve));
  }
  try {
    return await job();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

let sweptStale = false;

/** Removes our folders left behind by a crash (older than STALE_TEMP_MS). Never throws. */
async function sweepStaleTempDirs(tmpdir) {
  if (sweptStale) return;
  sweptStale = true;
  try {
    const names = (await fs.readdir(tmpdir)).filter((name) => name.startsWith(TEMP_PREFIX));
    for (const name of names) {
      const dir = path.join(tmpdir, name);
      const stat = await fs.stat(dir).catch(() => null);
      if (stat?.isDirectory() && Date.now() - stat.mtimeMs > STALE_TEMP_MS) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}

/**
 * The first MAX_SECONDS of a video (mp4 / mov / webm / mkv, or a GIF) as an animated GIF Buffer: FPS frames a
 * second, at most MAX_SIDE x MAX_SIDE. Errors: 'not a video', 'too big', 'no ffmpeg', 'busy', 'ffmpeg timeout',
 * 'ffmpeg failed (...)'.
 * deps (tests): spawn, ffmpegPath (null: none), tmpdir, timeoutMs.
 */
export async function videoToGif(bytes, deps = {}) {
  const format = videoFormat(bytes);
  if (!format) throw new Error('not a video');
  if (bytes.length > MAX_VIDEO_BYTES) throw new Error('too big');
  const binary = deps.ffmpegPath !== undefined ? deps.ffmpegPath : ffmpegBinary();
  if (!binary) throw new Error('no ffmpeg');
  const spawn = deps.spawn || nodeSpawn;
  const tmpdir = deps.tmpdir || os.tmpdir();
  const timeoutMs = deps.timeoutMs ?? FFMPEG_TIMEOUT_MS;

  return withSlot(async () => {
    sweepStaleTempDirs(tmpdir).catch(() => {});
    const dir = await fs.mkdtemp(path.join(tmpdir, TEMP_PREFIX));
    try {
      const input = path.join(dir, 'input');
      const palette = path.join(dir, 'palette.png');
      const output = path.join(dir, 'out.gif');
      await fs.writeFile(input, bytes);
      const deadline = Date.now() + timeoutMs;
      await runFfmpeg(binary, paletteArgs(format, input, palette), { spawn, timeoutMs: deadline - Date.now() });
      await runFfmpeg(binary, gifArgs(format, input, palette, output), { spawn, timeoutMs: deadline - Date.now() });
      const gif = await fs.readFile(output);
      if (videoFormat(gif) !== 'gif') throw new Error('ffmpeg failed (no GIF)');
      return gif;
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch((error) => logger.warn(`[CAPTION] could not remove ${dir}: ${error.message}`));
    }
  });
}
