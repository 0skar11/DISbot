import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  isCaptionCommand,
  wrapText,
  generateCaption,
  runCaption,
  resetCaptionState,
  TEXT,
  COOLDOWN_MS,
  MAX_TEXT_LENGTH,
} from '../src/services/caption/captionService.js';
import captionCommand from '../src/commands/Tools/caption.js';

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
});
