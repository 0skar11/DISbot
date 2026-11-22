import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
    handleGifCommand, isSafeUrl, toGif, findImageUrl, findImageSource, isGifCommand, isTenorOrGiphy, resolveMediaUrl, COOLDOWN_MS,
    tenorGifUrls, giphyGifUrls, animatedCandidates, originalDiscordFile, downloadFirst,
} from '../src/services/gifConverterService.js';
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

test('isSafeUrl: only https on Discord, Tenor, and Giphy hosts', () => {
    for (const ok of [
        'https://cdn.discordapp.com/a.png',
        'https://media.discordapp.net/a.png?x=1',
        'https://images-ext-1.discordapp.net/external/a/b.png',
        'https://tenor.com/view/funny-cat-gif-1234',
        'https://media.tenor.com/m/abc/cat.gif',
        'https://media1.tenor.com/m/abc/cat.gif',
        'https://c.tenor.com/abc/cat.gif',
        'https://giphy.com/gifs/funny-cat-xyz',
        'https://i.giphy.com/media/xyz/giphy.gif',
        'https://media.giphy.com/media/xyz/giphy.gif',
        'https://media0.giphy.com/media/xyz/giphy.gif',
    ]) assert.equal(isSafeUrl(ok), true, ok);

    for (const bad of [
        'http://cdn.discordapp.com/a.png',
        'http://tenor.com/view/1',
        'http://giphy.com/gifs/1',
        'https://evil.example.com/a.png',
        'https://cdn.discordapp.com.evil.com/a.png',
        'https://tenor.com.evil.com/a.png',
        'https://eviltenor.com/a.png',
        'https://giphy.com.evil.com/a.png',
        'https://evilgiphy.com/a.png',
        'https://127.0.0.1/a.png',
        'https://localhost/a.png',
        'https://user:pw@cdn.discordapp.com/a.png',
        'https://cdn.discordapp.com:8443/a.png',
        'https://169.254.169.254/latest',
        'not a url',
    ]) assert.equal(isSafeUrl(bad), false, bad);
});

test('isTenorOrGiphy identifies Tenor and Giphy domains', () => {
    assert.equal(isTenorOrGiphy('https://tenor.com/view/cat-123'), true);
    assert.equal(isTenorOrGiphy('https://media1.tenor.com/m/abc/cat.gif'), true);
    assert.equal(isTenorOrGiphy('https://giphy.com/gifs/cat-123'), true);
    assert.equal(isTenorOrGiphy('https://i.giphy.com/media/123/giphy.gif'), true);
    assert.equal(isTenorOrGiphy('https://cdn.discordapp.com/a.png'), false);
    assert.equal(isTenorOrGiphy('https://eviltenor.com/a.gif'), false);
    assert.equal(isTenorOrGiphy(null), false);
});

test('resolveMediaUrl resolves Tenor page HTML to direct gif', async () => {
    const tenorHtml = `
      <html>
        <head>
          <script type="application/ld+json">{"@context":"http://schema.org","@type":"Article","image":{"@type":"ImageObject","contentUrl":"https://media1.tenor.com/m/test/cat.gif","thumbnailUrl":"https://media.tenor.com/test/cat.png"}}</script>
        </head>
      </html>
    `;
    const fetchStub = async () => ({
        ok: true,
        text: async () => tenorHtml,
    });
    const result = await resolveMediaUrl('https://tenor.com/view/cat-test-123', fetchStub);
    assert.equal(result, 'https://media1.tenor.com/m/test/cat.gif');
});

test('resolveMediaUrl resolves Giphy page URL to direct gif', async () => {
    const result = await resolveMediaUrl('https://giphy.com/gifs/cat-funny-cute-JIX9t2j0ZTN9S');
    assert.equal(result, 'https://i.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif');
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

// GH #325: the still preview (AAAAe), the mp4 or the webp of a Tenor GIF all lead to its animated GIF formats.
test('tenorGifUrls: any Tenor media link gives the animated GIF formats, medium first', () => {
    const expected = ['AAAAd', 'AAAAC', 'AAAAM'].map((format) => `https://media.tenor.com/x8v1oNUOmg4${format}/rickroll-roll.gif`);
    for (const link of [
        'https://media.tenor.com/x8v1oNUOmg4AAAAe/rickroll-roll.png',
        'https://media.tenor.com/x8v1oNUOmg4AAAPo/rickroll-roll.mp4',
        'https://media.tenor.com/x8v1oNUOmg4AAAA1/rickroll-roll.webp',
        'https://media1.tenor.com/m/x8v1oNUOmg4AAAAC/rickroll-roll.gif',
        'https://media.tenor.com/x8v1oNUOmg4AAAAe/rickroll-roll.png?width=498&height=280',
    ]) assert.deepEqual(tenorGifUrls(link), expected, link);
    assert.deepEqual(tenorGifUrls('https://media1.tenor.com/m/test/cat.gif'), []);
    assert.deepEqual(tenorGifUrls('https://tenor.com/view/cat-123'), []);
    assert.deepEqual(tenorGifUrls('https://evil.com/x8v1oNUOmg4AAAAe/a.png'), []);
});

test('giphyGifUrls: a still frame or an mp4 gives the animated GIF; an animated link is tried as it is first', () => {
    const animated = ['giphy.gif', 'giphy-downsized-medium.gif', '200w.gif'].map((file) => `https://i.giphy.com/media/3o7abKhOpu0NwenH3O/${file}`);
    assert.deepEqual(giphyGifUrls('https://media0.giphy.com/media/3o7abKhOpu0NwenH3O/giphy_s.gif'), animated);
    assert.deepEqual(giphyGifUrls('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.mp4'), animated);
    assert.deepEqual(giphyGifUrls('https://media2.giphy.com/media/v1.Y2lkPTc5/3o7abKhOpu0NwenH3O/200w_s.gif?cid=1'), animated);
    assert.equal(giphyGifUrls('https://media.giphy.com/media/3o7abKhOpu0NwenH3O/200w.gif')[0], 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/200w.gif');
    assert.deepEqual(giphyGifUrls('https://giphy.com/gifs/cat-3o7abKhOpu0NwenH3O'), []);
    assert.deepEqual(animatedCandidates('https://cdn.discordapp.com/a.png'), ['https://cdn.discordapp.com/a.png']);
});

test('a Tenor page gives its own GIF, not the first related GIF listed under it', async () => {
    // Like on tenor.com, a related GIF (tinygif, AAAAM) shows up in the page before the page's own tags.
    const html = `<html><head>
        <link rel="preload" href="https://media.tenor.com/kGekz062mwgAAAAM/hugs-rickroll.gif">
        <meta property="og:image" content="https://media1.tenor.com/m/x8v1oNUOmg4AAAAd/rickroll-roll.gif">
        <link rel="image_src" href="https://media1.tenor.com/m/x8v1oNUOmg4AAAAC/rickroll-roll.gif">
      </head><body><img src="https://media.tenor.com/IB9ol7welioAAAAM/dance-vibing.gif"></body></html>`;
    const result = await resolveMediaUrl('https://tenor.com/view/rickroll-gif-22954713', async () => ({ ok: true, text: async () => html }));
    assert.equal(result, 'https://media.tenor.com/x8v1oNUOmg4AAAAd/rickroll-roll.gif');
});

test('a Tenor still preview link resolves to the animated GIF without reading any page', async () => {
    const noFetch = async () => { throw new Error('no fetch expected'); };
    assert.equal(await resolveMediaUrl('https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x8v1oNUOmg4AAAAe/rickroll-roll.png', noFetch), 'https://media.tenor.com/x8v1oNUOmg4AAAAd/rickroll-roll.gif');
});

test('a replied GIF from Discord\'s picker is read from its embed: the exact GIF, animated formats first', async () => {
    const replied = {
        attachments: new Map(),
        content: 'https://tenor.com/view/rickroll-gif-22954713',
        embeds: [{
            type: 'gifv', url: 'https://tenor.com/view/rickroll-gif-22954713',
            thumbnail: { url: 'https://media.tenor.com/x8v1oNUOmg4AAAAe/rickroll-roll.png', proxyURL: 'https://images-ext-1.discordapp.net/external/a/https/media.tenor.com/x8v1oNUOmg4AAAAe/rickroll-roll.png' },
            video: { url: 'https://media.tenor.com/x8v1oNUOmg4AAAPo/rickroll-roll.mp4' },
        }],
    };
    const source = await findImageSource(fakeMessage({ replied }), [], { fetch: async () => { throw new Error('no fetch expected'); } });
    assert.equal(source.url, 'https://media.tenor.com/x8v1oNUOmg4AAAAd/rickroll-roll.gif');
    assert.equal(source.candidates.length, 3);
    assert.equal(source.videoStill, false);
    assert.ok(source.candidates.every((url) => isSafeUrl(url) && !url.includes('AAAAe')));
});

test('a video GIF from another site is flagged: only its still thumbnail can be read', async () => {
    const replied = {
        attachments: new Map(), content: '',
        embeds: [{ type: 'gifv', url: 'https://gifs.example.com/1', thumbnail: { url: 'https://static.example.com/1.png', proxyURL: 'https://images-ext-1.discordapp.net/external/b/https/static.example.com/1.png' }, video: { url: 'https://static.example.com/1.mp4' } }],
    };
    const source = await findImageSource(fakeMessage({ replied }));
    assert.equal(source.url, 'https://images-ext-1.discordapp.net/external/b/https/static.example.com/1.png');
    assert.equal(source.videoStill, true);
});

test('a GIF on Discord\'s media proxy is downloaded from the original file (signature kept)', () => {
    assert.equal(
        originalDiscordFile('https://media.discordapp.net/attachments/1/2/dance.gif?ex=6740&is=673f&hm=abc&width=498&height=280&format=webp'),
        'https://cdn.discordapp.com/attachments/1/2/dance.gif?ex=6740&is=673f&hm=abc',
    );
    const png = 'https://media.discordapp.net/attachments/1/2/photo.png?ex=1&width=10';
    assert.equal(originalDiscordFile(png), png);
});

test('downloadFirst falls back to the next link and never tries an unsafe one', async () => {
    const tried = [];
    const get = async (url) => { tried.push(url); if (url.endsWith('a.gif')) throw new Error('download failed (404)'); return Buffer.from(url); };
    const result = await downloadFirst(['https://cdn.discordapp.com/a.gif', 'https://evil.com/x.gif', 'https://cdn.discordapp.com/b.gif'], { download: get });
    assert.equal(result.url, 'https://cdn.discordapp.com/b.gif');
    assert.deepEqual(tried, ['https://cdn.discordapp.com/a.gif', 'https://cdn.discordapp.com/b.gif']);
    await assert.rejects(() => downloadFirst(['https://cdn.discordapp.com/a.gif'], { download: get }), /404/);
});

test('.gif on a replied Tenor GIF converts the animated GIF, not the still preview', async () => {
    const frames = await Promise.all([[255, 0, 0], [0, 0, 255]].map(([r, g, b]) => sharp({ create: { width: 20, height: 20, channels: 4, background: { r, g, b, alpha: 1 } } }).raw().toBuffer()));
    const gif = await sharp(Buffer.concat(frames), { raw: { width: 20, height: 40, channels: 4, pageHeight: 20 } }).gif().toBuffer();
    const replied = { attachments: new Map(), content: '', embeds: [{ type: 'gifv', url: 'https://tenor.com/view/x-1', thumbnail: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAAe/x.png' } }] };
    const requested = [];
    const fetchStub = async (url) => { requested.push(url); return { ok: true, headers: { get: () => String(gif.length) }, arrayBuffer: async () => gif }; };
    const msg = fakeMessage({ replied }); msg.author = { id: 'u-tenor-gif' };
    await handleGifCommand(msg, [], { fetch: fetchStub, now: () => 70_000_000 });
    assert.deepEqual(requested, ['https://media.tenor.com/AbCdEfGhIjkAAAAd/x.gif']);
    assert.equal((await sharp(msg.sent[0].files[0].attachment, { animated: true }).metadata()).pages, 2);
});
