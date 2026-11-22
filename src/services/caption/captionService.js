// captionService.js: `.caption <text>` / `.كابشن <text>` and `/caption`, report #297:
// writes the text above the picture on a solid white background (meme caption style).
// GH #325: an animated GIF / WebP comes back as an animated GIF with the caption on every frame (kept under
// MAX_OUTPUT_BYTES by shrinking it, then by dropping frames); a still picture comes back as a PNG.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { findImageSource, isSafeUrl, download, downloadFirst } from '../gifConverterService.js';
import { logger } from '../../utils/logger.js';

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
// Discord's upload limit is 10 MB: the GIF stays under 8 MB.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 500;
export const COOLDOWN_MS = 3_000;
// Animated captions hold every frame in memory, so only a couple run at the same time.
export const MAX_JOBS = 2;
export const CAPTION_WORDS = new Set(['caption', 'كابشن']);
const CAPTION_SYMBOL_PREFIX = /^[.!/-]$/u;

const FONT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../promo/fonts/Cairo-Bold.ttf');

const PIXEL_LIMIT = 150_000_000;
const STATIC_MAX_WIDTH = 1200;
const ANIMATED_MAX_WIDTH = 540;
const ANIMATED_MIN_WIDTH = 160;
// The decoded frames are held as RGBA: about 100 MB at most, a long GIF is made narrower to fit.
const ANIMATED_PIXEL_BUDGET = 25_000_000;
const DEFAULT_FRAME_DELAY_MS = 100;
// Tried in order until the GIF fits MAX_OUTPUT_BYTES: narrower, fewer colours, then every 2nd / 3rd frame
// (the dropped frames' time is added to the kept ones, so the GIF plays at the same speed).
const ANIMATED_ATTEMPTS = [
  { scale: 1, step: 1, colours: 256 },
  { scale: 0.8, step: 1, colours: 128, interFrameMaxError: 8 },
  { scale: 0.6, step: 1, colours: 96, interFrameMaxError: 12 },
  { scale: 0.6, step: 2, colours: 96, interFrameMaxError: 12 },
  { scale: 0.45, step: 2, colours: 64, interFrameMaxError: 16 },
  { scale: 0.45, step: 3, colours: 64, interFrameMaxError: 16 },
];

export const TEXT = {
  noImage: '🖼️ ابعت صورة مع الأمر أو اعمل ريبلاي على صورة: `.caption الكلام هنا`',
  noText: '✍️ اكتب الكلام اللي عايزه فوق الصورة: `.caption الكلام هنا`',
  unsafe: '❌ بشتغل على الصور اللي على ديسكورد بس: ارفع الصورة أو اعمل ريبلاي عليها.',
  tooBig: '❌ الصورة كبيرة أوي، أقصى حجم 10 ميجا.',
  outputTooBig: '❌ الجيف طالع كبير أوي على ديسكورد، جرّب جيف أقصر.',
  notImage: '❌ الملف ده مش صورة.',
  textTooLong: '❌ الكلام طويل أوي، أقصى حد 500 حرف.',
  failed: '❌ حصل خطأ أثناء إضافة الكابشن، جرّب صورة تانية.',
  busy: '⏳ البوت بيعمل كابشن لصور كتير دلوقتي، جرّب بعد شوية.',
  videoStill: '⚠️ الجيف ده فيديو مش GIF، فطلع صورة ثابتة. ارفعه كملف GIF عشان يفضل متحرك.',
  cooldown: (s) => `⏳ استنى ${s} ثانية قبل ما تستخدم الأمر تاني.`,
};

function escapeMarkup(unsafe) {
  return String(unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/** Wraps text into lines that fit within maxCharsPerLine. */
export function wrapText(text, maxCharsPerLine = 35) {
  const words = String(text || '').trim().split(/\s+/u);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxCharsPerLine) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [' '];
}

/**
 * The white caption bar for a picture `width` wide, as `{ data, height }` with raw RGBA `data`.
 * Uses the bundled Cairo-Bold font directly to render on Linux (Railway) and all platforms without relying on OS fonts.
 */
async function buildHeader(width, text) {
  const fontSize = Math.max(18, Math.min(44, Math.round(width / 16)));
  const paddingX = Math.round(width * 0.05);
  const innerWidth = width - (paddingX * 2);

  const textOptions = {
    text: `<span foreground="#000000">${escapeMarkup(text)}</span>`,
    font: `Cairo Bold ${fontSize}`,
    rgba: true,
    dpi: 96,
    align: 'centre',
    width: innerWidth,
    wrap: 'word-char',
    spacing: Math.round(fontSize * 0.3),
  };
  if (fs.existsSync(FONT_FILE)) textOptions.fontfile = FONT_FILE;

  const textLayer = await sharp({ text: textOptions }).png().toBuffer({ resolveWithObject: true });

  const paddingTop = Math.round(fontSize * 0.8);
  const paddingBottom = Math.round(fontSize * 0.8);
  const headerHeight = Math.max(50, textLayer.info.height + paddingTop + paddingBottom);

  const data = await sharp({
    create: {
      width,
      height: headerHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: textLayer.data,
        top: Math.round((headerHeight - textLayer.info.height) / 2),
        left: Math.round((width - textLayer.info.width) / 2),
      },
    ])
    .raw()
    .toBuffer();

  return { data, height: headerHeight };
}

/** The width an animated caption starts at: at most ANIMATED_MAX_WIDTH, and narrow enough for ANIMATED_PIXEL_BUDGET. */
function animatedBaseWidth(width, pageHeight, pages) {
  const fitting = Math.floor(Math.sqrt((ANIMATED_PIXEL_BUDGET * width) / Math.max(1, pageHeight * pages)));
  return Math.max(Math.min(width, ANIMATED_MIN_WIDTH), Math.min(width, ANIMATED_MAX_WIDTH, fitting));
}

/** Every frame of an animated picture, `width` wide, as raw RGBA (sharp applies each frame's disposal). */
async function decodeFrames(imageBuffer, width) {
  const { data, info } = await sharp(imageBuffer, { animated: true, limitInputPixels: PIXEL_LIMIT })
    .resize({ width, withoutEnlargement: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pages = info.pages || 1;
  if (info.channels !== 4) throw new Error(`unexpected ${info.channels} channels`);
  return { data, width: info.width, pageHeight: info.pageHeight || Math.round(info.height / pages), pages };
}

/** Every `step`-th frame with the caption bar on top of it, encoded as one animated GIF. */
async function encodeCaptionedGif(frames, header, { step, colours, interFrameMaxError, delayOf, loop }) {
  const { width, pageHeight, pages } = frames;
  const frameBytes = width * pageHeight * 4;
  const kept = [];
  const delays = [];
  for (let index = 0; index < pages; index += step) {
    kept.push(index);
    let delay = 0;
    for (let skipped = index; skipped < Math.min(index + step, pages); skipped += 1) delay += delayOf(skipped);
    delays.push(delay);
  }
  const outPageHeight = header.height + pageHeight;
  const raw = Buffer.allocUnsafe(kept.length * (header.data.length + frameBytes));
  let offset = 0;
  for (const index of kept) {
    offset += header.data.copy(raw, offset);
    offset += frames.data.copy(raw, offset, index * frameBytes, (index + 1) * frameBytes);
  }
  const options = { delay: delays, loop, colours };
  if (interFrameMaxError) options.interFrameMaxError = interFrameMaxError;
  return sharp(raw, {
    raw: { width, height: outPageHeight * kept.length, channels: 4, pageHeight: outPageHeight },
    limitInputPixels: PIXEL_LIMIT,
  }).gif(options).toBuffer();
}

async function animatedCaption(imageBuffer, text, metadata, maxBytes) {
  const pages = metadata.pages;
  const srcWidth = metadata.width || ANIMATED_MAX_WIDTH;
  const srcPageHeight = metadata.pageHeight || Math.round((metadata.height || srcWidth) / pages);
  const baseWidth = animatedBaseWidth(srcWidth, srcPageHeight, pages);
  // Browsers (and Discord) play a frame of 10 ms or less as 100 ms: that is what it is counted as.
  const delayOf = (index) => {
    const delay = Number(metadata.delay?.[index]);
    return Number.isFinite(delay) && delay > 10 ? delay : DEFAULT_FRAME_DELAY_MS;
  };
  const loop = metadata.loop ?? 0;

  // Only the frames of the latest width are kept in memory.
  let current = null;
  for (const attempt of ANIMATED_ATTEMPTS) {
    if (Math.ceil(pages / attempt.step) < 2) continue;
    const width = Math.min(baseWidth, Math.max(Math.min(srcWidth, ANIMATED_MIN_WIDTH), Math.round(baseWidth * attempt.scale)));
    if (current?.width !== width) {
      current = null;
      const frames = await decodeFrames(imageBuffer, width);
      current = { width, frames, header: await buildHeader(frames.width, text) };
    }
    const gif = await encodeCaptionedGif(current.frames, current.header, { ...attempt, delayOf, loop });
    if (gif.length <= maxBytes) return { buffer: gif, filename: 'caption.gif', isGif: true };
  }
  throw new Error('too big');
}

async function staticCaption(imageBuffer, text, metadata) {
  let picture = imageBuffer;
  let width = metadata.width || 500;
  let height = metadata.height || 500;
  if (width > STATIC_MAX_WIDTH) {
    const resized = await sharp(imageBuffer, { limitInputPixels: PIXEL_LIMIT })
      .resize({ width: STATIC_MAX_WIDTH, withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    ({ data: picture } = resized);
    ({ width, height } = resized.info);
  }
  const header = await buildHeader(width, text);
  const buffer = await sharp({
    create: {
      width,
      height: header.height + height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: header.data, raw: { width, height: header.height, channels: 4 }, top: 0, left: 0 },
      { input: picture, top: header.height, left: 0, limitInputPixels: PIXEL_LIMIT },
    ])
    .png()
    .toBuffer();
  return { buffer, filename: 'caption.png', isGif: false };
}

/**
 * Creates the picture with the text written above it on a solid white background.
 * An animated GIF / WebP (more than one frame) stays animated: a GIF with the caption on every frame, kept under
 * `maxBytes`. Anything else (a one-frame GIF too, like Tenor's still preview) comes out as a PNG.
 * Throws 'too big' when not even the smallest GIF fits.
 */
export async function generateCaption(imageBuffer, text, { maxBytes = MAX_OUTPUT_BYTES } = {}) {
  const metadata = await sharp(imageBuffer, { animated: true, limitInputPixels: PIXEL_LIMIT }).metadata();
  if ((metadata.pages || 1) > 1) return animatedCaption(imageBuffer, text, metadata, maxBytes);
  return staticCaption(imageBuffer, text, metadata);
}

const lastUse = new Map();
let running = 0;

/** For tests. */
export function resetCaptionState() {
  lastUse.clear();
  running = 0;
}

/** Whether a parsed typed command is `.caption`, `!caption`, `.كابشن`... */
export function isCaptionCommand(parsed) {
  if (!parsed?.commandName) return false;
  const name = parsed.commandName.toLowerCase();
  if (parsed.prefixed) return CAPTION_WORDS.has(name);
  return CAPTION_SYMBOL_PREFIX.test(name.slice(0, 1)) && CAPTION_WORDS.has(name.slice(1));
}

/**
 * Handles message or interaction caption request.
 */
export async function runCaption({ userId, text, getImage, respond }, deps = {}) {
  const now = (deps.now || Date.now)();
  const last = lastUse.get(userId);
  if (last !== undefined && now - last < COOLDOWN_MS) {
    return respond({ content: TEXT.cooldown(Math.ceil((COOLDOWN_MS - (now - last)) / 1000)) });
  }

  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return respond({ content: TEXT.noText });
  }
  if (cleanText.length > MAX_TEXT_LENGTH) {
    return respond({ content: TEXT.textTooLong });
  }

  const image = await getImage();
  if (!image?.url) {
    return respond({ content: TEXT.noImage });
  }
  if (image.notImage) {
    return respond({ content: TEXT.notImage });
  }
  const safe = deps.isSafeUrl || isSafeUrl;
  if (!safe(image.url)) {
    return respond({ content: TEXT.unsafe });
  }
  if (Number(image.size || 0) > MAX_INPUT_BYTES) {
    return respond({ content: TEXT.tooBig });
  }
  // Taken before the first await, so captions arriving together can't all slip past the limit.
  if (running >= MAX_JOBS) {
    return respond({ content: TEXT.busy });
  }

  lastUse.set(userId, now);
  running += 1;
  try {
    // A Tenor / Giphy GIF comes with its animated formats, best first: one that is missing or too big falls back.
    const candidates = image.candidates?.length ? image.candidates : [image.url];
    let bytes;
    try {
      ({ bytes } = await downloadFirst(candidates, { fetch: deps.fetch, maxBytes: MAX_INPUT_BYTES, download: deps.download || download, safe }));
    } catch (error) {
      logger.warn(`[CAPTION] download failed: ${error.message || error}`);
      return respond({ content: error.message === 'too big' ? TEXT.tooBig : TEXT.failed });
    }
    const result = await (deps.generateCaption || generateCaption)(bytes, cleanText);
    const buffer = Buffer.isBuffer(result) ? result : result.buffer;
    const isGif = result?.isGif ?? /\.gif$/iu.test(result?.filename || '');
    const filename = result?.filename || (isGif ? 'caption.gif' : 'caption.png');
    // Only the still thumbnail of a video GIF could be read: say so instead of passing it off as the GIF.
    const note = image.videoStill && !isGif ? { content: TEXT.videoStill } : {};
    return respond({
      ...note,
      files: [{ attachment: buffer, name: filename }],
    });
  } catch (error) {
    logger.warn('Caption generation failed:', error.message || error);
    return respond({ content: error.message === 'too big' ? TEXT.outputTooBig : TEXT.failed });
  } finally {
    running -= 1;
  }
}

/** Typed handler. Returns true when the message was this command. */
export async function handleCaptionCommand(message, args = [], deps = {}) {
  if (!message.guild) return false;
  const respond = async (payload) => {
    const full = { ...payload, allowedMentions: { parse: [], repliedUser: false } };
    await message.reply(full).catch(() => message.channel?.send?.(full))
      .catch((error) => logger.warn(`[CAPTION] could not answer: ${error.message}`));
    return payload;
  };

  const textArgs = args.filter((arg) => !/^https?:\/\//i.test(arg));
  const text = textArgs.join(' ');

  await runCaption({
    userId: message.author?.id,
    text,
    getImage: async () => {
      message.channel?.sendTyping?.().catch?.(() => {});
      return findImageSource(message, args, deps);
    },
    respond,
  }, deps);
  return true;
}

/** Slash handler: `/caption text:<string> [image:<attachment>]`. */
export async function handleCaptionInteraction(interaction, deps = {}) {
  const attachment = interaction.options?.getAttachment?.('image');
  const text = interaction.options?.getString?.('text');
  await interaction.deferReply().catch(() => {});
  const respond = async (payload) => {
    await interaction.editReply({ content: '', ...payload, allowedMentions: { parse: [] } })
      .catch((error) => logger.warn(`[CAPTION] could not answer: ${error.message}`));
    return payload;
  };
  return runCaption({
    userId: interaction.user?.id,
    text,
    getImage: async () => {
      if (!attachment) return null;
      const imageName = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?|$)/iu;
      const isImage = attachment.contentType?.startsWith('image/') || imageName.test(attachment.name || '') || imageName.test(attachment.url || '');
      if (!isImage) return { url: attachment.url, size: attachment.size, notImage: true };
      return { url: attachment.url, size: attachment.size };
    },
    respond,
  }, deps);
}
