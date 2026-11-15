import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { handleGifCommand, isPrivateAddress, isSafeUrl, toGif, findImageUrl } from '../src/services/gifConverterService.js';

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

test('private and local addresses are refused, public ones are fine', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(address), true, address);
    for (const address of ['8.8.8.8', '104.18.1.1', '2606:4700::1']) assert.equal(isPrivateAddress(address), false, address);
});

test('isSafeUrl: https + public host only', async () => {
    const lookupTo = (address) => async () => [{ address }];
    assert.equal(await isSafeUrl('https://cdn.discordapp.com/a.png', lookupTo('104.18.1.1')), true);
    assert.equal(await isSafeUrl('http://cdn.discordapp.com/a.png', lookupTo('104.18.1.1')), false);
    assert.equal(await isSafeUrl('https://127.0.0.1/a.png', lookupTo('127.0.0.1')), false);
    assert.equal(await isSafeUrl('https://localhost/a.png', lookupTo('127.0.0.1')), false);
    assert.equal(await isSafeUrl('https://evil.example.com/a.png', lookupTo('10.0.0.8')), false);
    assert.equal(await isSafeUrl('https://user:pw@x.example.com/a.png', lookupTo('8.8.8.8')), false);
    assert.equal(await isSafeUrl('https://nope.example.com/a.png', async () => { throw new Error('ENOTFOUND'); }), false);
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
    assert.equal(await handleGifCommand(ok, [], { isSafeUrl: async () => true, fetch: fetchStub }), true);
    assert.equal(ok.sent[0].files[0].name, 'image.gif');
    assert.equal(ok.sent[0].files[0].attachment.subarray(0, 3).toString(), 'GIF');

    const none = fakeMessage();
    await handleGifCommand(none, [], { isSafeUrl: async () => true });
    assert.match(none.sent[0].content, /ريبلاي/u);

    const bad = fakeMessage({ attachments: [att] });
    await handleGifCommand(bad, [], { isSafeUrl: async () => false });
    assert.match(bad.sent[0].content, /مش مقبول/u);
});
