// captionService.js: `.caption <text>` / `.كابشن <text>` and `/caption`, report #297:
// writes the text above the picture on a solid white background (meme caption style).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import { findImageUrl, isSafeUrl, download } from '../gifConverterService.js';
import { logger } from '../../utils/logger.js';

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 500;
export const COOLDOWN_MS = 3_000;
export const CAPTION_WORDS = new Set(['caption', 'كابشن']);
const CAPTION_SYMBOL_PREFIX = /^[.!/-]$/u;

const FONT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../promo/fonts/Cairo-Bold.ttf');

export const TEXT = {
  noImage: '🖼️ ابعت صورة مع الأمر أو اعمل ريبلاي على صورة: `.caption الكلام هنا`',
  noText: '✍️ اكتب الكلام اللي عايزه فوق الصورة: `.caption الكلام هنا`',
  unsafe: '❌ بشتغل على الصور اللي على ديسكورد بس: ارفع الصورة أو اعمل ريبلاي عليها.',
  tooBig: '❌ الصورة كبيرة أوي، أقصى حجم 10 ميجا.',
  notImage: '❌ الملف ده مش صورة.',
  textTooLong: '❌ الكلام طويل أوي، أقصى حد 500 حرف.',
  failed: '❌ حصل خطأ أثناء إضافة الكابشن، جرّب صورة تانية.',
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
 * Creates an image or GIF with text written above it on a solid white background.
 * If input is a GIF (animated), keeps it animated as a GIF; if static, outputs PNG.
 * Uses the bundled Cairo-Bold font directly to render on Linux (Railway) and all platforms without relying on OS fonts.
 */
export async function generateCaption(imageBuffer, text) {
  const metadata = await sharp(imageBuffer, { animated: true, limitInputPixels: 40_000_000 }).metadata();
  const isGif = metadata.format === 'gif';
  const pages = metadata.pages || 1;
  const isAnimated = pages > 1;

  let width = metadata.width || 500;
  let pageHeight = metadata.pageHeight || (metadata.height ? Math.round(metadata.height / pages) : 500);

  const maxWidth = isAnimated ? 640 : 1200;
  let resizedBuffer = imageBuffer;
  if (width > maxWidth) {
    const scale = maxWidth / width;
    width = maxWidth;
    pageHeight = Math.round(pageHeight * scale);
    resizedBuffer = await sharp(imageBuffer, { animated: isAnimated, limitInputPixels: 40_000_000 })
      .resize({ width, withoutEnlargement: true })
      .toBuffer();
  }

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

  const headerBg = await sharp({
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
    .png()
    .toBuffer();

  if (isAnimated || isGif) {
    const extended = await sharp(resizedBuffer, { animated: isAnimated, limitInputPixels: 40_000_000 })
      .extend({ top: headerHeight, background: '#ffffff' })
      .toBuffer();

    const extMeta = await sharp(extended, { animated: isAnimated }).metadata();
    const extPageHeight = extMeta.pageHeight || extMeta.height;

    const compositeInputs = [];
    for (let i = 0; i < pages; i++) {
      compositeInputs.push({
        input: headerBg,
        top: Math.round(i * extPageHeight),
        left: 0,
      });
    }

    const output = await sharp(extended, { animated: isAnimated })
      .composite(compositeInputs)
      .gif({ delay: metadata.delay, loop: metadata.loop ?? 0 })
      .toBuffer();

    return { buffer: output, filename: 'caption.gif', isGif: true };
  }

  const totalHeight = headerHeight + pageHeight;
  const output = await sharp({
    create: {
      width,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: headerBg, top: 0, left: 0 },
      { input: resizedBuffer, top: headerHeight, left: 0 },
    ])
    .png()
    .toBuffer();

  return { buffer: output, filename: 'caption.png', isGif: false };
}

const lastUse = new Map();

/** For tests. */
export function resetCaptionState() {
  lastUse.clear();
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
  if (!(deps.isSafeUrl || isSafeUrl)(image.url)) {
    return respond({ content: TEXT.unsafe });
  }
  if (Number(image.size || 0) > MAX_INPUT_BYTES) {
    return respond({ content: TEXT.tooBig });
  }

  lastUse.set(userId, now);

  try {
    const bytes = await (deps.download || download)(image.url, deps.fetch, MAX_INPUT_BYTES);
    const result = await (deps.generateCaption || generateCaption)(bytes, cleanText);
    const buffer = Buffer.isBuffer(result) ? result : result.buffer;
    const filename = result?.filename || (result?.isGif ? 'caption.gif' : 'caption.png');
    return respond({
      files: [{ attachment: buffer, name: filename }],
    });
  } catch (error) {
    logger.warn('Caption generation failed:', error.message || error);
    return respond({ content: TEXT.failed });
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
      const url = await findImageUrl(message, args, deps);
      return url ? { url } : null;
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
      const isImage = attachment.contentType?.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/iu.test(attachment.name || '');
      if (!isImage) return { url: attachment.url, size: attachment.size, notImage: true };
      return { url: attachment.url, size: attachment.size };
    },
    respond,
  }, deps);
}
