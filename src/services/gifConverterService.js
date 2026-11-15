// gifConverterService.js — `.gif` / `جيف`: turns a picture into a GIF file, for everyone.
//
// The picture comes from (first match): an image attached to the message, an image in the message being replied to
// (attachment, embed picture or link), a link in the command, or the avatar of a mentioned member.
// Only public https links are downloaded (never a local or private address), at most MAX_INPUT_BYTES.
import dns from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

export const GIF_WORDS = new Set(['gif', 'جيف']);
export const MAX_INPUT_BYTES = 12 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1024;
const FETCH_TIMEOUT_MS = 10_000;
const URL_PATTERN = /https:\/\/[^\s<>]+/iu;
const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)(?:\?|$)/iu;

const PRIVATE_V4 = [/^10\./u, /^127\./u, /^0\./u, /^169\.254\./u, /^192\.168\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u, /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u, /^192\.0\.0\./u];

/** Whether an IP address is private, local or otherwise not a public internet address. */
export function isPrivateAddress(address) {
    if (net.isIPv4(address)) return PRIVATE_V4.some((pattern) => pattern.test(address));
    const lower = String(address).toLowerCase();
    if (lower === '::1' || lower === '::' || /^f[cd]/u.test(lower) || lower.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower);
    return mapped ? isPrivateAddress(mapped[1]) : false;
}

/** A link we may download: https, a normal host name (not an address or a local name) that resolves to public addresses only. */
export async function isSafeUrl(value, lookup = dns.lookup) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (net.isIP(host) || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return false;
    try {
        const addresses = await lookup(host, { all: true });
        return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
    } catch {
        return false;
    }
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
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_INPUT_BYTES) throw new Error('too big');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_INPUT_BYTES) throw new Error('too big');
    return bytes;
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
    const url = await findImageUrl(message, args);
    if (!url) return say(message, '🖼️ ابعت صورة مع الأمر، أو اعمل ريبلاي على صورة واكتب `gif`.');
    if (!(await (deps.isSafeUrl || isSafeUrl)(url))) return say(message, '❌ اللينك ده مش مقبول، استخدم صورة مرفقة أو لينك https عادي.');
    try {
        const bytes = await download(url, deps.fetch);
        const gif = await toGif(bytes);
        await message.reply({ files: [{ attachment: gif, name: 'image.gif' }], allowedMentions: { parse: [], repliedUser: false } });
    } catch (error) {
        logger.warn(`[GIF] conversion failed: ${error.message}`);
        await say(message, error.message === 'too big' ? '❌ الصورة كبيرة أوي.' : '❌ معرفتش أحوّل الملف ده، لازم يكون صورة.');
    }
    return true;
}
