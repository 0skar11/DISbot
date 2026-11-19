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
// `.gif` is what members type, whatever the bot's configured prefix is (PREFIX defaults to `!`), so a gif word
// right after one of these symbols counts too. The bare word in a chat is still left alone.
const GIF_SYMBOL_PREFIX = /^[.!/-]$/u;

/** Whether a parsed typed command (parseTypedCommand) is the gif command: `<prefix>gif`, `.gif`, `!جيف`... */
export function isGifCommand(parsed) {
    if (!parsed?.commandName) return false;
    const name = parsed.commandName.toLowerCase();
    if (parsed.prefixed) return GIF_WORDS.has(name);
    return GIF_SYMBOL_PREFIX.test(name.slice(0, 1)) && GIF_WORDS.has(name.slice(1));
}
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

const DISCORD_IMAGE_HOSTS = [
    /^cdn\.discordapp\.com$/u,
    /^media\.discordapp\.net$/u,
    /^images-ext-\d+\.discordapp\.net$/u,
    /^cdn\.discordapp\.net$/u,
    /(?:^|\.)tenor\.com$/u,
    /(?:^|\.)giphy\.com$/u,
];

/** Whether a URL belongs to Tenor or Giphy. */
export function isTenorOrGiphy(value) {
    if (!value) return false;
    let url;
    try { url = new URL(value); } catch { return false; }
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)tenor\.com$/u.test(host) || /(?:^|\.)giphy\.com$/u.test(host);
}

const resolvedCache = new Map();

function cacheResolved(key, value) {
    if (resolvedCache.size > 200) {
        const first = resolvedCache.keys().next().value;
        resolvedCache.delete(first);
    }
    resolvedCache.set(key, value);
}

/** Resolves a Tenor or Giphy link to its direct animated .gif URL. */
export async function resolveMediaUrl(rawUrl, fetchImpl = fetch) {
    if (!rawUrl) return null;
    if (resolvedCache.has(rawUrl)) return resolvedCache.get(rawUrl);

    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();

        // Direct gif link on Tenor / Giphy
        if (IMAGE_NAME.test(u.pathname) && (host.endsWith('tenor.com') || host.endsWith('giphy.com'))) {
            return rawUrl;
        }

        // Tenor page link: https://tenor.com/view/... or https://tenor.com/...
        if (host === 'tenor.com' || host === 'www.tenor.com') {
            const res = await fetchImpl(rawUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) {
                const html = await res.text();
                const contentUrl = html.match(/"contentUrl":\s*"([^"]+\.gif)"/i)?.[1]?.replace(/\\u002F/g, '/');
                if (contentUrl) {
                    cacheResolved(rawUrl, contentUrl);
                    return contentUrl;
                }
                const imageSrc = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+\.gif)["']/i)?.[1];
                if (imageSrc) {
                    cacheResolved(rawUrl, imageSrc);
                    return imageSrc;
                }
                const anyGif = html.match(/https:\/\/(?:media\d*|c)\.tenor\.com\/[^\s"'<>]+\.gif/i)?.[0];
                if (anyGif) {
                    cacheResolved(rawUrl, anyGif);
                    return anyGif;
                }
            }
        }

        // Giphy page link: https://giphy.com/gifs/...
        if (host === 'giphy.com' || host === 'www.giphy.com') {
            const match = rawUrl.match(/\/gifs\/(?:.*-)?([a-zA-Z0-9]+)(?:$|\/|\?)/);
            if (match?.[1]) {
                const direct = `https://i.giphy.com/media/${match[1]}/giphy.gif`;
                cacheResolved(rawUrl, direct);
                return direct;
            }
            const res = await fetchImpl(rawUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) {
                const html = await res.text();
                const gifMatch = html.match(/https:\/\/media\d*\.giphy\.com\/media\/[^\s"'<>]+\/giphy\.gif/i)?.[0];
                if (gifMatch) {
                    cacheResolved(rawUrl, gifMatch);
                    return gifMatch;
                }
            }
        }
    } catch (err) {
        logger.warn(`[MEDIA] resolve failed for ${rawUrl}: ${err.message}`);
    }

    return rawUrl;
}

/** A link we may download: https on one of Discord, Tenor, or Giphy image hosts, no credentials, no custom port. */
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
        if (embed.url && isTenorOrGiphy(embed.url)) {
            return embed.url;
        }
        if (embed.image?.url && isSafeUrl(embed.image.url)) {
            return embed.image.url;
        }
        if (embed.thumbnail?.url && isSafeUrl(embed.thumbnail.url) && (IMAGE_NAME.test(embed.thumbnail.url) || isTenorOrGiphy(embed.thumbnail.url))) {
            return embed.thumbnail.url;
        }
        // Prefer Discord's proxy copy for external images: the plain URL of a link embed is an outside site.
        const fallback = embed.image?.proxyURL || embed.thumbnail?.proxyURL || embed.image?.url || embed.thumbnail?.url || (embed.type === 'image' ? embed.url : null);
        if (fallback) return fallback;
    }
    const link = URL_PATTERN.exec(message?.content || '')?.[0];
    if (link && (isTenorOrGiphy(link) || IMAGE_NAME.test(link))) return link;
    return null;
}

/** Where the picture is: a URL, or null when the message gives none. */
export async function findImageUrl(message, args = [], deps = {}) {
    const fetchImpl = deps?.fetch || fetch;
    let url = imageFromMessage(message);
    if (!url && message.reference?.messageId) {
        const replied = await message.fetchReference().catch(() => null);
        url = imageFromMessage(replied);
    }
    if (!url) {
        const link = args.map((arg) => URL_PATTERN.exec(arg)?.[0]).find(Boolean);
        if (link && (isTenorOrGiphy(link) || IMAGE_NAME.test(link))) url = link;
    }
    if (!url) {
        const mentioned = message.mentions?.users?.first?.();
        url = mentioned?.displayAvatarURL?.({ extension: 'png', size: 1024 }) || null;
    }
    if (url && isTenorOrGiphy(url)) {
        url = await (deps?.resolveMediaUrl || resolveMediaUrl)(url, fetchImpl);
    }
    return url;
}

/** Downloads a picture, streamed and stopped at `maxBytes` (error 'too big'). Also used by `شيل الخلفية`. */
export async function download(url, fetchImpl = fetch, maxBytes = MAX_INPUT_BYTES) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('too big');
    // Count the bytes as they arrive and stop at the limit, whatever the server claims.
    if (!response.body?.getReader) {
        const whole = Buffer.from(await response.arrayBuffer());
        if (whole.length > maxBytes) throw new Error('too big');
        return whole;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('too big'); }
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
    const payload = { content, allowedMentions: { parse: [], repliedUser: false } };
    // If the reply fails (the message was deleted, say), still tell the member in the channel.
    await message.reply(payload).catch(() => message.channel?.send?.(payload)).catch((error) => logger.warn(`[GIF] could not answer: ${error.message}`));
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
        const url = await findImageUrl(message, args, deps);
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
