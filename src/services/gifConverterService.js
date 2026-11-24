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
const VIDEO_NAME = /\.(?:mp4|webm|mov|m4v|mkv)(?:\?|$)/iu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

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

/** Unwraps a Discord proxy URL like https://images-ext-1.discordapp.net/external/.../https/media.tenor.com/... */
export function unwrapDiscordProxyUrl(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (/^images-ext-\d+\.discordapp\.net$/u.test(u.hostname.toLowerCase())) {
            const match = u.pathname.match(/\/external\/[^/]+\/(https?)\/(.+)/i);
            if (match) {
                const unwrapped = `${match[1]}://${match[2]}${u.search || ''}`;
                // Only Tenor and Giphy are unwrapped; external hosts like Imgur need Discord's proxy to satisfy isSafeUrl.
                // The animated format is picked later (tenorGifUrls / giphyGifUrls).
                if (isTenorOrGiphy(unwrapped)) return unwrapped;
            }
        }
    } catch {}
    return url;
}

// GH #325: a Tenor media link is `media.tenor.com/<id><format>/<name>.<ext>`, the format being the last 5
// characters of the first part. AAAAd (mediumgif), AAAAC (gif) and AAAAM (tinygif) are animated; the others are not:
// AAAAe is the preview a Discord GIF embed shows as its thumbnail (ONE still frame, even served as image/gif), AAAPo is
// the mp4, AAAA1 the webp. Only swapping `.png` for `.gif` kept the still preview, so the caption came out still.
const TENOR_MEDIA_HOST = /^(?:media\d*|c)\.tenor\.com$/u;
const TENOR_MEDIA_PATH = /^\/(?:m\/)?([A-Za-z0-9_-]+)(AAA[A-Za-z0-9_-]{2})\/([^/]+)\.[a-z0-9]+$/iu;
export const TENOR_GIF_FORMATS = ['AAAAd', 'AAAAC', 'AAAAM'];

/** The animated GIF links of the GIF behind any Tenor media link, best first ([] when it is not one). */
export function tenorGifUrls(value) {
    let url;
    try { url = new URL(value); } catch { return []; }
    if (url.protocol !== 'https:' || !TENOR_MEDIA_HOST.test(url.hostname.toLowerCase())) return [];
    const match = TENOR_MEDIA_PATH.exec(url.pathname);
    if (!match) return [];
    const [, id, , name] = match;
    return TENOR_GIF_FORMATS.map((format) => `https://media.tenor.com/${id}${format}/${name}.gif`);
}

// Giphy: `media.giphy.com/media/<id>/<file>` (or `/media/v1.<token>/<id>/<file>`, or `i.giphy.com/<id>.gif`).
// `giphy_s.gif` / `200w_s.gif` are still frames, and the mp4 / webp copies are not GIFs.
const GIPHY_MEDIA_HOST = /^(?:media\d*|i)\.giphy\.com$/u;
const GIPHY_NOT_ANIMATED_GIF = /(?:_s\.gif|\.mp4|\.webp|\.png|\.jpe?g)$/iu;
const GIPHY_GIF_FILES = ['giphy.gif', 'giphy-downsized-medium.gif', '200w.gif'];

/** The animated GIF links of the GIF behind a Giphy media link, best first ([] when it is not one). */
export function giphyGifUrls(value) {
    let url;
    try { url = new URL(value); } catch { return []; }
    if (url.protocol !== 'https:' || !GIPHY_MEDIA_HOST.test(url.hostname.toLowerCase())) return [];
    const parts = url.pathname.split('/').filter(Boolean);
    const file = parts[parts.length - 1] || '';
    const id = parts[0] === 'media' && parts.length >= 3 ? parts[parts.length - 2]
        : parts.length === 1 ? file.replace(/\.[a-z0-9]+$/iu, '') : null;
    if (!id || !/^[A-Za-z0-9]+$/u.test(id)) return [];
    const animated = GIPHY_GIF_FILES.map((name) => `https://i.giphy.com/media/${id}/${name}`);
    // A link that already is an animated GIF (`giphy.gif`, `200w.gif`...) is tried as it is first.
    const links = GIPHY_NOT_ANIMATED_GIF.test(file) || !/\.gif$/iu.test(file) ? animated : [url.href, ...animated];
    return [...new Set(links)];
}

/** The links to try for a picture, best first: the animated GIFs of a Tenor / Giphy link, else the link itself. */
export function animatedCandidates(value) {
    if (!value) return [];
    const url = unwrapDiscordProxyUrl(value);
    const tenor = tenorGifUrls(url);
    if (tenor.length) return tenor;
    const giphy = giphyGifUrls(url);
    return giphy.length ? giphy : [url];
}

// A Tenor page names its own GIF in og:image, image_src and contentUrl. The first AAAAM GIF in the page is one of the
// related GIFs listed under it (GH #325), so the page's own tags are read instead.
const TENOR_PAGE_GIF_PATTERNS = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/iu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/iu,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/iu,
    /<meta[^>]+itemprop=["']contentUrl["'][^>]+content=["']([^"']+\.gif)["']/iu,
    /"contentUrl":\s*"([^"]+\.gif)"/iu,
];

function tenorGifFromPage(html) {
    for (const pattern of TENOR_PAGE_GIF_PATTERNS) {
        const found = pattern.exec(html)?.[1]?.replace(/\\u002F/giu, '/').replace(/&amp;/gu, '&');
        if (!found) continue;
        const gif = tenorGifUrls(found)[0] || (/\.gif(?:\?|$)/iu.test(found) && isSafeUrl(found) ? found : null);
        if (gif) return gif;
    }
    return null;
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
    const cleanUrl = unwrapDiscordProxyUrl(rawUrl);
    // A media link (any format, the still preview included) names its GIF already: no page to read.
    const direct = tenorGifUrls(cleanUrl)[0] || giphyGifUrls(cleanUrl)[0];
    if (direct) return direct;
    if (resolvedCache.has(cleanUrl)) return resolvedCache.get(cleanUrl);

    try {
        const u = new URL(cleanUrl);
        const host = u.hostname.toLowerCase();

        // Tenor page link: https://tenor.com/view/..., or a short https://tenor.com/<code>.gif link that redirects.
        if (host === 'tenor.com' || host === 'www.tenor.com') {
            const res = await fetchImpl(cleanUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) {
                const landed = res.url ? tenorGifUrls(res.url)[0] : null;
                if (landed) {
                    await res.body?.cancel?.().catch?.(() => {});
                    cacheResolved(cleanUrl, landed);
                    return landed;
                }
                const gif = tenorGifFromPage(await res.text());
                if (gif) {
                    cacheResolved(cleanUrl, gif);
                    return gif;
                }
            }
        }

        // Giphy page link: https://giphy.com/gifs/...
        if (host === 'giphy.com' || host === 'www.giphy.com') {
            const match = cleanUrl.match(/\/gifs\/(?:.*-)?([a-zA-Z0-9]+)(?:$|\/|\?)/);
            if (match?.[1]) {
                const direct = `https://i.giphy.com/media/${match[1]}/giphy.gif`;
                cacheResolved(cleanUrl, direct);
                return direct;
            }
            const res = await fetchImpl(cleanUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) {
                const html = await res.text();
                const gifMatch = html.match(/https:\/\/media\d*\.giphy\.com\/media\/[^\s"'<>]+\/giphy\.gif/i)?.[0];
                if (gifMatch) {
                    cacheResolved(cleanUrl, gifMatch);
                    return gifMatch;
                }
            }
        }
    } catch (err) {
        logger.warn(`[MEDIA] resolve failed for ${cleanUrl}: ${err.message}`);
    }

    return cleanUrl;
}

/** A link we may download: https on one of Discord, Tenor, or Giphy image hosts, no credentials, no custom port. */
export function isSafeUrl(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    return DISCORD_IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname.toLowerCase()));
}

const isImageAttachment = (attachment) => Boolean(attachment?.contentType?.startsWith('image/') || IMAGE_NAME.test(attachment?.name || attachment?.url || ''));
const isVideoAttachment = (attachment) => Boolean(attachment?.contentType?.startsWith('video/') || VIDEO_NAME.test(attachment?.name || '') || VIDEO_NAME.test(attachment?.url || ''));

/** The links among `links` we may download, each once, in order. */
const safeLinks = (...links) => [...new Set(links.filter((link) => link && isSafeUrl(link)))];

/** The video of an embed (a `gifv` from the GIF picker, a video link) as `{ candidates }`: its own link, then Discord's proxy copy. */
function embedVideo(embed) {
    const candidates = safeLinks(embed?.video?.url, embed?.video?.proxyURL);
    return candidates.length ? { candidates } : null;
}

/**
 * The source for an uploaded video (an mp4 / webm / mov attachment), or null when it is not one: no picture to try,
 * only the video, which `.caption` turns into a GIF.
 */
export function videoAttachmentSource(attachment) {
    if (!isVideoAttachment(attachment)) return null;
    const candidates = safeLinks(attachment.url, attachment.proxyURL);
    if (!candidates.length) return null;
    return { url: candidates[0], candidates: [], videoStill: false, video: { candidates, size: attachment.size } };
}

/**
 * The animated GIF of a Tenor / Giphy embed (a GIF sent from Discord's GIF picker is a `gifv` embed: a still
 * thumbnail and an mp4), built from the embed's own media links: the exact GIF that was posted, with no page to
 * read (GH #325). Null when the embed has none.
 */
function embedGifUrl(embed) {
    const links = [embed?.video?.url, embed?.thumbnail?.url, embed?.image?.url, embed?.video?.proxyURL, embed?.thumbnail?.proxyURL, embed?.image?.proxyURL];
    for (const link of links) {
        if (!link) continue;
        const unwrapped = unwrapDiscordProxyUrl(link);
        const gif = tenorGifUrls(unwrapped)[0] || giphyGifUrls(unwrapped)[0];
        if (gif) return gif;
    }
    return null;
}

/** The picture of an embed with no Tenor / Giphy media link: `{ url, page, videoStill }`, or null. */
function embedPicture(embed) {
    // A Tenor / Giphy page: its GIF is read from the page.
    if (embed.url && isTenorOrGiphy(embed.url)) {
        return { url: embed.url, page: true };
    }
    const proxyCandidate = embed.thumbnail?.url || embed.image?.url || embed.thumbnail?.proxyURL || embed.image?.proxyURL;
    if (proxyCandidate) {
        const unwrapped = unwrapDiscordProxyUrl(proxyCandidate);
        if (isTenorOrGiphy(unwrapped)) {
            return { url: unwrapped };
        }
    }
    if (embed.image?.url && isSafeUrl(embed.image.url)) {
        return { url: embed.image.url };
    }
    if (embed.thumbnail?.url && isSafeUrl(embed.thumbnail.url) && IMAGE_NAME.test(embed.thumbnail.url)) {
        return { url: embed.thumbnail.url };
    }
    // Prefer Discord's proxy copy for external images: the plain URL of a link embed is an outside site.
    const fallback = embed.image?.proxyURL || embed.thumbnail?.proxyURL || embed.image?.url || embed.thumbnail?.url || (embed.type === 'image' ? embed.url : null);
    // A video GIF (`gifv`) from another site only has a still thumbnail here: sharp cannot read its mp4.
    if (fallback) return { url: fallback, videoStill: embed.type === 'gifv' || Boolean(embed.video?.url) };
    return null;
}

/**
 * `{ url, videoStill, video, videoOnly }` of the picture in a message, or null. `videoStill`: only the still thumbnail
 * of a video GIF. With `videos` (`.caption`, which turns a video into a GIF): `video` is `{ candidates }`, the links of
 * the message's video, and `videoOnly` a source that is only a video (an uploaded mp4, say).
 */
function sourceFromMessage(message, { videos = false } = {}) {
    const attachments = [...(message?.attachments?.values?.() || [])];
    const attachment = attachments.find(isImageAttachment);
    if (attachment) return { url: attachment.url };
    if (videos) {
        const clip = attachments.map(videoAttachmentSource).find(Boolean);
        if (clip) return { ...clip, videoOnly: true };
    }

    for (const embed of message?.embeds || []) {
        const gif = embedGifUrl(embed);
        if (gif) return videos ? { url: gif, video: embedVideo(embed) } : { url: gif };
    }

    // Check message content for Tenor / Giphy or direct safe Discord attachment links FIRST
    // so animated GIFs take precedence over static proxy thumbnails, while external links still use Discord's proxy.
    const words = String(message?.content || '').split(/\s+/u);
    for (const w of words) {
        const link = URL_PATTERN.exec(w)?.[0];
        if (link && (isTenorOrGiphy(link) || (isSafeUrl(link) && IMAGE_NAME.test(link)))) {
            // A Tenor / Giphy mp4 link gives its GIF, the mp4 itself being the fallback.
            return videos && VIDEO_NAME.test(link) ? { url: link, video: { candidates: [link] } } : { url: link };
        }
        if (videos && link && isSafeUrl(link) && VIDEO_NAME.test(link)) {
            return { url: link, videoOnly: true, video: { candidates: [link] } };
        }
    }

    for (const embed of message?.embeds || []) {
        const picture = embedPicture(embed);
        const video = videos ? embedVideo(embed) : null;
        if (!video) {
            if (picture) return picture;
            continue;
        }
        if (!picture) return { url: video.candidates[0], videoOnly: true, video };
        // A Tenor / Giphy page gives the real GIF (the video is its fallback); anything else here is only the
        // video's still thumbnail, so the video is tried first.
        return { ...picture, video, videoStill: !picture.page };
    }
    return null;
}

/**
 * A GIF / WebP link on Discord's media proxy (media.discordapp.net/attachments/...) can come back resized or as a
 * still picture: the original file on cdn.discordapp.com (same signed ex/is/hm query) keeps its animation.
 */
export function originalDiscordFile(value) {
    let url;
    try { url = new URL(value); } catch { return value; }
    if (url.hostname.toLowerCase() !== 'media.discordapp.net' || !/^\/(?:ephemeral-)?attachments\//u.test(url.pathname) || !/\.(?:gif|webp)$/iu.test(url.pathname)) return value;
    url.hostname = 'cdn.discordapp.com';
    for (const key of ['width', 'height', 'format', 'quality', 'animated']) url.searchParams.delete(key);
    return url.toString();
}

/**
 * Where the picture is: `{ url, candidates, videoStill }`, or null when the message gives none. `candidates` are the
 * links to download, best first (for Tenor / Giphy: the animated GIF formats, smaller ones as a fallback).
 */
export async function findImageSource(message, args = [], deps = {}) {
    return findSource(message, args, deps, { videos: false });
}

/**
 * Like findImageSource, for `.caption`, which can turn a video into a GIF: also `video` (`{ candidates, size }`, the
 * links of the video GIF / video, or null). A source that is only a video (an uploaded mp4) has no `candidates`.
 */
export async function findMediaSource(message, args = [], deps = {}) {
    return findSource(message, args, deps, { videos: true });
}

async function findSource(message, args, deps, { videos }) {
    const fetchImpl = deps?.fetch || fetch;
    let source = sourceFromMessage(message, { videos });
    if (!source && message.reference?.messageId) {
        const replied = await message.fetchReference().catch(() => null);
        source = sourceFromMessage(replied, { videos });
    }
    if (!source) {
        const link = args.map((arg) => URL_PATTERN.exec(arg)?.[0]).find(Boolean);
        if (link && (isTenorOrGiphy(link) || IMAGE_NAME.test(link))) source = { url: link };
        else if (videos && link && isSafeUrl(link) && VIDEO_NAME.test(link)) source = { url: link, videoOnly: true, video: { candidates: [link] } };
    }
    if (!source) {
        const mentioned = message.mentions?.users?.first?.();
        const avatar = mentioned?.displayAvatarURL?.({ extension: 'png', size: 1024 });
        if (avatar) source = { url: avatar };
    }
    if (!source?.url) return null;
    if (source.videoOnly) return { url: source.url, candidates: [], videoStill: false, video: source.video };
    let url = unwrapDiscordProxyUrl(source.url);
    if (isTenorOrGiphy(url)) url = await (deps?.resolveMediaUrl || resolveMediaUrl)(url, fetchImpl);
    url = originalDiscordFile(url);
    const found = { url, candidates: animatedCandidates(url), videoStill: Boolean(source.videoStill) };
    return videos ? { ...found, video: source.video || null } : found;
}

/** Where the picture is: a URL, or null when the message gives none. */
export async function findImageUrl(message, args = [], deps = {}) {
    return (await findImageSource(message, args, deps))?.url ?? null;
}

/**
 * Downloads a picture, streamed and stopped at `maxBytes` (error 'too big'). Also used by `شيل الخلفية`.
 * A redirect is followed only to a link that passes `safe` (at most MAX_REDIRECTS), else error 'unsafe redirect'.
 */
export async function download(url, fetchImpl = fetch, maxBytes = MAX_INPUT_BYTES, { timeoutMs = FETCH_TIMEOUT_MS, safe = isSafeUrl } = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    let response;
    for (let redirects = 0; ; redirects += 1) {
        response = await fetchImpl(current, { signal, redirect: 'manual' });
        const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get?.('location') : null;
        if (!location) break;
        await response.body?.cancel?.().catch?.(() => {});
        let next;
        try { next = new URL(location, current).href; } catch { throw new Error('unsafe redirect'); }
        if (redirects >= MAX_REDIRECTS || !safe(next)) throw new Error('unsafe redirect');
        current = next;
    }
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) {
        await response.body?.cancel?.().catch?.(() => {});
        throw new Error('too big');
    }
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

/**
 * Downloads the first of `urls` that works (a Tenor format that is missing or too big falls back to the next one).
 * Only links that pass `safe` are tried. Throws the last error when none works.
 */
export async function downloadFirst(urls, { fetch: fetchImpl = fetch, maxBytes = MAX_INPUT_BYTES, download: get = download, safe = isSafeUrl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    let lastError = new Error('download failed');
    for (const url of urls.filter((candidate) => safe(candidate))) {
        try {
            return { bytes: await get(url, fetchImpl, maxBytes, { timeoutMs, safe }), url };
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
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
        const source = await findImageSource(message, args, deps);
        if (!source) return await say(message, '🖼️ ابعت صورة مع الأمر، أو اعمل ريبلاي على صورة واكتب `gif`.');
        const safe = deps.isSafeUrl || isSafeUrl;
        if (!safe(source.url)) return await say(message, '❌ بحوّل الصور اللي على ديسكورد بس: ارفع الصورة أو اعمل ريبلاي عليها.');
        const { bytes } = await downloadFirst(source.candidates, { fetch: deps.fetch, safe });
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
