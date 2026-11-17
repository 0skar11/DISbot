// removeBgService.js: `شيل الخلفية` / `removebg` (typed) and `/removebg` (slash), report #286: a picture comes back
// as a PNG with a transparent background. Everyone, every server.
//
// Typed: the same rules as `.gif` (gifConverterService.js): the prefix or a `.`/`!` in front (`.removebg`,
// `.شيل الخلفية`), the bare words in a chat are left alone. The picture: one attached to the message, or in the
// message being replied to (or a Discord link / mentioned member's avatar, like `.gif`). Limits: MAX_INPUT_BYTES,
// one job at a time in the whole bot (a short queue after it), one job per member per COOLDOWN_MS, a timeout.
// The work itself runs in a worker thread (removeBgEngine.js).
import { findImageUrl, isSafeUrl, download } from '../gifConverterService.js';
import { removeBackground, DEFAULT_TIMEOUT_MS } from './removeBgEngine.js';
import { logger } from '../../utils/logger.js';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const COOLDOWN_MS = 20_000;
export const MAX_WAITING = 5;
export const TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const SYMBOL_PREFIX = /^[.!/-]$/u;
const BACKGROUND_WORDS = new Set(['الخلفية', 'الخلفيه']);

export const TEXT = {
    cooldown: (seconds) => `⏳ استنى ${seconds} ثانية قبل ما تشيل خلفية صورة تانية.`,
    busy: '⏳ البوت بيشيل خلفيات صور كتير دلوقتي، جرّب بعد شوية.',
    queued: (ahead) => `⏳ في ${ahead} صورة قبلك، هتوصلك أول ما دورك ييجي.`,
    noImage: '🖼️ ابعت صورة مع الأمر، أو اعمل ريبلاي على صورة واكتب `.شيل الخلفية`.',
    unsafe: '❌ بشتغل على الصور اللي على ديسكورد بس: ارفع الصورة أو اعمل ريبلاي عليها.',
    tooBig: '❌ الصورة كبيرة أوي، أقصى حجم 8 ميجا.',
    notImage: '❌ الملف ده مش صورة.',
    timeout: '❌ شيل الخلفية أخد وقت طويل أوي، جرّب صورة أصغر.',
    unavailable: '❌ خاصية شيل الخلفية مش شغالة دلوقتي، جرّب بعدين.',
    failed: '❌ معرفتش أشيل خلفية الصورة دي، جرّب صورة تانية.',
};

/** Whether a parsed typed command is this one: `<prefix>removebg`, `.removebg`, `.شيل الخلفية`... */
export function isRemoveBgCommand(parsed) {
    if (!parsed?.commandName) return false;
    const name = parsed.commandName.toLowerCase();
    const word = parsed.prefixed ? name : (SYMBOL_PREFIX.test(name.slice(0, 1)) ? name.slice(1) : null);
    if (word === 'removebg') return true;
    return word === 'شيل' && BACKGROUND_WORDS.has(parsed.args?.[0]);
}

/** The arguments after the command words (`شيل الخلفية <link>` -> [link]). */
export function removeBgArgs(parsed) {
    const name = parsed.commandName.toLowerCase();
    return name.endsWith('removebg') ? parsed.args : parsed.args.slice(1);
}

const lastUse = new Map(); // userId -> time
let waiting = 0; // jobs running or queued
let queueTail = Promise.resolve();

/** For the tests. */
export function resetRemoveBgState() {
    lastUse.clear();
    waiting = 0;
    queueTail = Promise.resolve();
}

/** Runs `task` after the jobs before it; null when the queue is full. `ahead`: how many jobs are before it. */
export function enqueueJob(task) {
    if (waiting >= MAX_WAITING) return null;
    const ahead = waiting;
    waiting += 1;
    const done = queueTail.then(task);
    queueTail = done.then(() => {}, () => {}).finally(() => { waiting -= 1; });
    return { ahead, done };
}

function errorText(error) {
    const code = error?.code || error?.message;
    if (code === 'too big') return TEXT.tooBig;
    if (code === 'not image') return TEXT.notImage;
    if (code === 'timeout') return TEXT.timeout;
    if (code === 'unavailable') return TEXT.unavailable;
    return TEXT.failed;
}

/**
 * The shared path. `getImage()` -> { url, size? } or null; `respond(payload)` answers the member (text or the file);
 * `notify(text)` an optional note while waiting in the queue. Returns what was answered, for the tests.
 */
export async function runRemoveBg({ userId, getImage, respond, notify }, deps = {}) {
    const now = (deps.now || Date.now)();
    const last = lastUse.get(userId);
    if (last !== undefined && now - last < COOLDOWN_MS) {
        return respond({ content: TEXT.cooldown(Math.ceil((COOLDOWN_MS - (now - last)) / 1000)) });
    }
    // Taken before the first await so two messages together can't both pass; given back when nothing ran.
    lastUse.set(userId, now);
    const giveBack = () => { if (last === undefined) lastUse.delete(userId); else lastUse.set(userId, last); };
    const image = await getImage();
    if (!image?.url) { giveBack(); return respond({ content: TEXT.noImage }); }
    if (image.notImage) { giveBack(); return respond({ content: TEXT.notImage }); }
    if (!(deps.isSafeUrl || isSafeUrl)(image.url)) { giveBack(); return respond({ content: TEXT.unsafe }); }
    if (Number(image.size || 0) > MAX_INPUT_BYTES) { giveBack(); return respond({ content: TEXT.tooBig }); }
    const job = enqueueJob(async () => {
        const bytes = await download(image.url, deps.fetch, MAX_INPUT_BYTES);
        return (deps.removeBackground || removeBackground)(bytes, { timeoutMs: TIMEOUT_MS });
    });
    if (!job) { giveBack(); return respond({ content: TEXT.busy }); }
    if (job.ahead > 0) await notify?.(TEXT.queued(job.ahead));
    try {
        const png = await job.done;
        return await respond({ files: [{ attachment: png, name: 'no-background.png' }] });
    } catch (error) {
        logger.warn(`[REMOVEBG] failed: ${error.code || ''} ${error.message}`);
        return respond({ content: errorText(error) });
    }
}

/** Typed handler. Returns true when the message was this command. */
export async function handleRemoveBgCommand(message, args = [], deps = {}) {
    if (!message.guild) return false;
    const respond = async (payload) => {
        const full = { ...payload, allowedMentions: { parse: [], repliedUser: false } };
        await message.reply(full).catch(() => message.channel?.send?.(full))
            .catch((error) => logger.warn(`[REMOVEBG] could not answer: ${error.message}`));
        return payload;
    };
    await runRemoveBg({
        userId: message.author?.id,
        getImage: async () => {
            message.channel?.sendTyping?.().catch?.(() => {});
            const url = await findImageUrl(message, args);
            return url ? { url } : null;
        },
        respond,
        notify: (content) => respond({ content }),
    }, deps);
    return true;
}

/** Slash handler: `/removebg image:<attachment>`. */
export async function handleRemoveBgInteraction(interaction, deps = {}) {
    const attachment = interaction.options?.getAttachment?.('image');
    await interaction.deferReply().catch(() => {});
    const respond = async (payload) => {
        // content '' clears a queue note left on the deferred reply.
        await interaction.editReply({ content: '', ...payload, allowedMentions: { parse: [] } })
            .catch((error) => logger.warn(`[REMOVEBG] could not answer: ${error.message}`));
        return payload;
    };
    return runRemoveBg({
        userId: interaction.user?.id,
        getImage: async () => {
            if (!attachment) return null;
            const isImage = attachment.contentType?.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/iu.test(attachment.name || '');
            if (!isImage) return { url: attachment.url, size: attachment.size, notImage: true };
            return { url: attachment.url, size: attachment.size };
        },
        respond,
        notify: (content) => respond({ content }),
    }, deps);
}
