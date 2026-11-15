import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { handleGifCommand, isSafeUrl, toGif, findImageUrl, COOLDOWN_MS } from '../src/services/gifConverterService.js';

const png = () => sharp({ create: { width: 30, height: 20, channels: 4, background: '#2255ff' } }).png().toBuffer();

function fakeMessage({ attachments = [], content = '.gif', replied = null, mentions = [] } = {}) {
    const sent = [];
    return {
        sent,
        guild: { id: 'g' },
        content,
        attachments: new Map(attachments.map((a, i) => [String(i), a])),
        embeds: [],
        mentions: { users: { first: () => mentions[0] } },
        reference: replied ? { messageId: 'r1' } : null,
        fetchReference: async () => replied,
        reply: async (payload) => { sent.push(payload); },
    };
}

test('isSafeUrl: only https on the Discord image hosts', () => {
    for (const ok of ['https://cdn.discordapp.com/a.png', 'https://media.discordapp.net/a.png?x=1', 'https://images-ext-1.discordapp.net/external/a/b.png']) assert.equal(isSafeUrl(ok), true, ok);
    for (const bad of ['http://cdn.discordapp.com/a.png', 'https://evil.example.com/a.png', 'https://cdn.discordapp.com.evil.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://user:pw@cdn.discordapp.com/a.png', 'https://cdn.discordapp.com:8443/a.png', 'https://169.254.169.254/latest', 'not a url']) assert.equal(isSafeUrl(bad), false, bad);
});

test('toGif makes a real GIF and refuses a non-picture', async () => {
    const gif = await toGif(await png());
    assert.equal(gif.subarray(0, 3).toString(), 'GIF');
    await assert.rejects(() => toGif(Buffer.from('not a picture')));
});

test('image source: own attachment, then the replied message, then a link, then a mentioned avatar', async () => {
    const att = { url: 'https://cdn.discordapp.com/x.png', contentType: 'image/png', name: 'x.png' };
    assert.equal(await findImageUrl(fakeMessage({ attachments: [att] })), att.url);
    assert.equal(await findImageUrl(fakeMessage({ replied: { attachments: new Map([['1', att]]), embeds: [], content: '' } })), att.url);
    assert.equal(await findImageUrl(fakeMessage(), ['https://example.com/pic.jpg']), 'https://example.com/pic.jpg');
    assert.equal(await findImageUrl(fakeMessage({ mentions: [{ displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }] })), 'https://cdn.discordapp.com/avatar.png');
    assert.equal(await findImageUrl(fakeMessage()), null);
});

test('.gif replies with a GIF file; with no picture it says how to use it; a bad link is refused', async () => {
    const att = { url: 'https://cdn.discordapp.com/x.png', contentType: 'image/png', name: 'x.png' };
    const bytes = await png();
    const ok = fakeMessage({ attachments: [att] });
    const fetchStub = async () => ({ ok: true, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    assert.equal(await handleGifCommand(ok, [], { isSafeUrl: () => true, fetch: fetchStub, now: () => 1_000_000 }), true);
    assert.equal(ok.sent[0].files[0].name, 'image.gif');
    assert.equal(ok.sent[0].files[0].attachment.subarray(0, 3).toString(), 'GIF');

    const none = fakeMessage();
    await handleGifCommand(none, [], { isSafeUrl: () => true, now: () => 2_000_000 });
    assert.match(none.sent[0].content, /ريبلاي/u);

    const bad = fakeMessage({ attachments: [att] });
    await handleGifCommand(bad, [], { isSafeUrl: () => false, now: () => 3_000_000 });
    assert.match(bad.sent[0].content, /ديسكورد بس/u);
});

test('a member must wait between conversions', async () => {
    const att = { url: 'https://cdn.discordapp.com/x.png', contentType: 'image/png', name: 'x.png' };
    const bytes = await png();
    const fetchStub = async () => ({ ok: true, headers: { get: () => '0' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const first = fakeMessage({ attachments: [att] }); first.author = { id: 'u-cool' };
    await handleGifCommand(first, [], { isSafeUrl: () => true, fetch: fetchStub, now: () => 10_000_000 });
    assert.equal(first.sent[0].files[0].name, 'image.gif');
    const second = fakeMessage({ attachments: [att] }); second.author = { id: 'u-cool' };
    await handleGifCommand(second, [], { isSafeUrl: () => true, fetch: fetchStub, now: () => 10_000_000 + COOLDOWN_MS - 1 });
    assert.match(second.sent[0].content, /استنى/u);
});
