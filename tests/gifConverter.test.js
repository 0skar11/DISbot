import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { handleGifCommand, isSafeUrl, toGif, findImageUrl, isGifCommand, COOLDOWN_MS } from '../src/services/gifConverterService.js';
import { parseTypedCommand } from '../src/utils/prefixParser.js';

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

test('`.gif` is the gif command whatever the configured prefix is; the bare word in a chat is not', () => {
    for (const prefix of ['!', '.', '?']) {
        for (const content of ['.gif', '.GIF', '!gif', '.جيف', `${prefix}gif`, `${prefix}جيف`]) {
            assert.equal(isGifCommand(parseTypedCommand(content, prefix)), true, `${content} with prefix ${prefix}`);
        }
        for (const content of ['gif', 'جيف', 'gif me', '.gifs', 'هات gif', '..gif']) {
            assert.equal(isGifCommand(parseTypedCommand(content, prefix)), false, `${content} with prefix ${prefix}`);
        }
    }
});

test('a picture in a replied-to link embed is taken from Discord\'s proxy, so it passes isSafeUrl', async () => {
    const replied = { attachments: new Map(), content: 'https://i.imgur.com/a.png', embeds: [{ type: 'image', url: 'https://i.imgur.com/a.png', thumbnail: { url: 'https://i.imgur.com/a.png', proxyURL: 'https://images-ext-1.discordapp.net/external/abc/https/i.imgur.com/a.png' } }] };
    const url = await findImageUrl(fakeMessage({ replied }));
    assert.equal(url, 'https://images-ext-1.discordapp.net/external/abc/https/i.imgur.com/a.png');
    assert.equal(isSafeUrl(url), true);
});

test('a real Discord attachment link (with its ?ex=&is=&hm= query) is accepted', () => {
    assert.equal(isSafeUrl('https://cdn.discordapp.com/attachments/1/2/photo.png?ex=6740&is=673f&hm=abc123&'), true);
});

test('when the reply fails, the member is still told in the channel', async () => {
    const msg = fakeMessage(); msg.author = { id: 'u-fallback' };
    const channelSent = [];
    msg.reply = async () => { throw new Error('Unknown Message'); };
    msg.channel = { send: async (payload) => { channelSent.push(payload); } };
    await handleGifCommand(msg, [], { now: () => 50_000_000 });
    assert.match(channelSent[0].content, /ريبلاي/u);
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
