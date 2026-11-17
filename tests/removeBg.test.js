import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    isRemoveBgCommand, removeBgArgs, handleRemoveBgCommand, handleRemoveBgInteraction, resetRemoveBgState,
    COOLDOWN_MS, MAX_INPUT_BYTES, MAX_WAITING, TEXT,
} from '../src/services/backgroundRemoval/removeBgService.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';
import { modelSettings, MODELS } from '../src/services/backgroundRemoval/removeBgEngine.js';
import removebg from '../src/commands/Tools/removebg.js';
import { supportsPrefixExecution } from '../src/utils/messageAdapter.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE = { url: 'https://cdn.discordapp.com/attachments/1/2/cat.jpg', contentType: 'image/jpeg', name: 'cat.jpg', size: 1000 };
const okFetch = async () => new Response(Buffer.from('picture bytes'), { status: 200 });

function fakeMessage({ attachments = [IMAGE], replied = null, author = 'u1' } = {}) {
    const sent = [];
    return {
        sent,
        guild: { id: 'any-server' },
        author: { id: author },
        content: '.removebg',
        attachments: new Map(attachments.map((a, i) => [String(i), a])),
        embeds: [],
        mentions: { users: { first: () => undefined } },
        reference: replied ? { messageId: 'r1' } : null,
        fetchReference: async () => replied,
        channel: { sendTyping: async () => {} },
        reply: async (payload) => { sent.push(payload); },
    };
}

const engine = (calls = []) => async (bytes) => { calls.push(bytes); return PNG_BYTES; };

beforeEach(() => resetRemoveBgState());

test('typed words: needs the prefix or a symbol, like `.gif`; the bare words stay chat', () => {
    for (const text of ['.removebg', '!removebg', '.شيل الخلفية', '.شيل الخلفيه', '!!removebg', '!!شيل الخلفية']) {
        assert.equal(isRemoveBgCommand(parseTypedCommand(text, '!!')), true, text);
    }
    for (const text of ['removebg', 'شيل الخلفية', '.شيل @x', '.شيل', 'شيل منشن', '.gif']) {
        assert.equal(isRemoveBgCommand(parseTypedCommand(text, '!!')), false, text);
    }
    assert.deepEqual(removeBgArgs(parseTypedCommand('.شيل الخلفية https://x', '!!')), ['https://x']);
    assert.deepEqual(removeBgArgs(parseTypedCommand('.removebg https://x', '!!')), ['https://x']);
    // The slash command never runs from a typed bare `removebg`.
    assert.equal(supportsPrefixExecution(removebg), false);
    assert.equal(removebg.data.toJSON().options[0].type, 11, 'an attachment option');
});

test('success: the attached picture comes back as a PNG file', async () => {
    const calls = [];
    const message = fakeMessage();
    assert.equal(await handleRemoveBgCommand(message, [], { fetch: okFetch, removeBackground: engine(calls) }), true);
    assert.equal(calls.length, 1);
    assert.equal(message.sent.length, 1);
    const [file] = message.sent[0].files;
    assert.equal(file.name, 'no-background.png');
    assert.deepEqual(file.attachment, PNG_BYTES);
    assert.deepEqual(message.sent[0].allowedMentions.parse, []);
});

test('the picture of the replied-to message works too', async () => {
    const calls = [];
    const message = fakeMessage({ attachments: [], replied: { attachments: new Map([['1', IMAGE]]), embeds: [], content: '' } });
    await handleRemoveBgCommand(message, [], { fetch: okFetch, removeBackground: engine(calls) });
    assert.equal(calls.length, 1);
    assert.ok(message.sent[0].files);
});

test('no picture: an Arabic hint, and no cooldown spent', async () => {
    const message = fakeMessage({ attachments: [] });
    await handleRemoveBgCommand(message, [], { fetch: okFetch, removeBackground: engine() });
    assert.equal(message.sent[0].content, TEXT.noImage);
    const again = fakeMessage();
    await handleRemoveBgCommand(again, [], { fetch: okFetch, removeBackground: engine() });
    assert.ok(again.sent[0].files, 'the mistake did not start the cooldown');
});

test('cooldown: 20 seconds per member', async () => {
    let now = 1_000_000;
    const deps = { now: () => now, fetch: okFetch, removeBackground: engine() };
    await handleRemoveBgCommand(fakeMessage(), [], deps);
    now += COOLDOWN_MS - 5_000;
    const early = fakeMessage();
    await handleRemoveBgCommand(early, [], deps);
    assert.equal(early.sent[0].content, TEXT.cooldown(5));
    const other = fakeMessage({ author: 'u2' });
    await handleRemoveBgCommand(other, [], deps);
    assert.ok(other.sent[0].files, 'another member is not held back');
    now += 5_000;
    const later = fakeMessage();
    await handleRemoveBgCommand(later, [], deps);
    assert.ok(later.sent[0].files);
});

test('size limit: 8 MB, by the attachment size and while downloading', async () => {
    assert.equal(MAX_INPUT_BYTES, 8 * 1024 * 1024);
    const calls = [];
    const big = fakeMessage();
    const hugeFetch = async () => new Response(Buffer.alloc(MAX_INPUT_BYTES + 1), { status: 200 });
    await handleRemoveBgCommand(big, [], { fetch: hugeFetch, removeBackground: engine(calls) });
    assert.equal(big.sent[0].content, TEXT.tooBig);
    assert.equal(calls.length, 0, 'never reaches the library');

    const replies = [];
    const interaction = {
        user: { id: 'u3' },
        options: { getAttachment: () => ({ ...IMAGE, size: MAX_INPUT_BYTES + 1 }) },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); },
    };
    await handleRemoveBgInteraction(interaction, { fetch: () => assert.fail('downloaded'), removeBackground: engine(calls) });
    assert.equal(replies[0].content, TEXT.tooBig);
});

test('/removebg: sends the PNG; refuses a non-picture; a failure says so in Arabic', async () => {
    const replies = [];
    const interaction = (attachment, user = 'u4') => ({
        user: { id: user },
        options: { getAttachment: () => attachment },
        deferReply: async () => {},
        editReply: async (payload) => { replies.push(payload); },
    });
    await handleRemoveBgInteraction(interaction(IMAGE), { fetch: okFetch, removeBackground: engine() });
    assert.equal(replies[0].files[0].name, 'no-background.png');
    assert.equal(replies[0].content, '');

    await handleRemoveBgInteraction(interaction({ url: 'https://cdn.discordapp.com/a/b/doc.pdf', contentType: 'application/pdf', name: 'doc.pdf', size: 10 }, 'u5'), { fetch: okFetch, removeBackground: engine() });
    assert.equal(replies[1].content, TEXT.notImage);

    const failing = async () => { const error = new Error('slow'); error.code = 'timeout'; throw error; };
    await handleRemoveBgInteraction(interaction(IMAGE, 'u6'), { fetch: okFetch, removeBackground: failing });
    assert.equal(replies[2].content, TEXT.timeout);
    const broken = async () => { throw new Error('boom'); };
    await handleRemoveBgInteraction(interaction(IMAGE, 'u7'), { fetch: okFetch, removeBackground: broken });
    assert.equal(replies[3].content, TEXT.failed);
});

test('a picture outside Discord is never downloaded', async () => {
    const message = fakeMessage({ attachments: [] });
    await handleRemoveBgCommand(message, ['https://evil.example.com/a.png'], { fetch: () => assert.fail('downloaded'), removeBackground: engine() });
    assert.equal(message.sent[0].content, TEXT.unsafe);
});

test('queue: one job at a time, the next ones wait their turn, a full queue says busy', async () => {
    let running = 0;
    let most = 0;
    const releases = [];
    const slow = async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => releases.push(resolve));
        running -= 1;
        return PNG_BYTES;
    };
    const messages = Array.from({ length: MAX_WAITING + 1 }, (_, i) => fakeMessage({ author: `q${i}` }));
    let finished = 0;
    const jobs = messages.map((message) => handleRemoveBgCommand(message, [], { fetch: okFetch, removeBackground: slow }).then(() => { finished += 1; }));
    // Let every message reach the queue.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages[MAX_WAITING].sent[0].content, TEXT.busy);
    assert.equal(messages[1].sent[0].content, TEXT.queued(1));
    while (finished < jobs.length) {
        releases.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(jobs);
    assert.equal(most, 1, 'never two at once');
    for (const message of messages.slice(0, MAX_WAITING)) assert.ok(message.sent.at(-1).files, 'each queued job finished');
});

test('engine settings: a known model, the default u2net, threads bounded', () => {
    const settings = modelSettings({});
    assert.equal(settings.name, 'u2net');
    assert.equal(settings.model, MODELS.u2net);
    assert.equal(settings.threads, 2);
    assert.equal(modelSettings({ REMOVEBG_THREADS: '99' }).threads, 8);
    assert.equal(modelSettings({ REMOVEBG_MODEL_PATH: '/m.onnx' }).downloadable, false);
    assert.throws(() => modelSettings({ REMOVEBG_MODEL: 'nope' }), (error) => error.code === 'unavailable');
});
