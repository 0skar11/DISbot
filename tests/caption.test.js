import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  isCaptionCommand,
  wrapText,
  generateCaption,
  runCaption,
  handleCaptionCommand,
  resetCaptionState,
  TEXT,
  COOLDOWN_MS,
  MAX_TEXT_LENGTH,
  MAX_JOBS,
} from '../src/services/caption/captionService.js';
import captionCommand from '../src/commands/Tools/caption.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';

describe('caption command (Report #297)', () => {
  beforeEach(() => {
    resetCaptionState();
  });

  test('isCaptionCommand detects .caption, !caption, and Arabic variants', () => {
    assert.equal(isCaptionCommand({ commandName: '.caption', prefixed: false }), true);
    assert.equal(isCaptionCommand({ commandName: '!caption', prefixed: false }), true);
    assert.equal(isCaptionCommand({ commandName: '.كابشن', prefixed: false }), true);
    assert.equal(isCaptionCommand({ commandName: 'caption', prefixed: true }), true);
    assert.equal(isCaptionCommand({ commandName: 'كابشن', prefixed: true }), true);
    assert.equal(isCaptionCommand({ commandName: 'other', prefixed: false }), false);
    assert.equal(isCaptionCommand(null), false);
  });

  test('wrapText wraps text into lines by word', () => {
    const single = wrapText('short text', 20);
    assert.deepEqual(single, ['short text']);

    const wrapped = wrapText('one two three four five six seven', 15);
    assert.ok(wrapped.length > 1);
    assert.equal(wrapped.join(' '), 'one two three four five six seven');
  });

  test('generateCaption adds a white bar with text above the image', async () => {
    const baseImg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).png().toBuffer();

    const result = await generateCaption(baseImg, 'لما تصحى بدري وتلاقي نفسك نشيط');
    const buffer = Buffer.isBuffer(result) ? result : result.buffer;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(result.filename, 'caption.png');
    assert.equal(result.isGif, false);

    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 300);
    assert.ok(meta.height > 200); // Height increased due to the white caption bar
    assert.equal(meta.format, 'png');
  });

  test('generateCaption keeps GIF animated when input is a GIF', async () => {
    const { fileURLToPath } = await import('node:url');
    const gifPath = fileURLToPath(new URL('../src/assets/emojis/animated/face_angel.gif', import.meta.url));
    const fs = await import('node:fs/promises');
    const gifBytes = await fs.readFile(gifPath);

    const result = await generateCaption(gifBytes, 'us لما نكون كدا');
    const buffer = Buffer.isBuffer(result) ? result : result.buffer;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(result.filename, 'caption.gif');
    assert.equal(result.isGif, true);

    const meta = await sharp(buffer, { animated: true }).metadata();
    assert.equal(meta.format, 'gif');
    assert.ok((meta.pages || 0) > 1);
  });

  test('runCaption validates text and image requirements', async () => {
    const sampleImage = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();

    let replied = null;
    const respond = (payload) => { replied = payload; return payload; };

    // 1. Missing text
    await runCaption({
      userId: 'u1',
      text: '',
      getImage: async () => ({ url: 'https://cdn.discordapp.com/test.png' }),
      respond,
    });
    assert.equal(replied.content, TEXT.noText);

    // 2. Text too long
    await runCaption({
      userId: 'u1',
      text: 'a'.repeat(MAX_TEXT_LENGTH + 10),
      getImage: async () => ({ url: 'https://cdn.discordapp.com/test.png' }),
      respond,
    });
    assert.equal(replied.content, TEXT.textTooLong);

    // 3. Missing image
    await runCaption({
      userId: 'u1',
      text: 'valid caption',
      getImage: async () => null,
      respond,
    });
    assert.equal(replied.content, TEXT.noImage);

    // 4. Unsafe image host
    await runCaption({
      userId: 'u1',
      text: 'valid caption',
      getImage: async () => ({ url: 'https://malicious-site.com/image.png' }),
      respond,
    });
    assert.equal(replied.content, TEXT.unsafe);

    // 5. Successful caption
    const deps = {
      download: async () => sampleImage,
      isSafeUrl: () => true,
    };
    await runCaption({
      userId: 'u1',
      text: 'Meme text',
      getImage: async () => ({ url: 'https://cdn.discordapp.com/test.png' }),
      respond,
    }, deps);

    assert.ok(replied.files);
    assert.equal(replied.files[0].name, 'caption.png');
    assert.ok(Buffer.isBuffer(replied.files[0].attachment));

    // 6. Cooldown on immediate next call
    await runCaption({
      userId: 'u1',
      text: 'Meme text 2',
      getImage: async () => ({ url: 'https://cdn.discordapp.com/test.png' }),
      respond,
    }, deps);
    assert.match(replied.content, /استنى/);
  });

  test('caption slash command executes with interaction options', async () => {
    const sampleImage = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } },
    }).png().toBuffer();

    let replied = null;
    let deferred = false;
    const interaction = {
      user: { id: 'user-slash' },
      deferReply: async () => { deferred = true; },
      editReply: async (payload) => { replied = payload; },
      options: {
        getString: (name) => name === 'text' ? 'Meme Caption' : null,
        getAttachment: (name) => name === 'image' ? { url: 'https://cdn.discordapp.com/img.png', size: 1000 } : null,
      },
    };

    // Replace fetch / download for test
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => sampleImage,
    });

    try {
      await captionCommand.execute(interaction);
      assert.ok(deferred);
      assert.ok(replied.files);
      assert.equal(replied.files[0].name, 'caption.png');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('handleCaptionCommand keeps Tenor GIF animated as caption.gif', async () => {
    const { fileURLToPath } = await import('node:url');
    const gifPath = fileURLToPath(new URL('../src/assets/emojis/animated/face_angel.gif', import.meta.url));
    const fs = await import('node:fs/promises');
    const gifBytes = await fs.readFile(gifPath);

    let sent = null;
    const repliedMessage = {
      attachments: new Map(),
      content: 'https://tenor.com/view/wumpus-wave-gif-12345',
      embeds: [
        {
          type: 'gifv',
          url: 'https://tenor.com/view/wumpus-wave-gif-12345',
          thumbnail: {
            url: 'https://media.tenor.com/wumpus.png',
            proxyURL: 'https://images-ext-1.discordapp.net/external/xyz/https/media.tenor.com/wumpus.png',
          },
        },
      ],
    };

    const message = {
      guild: { id: 'g1' },
      author: { id: 'u-tenor' },
      content: '.caption معاذ نيكوتين',
      reference: { messageId: 'm-orig' },
      fetchReference: async () => repliedMessage,
      channel: { sendTyping: async () => {} },
      reply: async (payload) => { sent = payload; return payload; },
    };

    const tenorHtml = `
      <html>
        <script type="application/ld+json">{"@context":"http://schema.org","@type":"Article","image":{"@type":"ImageObject","contentUrl":"https://media1.tenor.com/m/test/wumpus.gif"}}</script>
      </html>
    `;

    const fetchStub = async (url) => {
      if (String(url).includes('tenor.com/view/')) {
        return { ok: true, text: async () => tenorHtml };
      }
      return {
        ok: true,
        headers: new Headers({ 'content-length': String(gifBytes.length) }),
        body: {
          getReader() {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true };
                done = true;
                return { done: false, value: gifBytes };
              },
            };
          },
        },
      };
    };

    const { handleCaptionCommand } = await import('../src/services/caption/captionService.js');
    await handleCaptionCommand(message, ['معاذ', 'نيكوتين'], { fetch: fetchStub, now: () => 10_000_000 });

    assert.ok(sent);
    assert.ok(sent.files);
    assert.equal(sent.files[0].name, 'caption.gif');
    const meta = await sharp(sent.files[0].attachment, { animated: true }).metadata();
    assert.equal(meta.format, 'gif');
    assert.ok((meta.pages || 0) > 1);
  });
});

// GH #325 ("لسه مش gif"): a GIF must come back animated, with the caption on every frame.
const FRAME_COLORS = [[230, 30, 30], [30, 200, 30], [30, 30, 230], [230, 200, 30], [200, 30, 200], [30, 200, 200]];

/** An animated GIF / WebP whose frames are solid colours (FRAME_COLORS), `delay` ms each. */
async function animatedImage({ width = 120, height = 80, frames = 4, format = 'gif', delay = 80, noise = false } = {}) {
  const pixels = Buffer.alloc(width * height * 4 * frames);
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 256; };
  for (let frame = 0; frame < frames; frame += 1) {
    const color = FRAME_COLORS[frame % FRAME_COLORS.length];
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 4;
      pixels[offset] = noise ? random() : color[0];
      pixels[offset + 1] = noise ? random() : color[1];
      pixels[offset + 2] = noise ? random() : color[2];
      pixels[offset + 3] = 255;
    }
  }
  const image = sharp(pixels, { raw: { width, height: height * frames, channels: 4, pageHeight: height } });
  const options = { delay: Array(frames).fill(delay), loop: 0 };
  return format === 'webp' ? image.webp(options).toBuffer() : image.gif(options).toBuffer();
}

/** Top-left (caption bar) and bottom-left (picture) pixel of every frame. */
async function framePixels(buffer) {
  const { pages = 1 } = await sharp(buffer, { animated: true }).metadata();
  const frames = [];
  for (let page = 0; page < pages; page += 1) {
    const { data, info } = await sharp(buffer, { page }).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    frames.push({ top: at(2, 2), bottom: at(2, info.height - 3) });
  }
  return frames;
}

const near = (actual, expected, tolerance = 40) => actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

describe('GH #325: animated captions stay animated', () => {
  beforeEach(() => {
    resetCaptionState();
  });

  for (const format of ['gif', 'webp']) {
    test(`an animated ${format} becomes an animated GIF with the caption on every frame`, async () => {
      const source = await animatedImage({ format, frames: 4, delay: 80 });
      const result = await generateCaption(source, 'اصحى يا ادم');
      assert.equal(result.filename, 'caption.gif');
      assert.equal(result.isGif, true);
      const meta = await sharp(result.buffer, { animated: true }).metadata();
      assert.equal(meta.format, 'gif');
      assert.equal(meta.pages, 4, 'every frame is kept');
      assert.equal(meta.width, 120);
      assert.ok(meta.pageHeight > 80, 'the caption bar is above the picture');
      assert.deepEqual(meta.delay, [80, 80, 80, 80], 'same speed');
      const frames = await framePixels(result.buffer);
      frames.forEach((frame, index) => {
        assert.ok(near(frame.top, [255, 255, 255], 10), `frame ${index} has the white caption bar`);
        assert.ok(near(frame.bottom, FRAME_COLORS[index]), `frame ${index} keeps its own picture`);
      });
    });
  }

  test('a wide animated GIF is made narrower but keeps every frame', async () => {
    const source = await animatedImage({ width: 800, height: 400, frames: 3 });
    const result = await generateCaption(source, 'كابشن');
    const meta = await sharp(result.buffer, { animated: true }).metadata();
    assert.equal(meta.pages, 3);
    assert.equal(meta.width, 540);
  });

  test('a still picture, and a one-frame GIF (Tenor\'s preview), come out as a PNG', async () => {
    const still = await sharp({ create: { width: 90, height: 60, channels: 3, background: { r: 9, g: 9, b: 9 } } }).gif().toBuffer();
    const result = await generateCaption(still, 'كابشن');
    assert.equal(result.filename, 'caption.png');
    assert.equal(result.isGif, false);
    assert.equal((await sharp(result.buffer).metadata()).format, 'png');
  });

  test('a GIF over the size limit is made smaller (narrower / fewer frames) until it fits, at the same speed', async () => {
    const source = await animatedImage({ width: 400, height: 300, frames: 6, delay: 80, noise: true });
    const full = await generateCaption(source, 'كابشن', { maxBytes: Infinity });
    const limit = Math.floor(full.buffer.length * 0.4);
    const small = await generateCaption(source, 'كابشن', { maxBytes: limit });
    assert.equal(small.isGif, true);
    assert.ok(small.buffer.length <= limit, `${small.buffer.length} <= ${limit}`);
    const meta = await sharp(small.buffer, { animated: true }).metadata();
    assert.ok(meta.pages >= 2, 'still animated');
    assert.equal(meta.delay.reduce((sum, delay) => sum + delay, 0), 6 * 80, 'dropped frames add their time to the kept ones');
    await assert.rejects(() => generateCaption(source, 'كابشن', { maxBytes: 100 }), /too big/);
  });

  // A GIF from Discord's GIF picker: the message is the Tenor link, its embed a still AAAAe thumbnail and an mp4.
  const tenorPickerMessage = () => ({
    attachments: new Map(),
    content: 'https://tenor.com/view/wake-up-gif-12345',
    embeds: [{
      type: 'gifv',
      url: 'https://tenor.com/view/wake-up-gif-12345',
      thumbnail: {
        url: 'https://media.tenor.com/AbCdEfGhIjkAAAAe/wake-up.png',
        proxyURL: 'https://images-ext-1.discordapp.net/external/xyz/https/media.tenor.com/AbCdEfGhIjkAAAAe/wake-up.png',
      },
      video: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAPo/wake-up.mp4' },
    }],
  });

  const commandMessage = (guildId, replied, sent) => ({
    guild: { id: guildId },
    author: { id: `u-${guildId}` },
    content: '.كابشن اصحى يا ادم',
    reference: { messageId: 'm-gif' },
    fetchReference: async () => replied,
    channel: { sendTyping: async () => {} },
    reply: async (payload) => { sent.push(payload); return payload; },
  });

  const served = (bytes) => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes });

  for (const guildId of [HOME_GUILD_ID, ZENITH_GUILD_ID]) {
    test(`.كابشن on a Tenor GIF from the picker answers an animated GIF, never the still preview (server ${guildId})`, async () => {
      const gif = await animatedImage({ frames: 5 });
      const requested = [];
      const fetchStub = async (url) => {
        requested.push(String(url));
        if (String(url).includes('tenor.com/view/')) throw new Error('the page must not be needed');
        // The medium GIF is missing here: the full GIF is the fallback.
        if (String(url).includes('AAAAd')) return { ok: false, status: 404, headers: new Headers() };
        if (String(url).includes('AAAAC')) return served(gif);
        throw new Error(`unexpected ${url}`);
      };
      const sent = [];
      await handleCaptionCommand(commandMessage(guildId, tenorPickerMessage(), sent), ['اصحى', 'يا', 'ادم'], { fetch: fetchStub, now: () => 20_000_000 });
      assert.deepEqual(requested, [
        'https://media.tenor.com/AbCdEfGhIjkAAAAd/wake-up.gif',
        'https://media.tenor.com/AbCdEfGhIjkAAAAC/wake-up.gif',
      ]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].files[0].name, 'caption.gif');
      assert.equal(sent[0].content, undefined);
      const meta = await sharp(sent[0].files[0].attachment, { animated: true }).metadata();
      assert.equal(meta.format, 'gif');
      assert.equal(meta.pages, 5);
      const frames = await framePixels(sent[0].files[0].attachment);
      assert.ok(frames.every((frame) => near(frame.top, [255, 255, 255], 10)));
      assert.ok(!near(frames[0].bottom, frames[1].bottom, 5), 'the frames still differ: it moves');
    });
  }

  test('a video GIF from another site only has a still thumbnail: PNG plus a short note', async () => {
    const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const replied = {
      attachments: new Map(),
      content: 'https://gifs.example.com/view/123',
      embeds: [{
        type: 'gifv',
        url: 'https://gifs.example.com/view/123',
        thumbnail: { url: 'https://static.example.com/123.png', proxyURL: 'https://images-ext-1.discordapp.net/external/abc/https/static.example.com/123.png' },
        video: { url: 'https://static.example.com/123.mp4' },
      }],
    };
    const sent = [];
    await handleCaptionCommand(commandMessage('100000000000000099', replied, sent), ['كابشن'], { fetch: async () => served(png), now: () => 30_000_000 });
    assert.equal(sent[0].files[0].name, 'caption.png');
    assert.equal(sent[0].content, TEXT.videoStill);
  });

  test('a download or a GIF that is too big gets its own answer', async () => {
    const replies = [];
    const respond = (payload) => { replies.push(payload.content); return payload; };
    const image = async () => ({ url: 'https://cdn.discordapp.com/a.gif' });
    await runCaption({ userId: 'big-1', text: 'x', getImage: image, respond }, { download: async () => { throw new Error('too big'); } });
    await runCaption({ userId: 'big-2', text: 'x', getImage: image, respond }, { download: async () => Buffer.from('gif'), generateCaption: async () => { throw new Error('too big'); } });
    assert.deepEqual(replies, [TEXT.tooBig, TEXT.outputTooBig]);
  });

  test(`at most ${MAX_JOBS} captions are made at the same time`, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = { download: async () => Buffer.from('x'), generateCaption: async () => { await gate; return { buffer: Buffer.from('png'), filename: 'caption.png', isGif: false }; } };
    const replies = [];
    const run = (userId) => runCaption({ userId, text: 'x', getImage: async () => ({ url: 'https://cdn.discordapp.com/a.png' }), respond: (payload) => { replies.push(payload); return payload; } }, deps);
    const busy = Array.from({ length: MAX_JOBS }, (_, index) => run(`job-${index}`));
    await new Promise((resolve) => setImmediate(resolve));
    await run('job-extra');
    assert.equal(replies.at(-1).content, TEXT.busy);
    release();
    await Promise.all(busy);
    assert.equal(replies.filter((payload) => payload.files).length, MAX_JOBS);
  });
});
