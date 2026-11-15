// gifConverterService.js — `.gif` / `جيف`: turns a picture into a GIF file, for everyone.
//
// The picture comes from (first match): an image attached to the message, an image in the message being replied to
// (attachment, embed picture or link), a link in the command, or the avatar of a mentioned member.
// Only pictures hosted by Discord itself are downloaded (attachments and its image proxy), so the bot can never be
// pointed at another server or an internal address; at most MAX_INPUT_BYTES, streamed. One job per member per
// COOLDOWN_MS and MAX_JOBS at a time.
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

export const GIF_WORDS = new Set(['gif', 'جيف']);
export const MAX_INPUT_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1024;
const FETCH_TIMEOUT_MS = 10_000;
export const COOLDOWN_MS = 5_000;
export const MAX_JOBS = 3;
const lastUse = new Map(); // userId -> time
let running = 0;
const URL_PATTERN = /https:\/\/[^\s<>]+/iu;
const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?|$)/iu;

const DISCORD_IMAGE_HOSTS = [/^cdn\.discordapp\.com$/u, /^media\.discordapp\.net$/u, /^images-ext-\d+\.discordapp\.net$/u, /^cdn\.discordapp\.net$/u];

/** A link we may download: https on one of Discord's own image hosts, no credentials, no custom port. */
export function isSafeUrl(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    return DISCORD_IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname.toLowerCase()));
}

const isImageAttachment = (attachment) => Boolean(attachment?.contentType?.startsWith('image/') || IMAGE_NAME.test(attachment?.name || attachment?.url || ''));

function imageFromMessage(message) {
    const attachment = [...(message?.attachments?.values?.() || [])].find(isImageAttachment);
    if (attachment) return attachment.url;
    for (const embed of message?.embeds || []) {
        const url = embed.image?.url || embed.thumbnail?.url || (embed.type === 'image' ? embed.url : null);
        if (url) return url;
    }
    const link = URL_PATTERN.exec(message?.content || '')?.[0];
    return link && IMAGE_NAME.test(link) ? link : null;
}

/** Where the picture is: a URL, or null when the message gives none. */
export async function findImageUrl(message, args = []) {
    const own = imageFromMessage(message);
    if (own) return own;
    if (message.reference?.messageId) {
        const replied = await message.fetchReference().catch(() => null);
        const fromReply = imageFromMessage(replied);
        if (fromReply) return fromReply;
    }
    const link = args.map((arg) => URL_PATTERN.exec(arg)?.[0]).find(Boolean);
    if (link) return link;
    const mentioned = message.mentions?.users?.first?.();
    return mentioned?.displayAvatarURL?.({ extension: 'png', size: 1024 }) || null;
}

async function download(url, fetchImpl = fetch) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    if (Number(response.headers.get('content-length') || 0) > MAX_INPUT_BYTES) throw new Error('too big');
    // Count the bytes as they arrive and stop at the limit, whatever the server claims.
    if (!response.body?.getReader) {
        const whole = Buffer.from(await response.arrayBuffer());
        if (whole.length > MAX_INPUT_BYTES) throw new Error('too big');
        return whole;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_INPUT_BYTES) { await reader.cancel().catch(() => {}); throw new Error('too big'); }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** Converts picture bytes to a GIF (an animated picture stays animated). Throws when the bytes are not a picture. */
export async function toGif(bytes) {
    for (const side of [MAX_SIDE, 640, 400]) {
        const gif = await sharp(bytes, { animated: true, limitInputPixels: 40_000_000 })
            .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
            .gif()
            .toBuffer();
        if (gif.length <= MAX_OUTPUT_BYTES) return gif;
    }
    throw new Error('too big');
}

async function say(message, content) {
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    return true;
}

/** `.gif` handler. Returns true when the message was a gif command. */
export async function handleGifCommand(message, args = [], deps = {}) {
    if (!message.guild) return false;
    const now = (deps.now || Date.now)();
    if (now - (lastUse.get(message.author?.id) || 0) < COOLDOWN_MS) return say(message, '⏳ استنى ثواني قبل ما تحوّل صورة تانية.');
    if (running >= MAX_JOBS) return say(message, '⏳ البوت بيحوّل صور كتير دلوقتي، جرّب بعد شوية.');
    // The slot is taken before the first await, so two messages arriving together can't both slip past the checks.
    lastUse.set(message.author?.id, now);
    running += 1;
    try {
        const url = await findImageUrl(message, args);
        if (!url) return await say(message, '🖼️ ابعت صورة مع الأمر، أو اعمل ريبلاي على صورة واكتب `gif`.');
        if (!(deps.isSafeUrl || isSafeUrl)(url)) return await say(message, '❌ بحوّل الصور اللي على ديسكورد بس: ارفع الصورة أو اعمل ريبلاي عليها.');
        const bytes = await download(url, deps.fetch);
        const gif = await toGif(bytes);
        await message.reply({ files: [{ attachment: gif, name: 'image.gif' }], allowedMentions: { parse: [], repliedUser: false } });
    } catch (error) {
        logger.warn(`[GIF] conversion failed: ${error.message}`);
        await say(message, error.message === 'too big' ? '❌ الصورة كبيرة أوي.' : '❌ معرفتش أحوّل الملف ده، لازم يكون صورة.');
    } finally {
        running -= 1;
    }
    return true;
}
