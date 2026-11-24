// `.caption` on a video GIF (Discord's GIF picker often sends only an mp4 / webm) or an uploaded video: it is turned
// into an animated GIF with ffmpeg (ffmpeg-static) and captioned on every frame. ffmpeg is mocked, except in the
// real conversion tests at the end (skipped when the ffmpeg-static binary is missing).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  videoToGif, videoFormat, paletteArgs, gifArgs, runFfmpeg, ffmpegBinary, resetVideoState,
  MAX_VIDEO_BYTES, MAX_SECONDS, FPS, MAX_SIDE, MAX_WAITING,
} from '../src/services/caption/videoToGif.js';
import {
  handleCaptionCommand, handleCaptionInteraction, runCaption, resetCaptionState, TEXT,
} from '../src/services/caption/captionService.js';
import { findMediaSource, findImageSource, download, downloadFirst, isSafeUrl } from '../src/services/gifConverterService.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';

const SERVERS = [HOME_GUILD_ID, ZENITH_GUILD_ID];
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const WEBM_HEAD = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]);
const COLORS = [[230, 30, 30], [30, 200, 30], [30, 30, 230], [230, 200, 30]];

const tempRoots = [];
async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'disbot-test-video-'));
  tempRoots.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })));
});

/** An animated GIF whose frames are solid COLORS. */
async function animatedGif({ width = 60, height = 40, frames = 4 } = {}) {
  const pixels = Buffer.alloc(width * height * 4 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const [r, g, b] = COLORS[frame % COLORS.length];
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 4;
      pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b; pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .gif({ delay: Array(frames).fill(100), loop: 0 }).toBuffer();
}

/** A fake child_process.spawn: `onRun` decides what each ffmpeg run does. */
function fakeSpawn(onRun) {
  const calls = [];
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killedWith = null;
    child.kill = (signal) => {
      child.killedWith = signal;
      setImmediate(() => child.emit('close', null, signal));
      return true;
    };
    const call = { binary, args, options, child, inputExisted: existsSync(args[args.indexOf('-i') + 1]) };
    calls.push(call);
    setImmediate(() => onRun(call, calls.length - 1));
    return child;
  };
  return { spawn, calls };
}

/** ffmpeg that works: pass 2 writes `gif` to its output file. */
const workingFfmpeg = (gif) => async ({ args, child }) => {
  if (args.includes('-filter_complex')) await fs.writeFile(args.at(-1), gif);
  child.emit('close', 0, null);
};

const served = (bytes) => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes });

describe('videoToGif: a video becomes a GIF with ffmpeg', () => {
  beforeEach(() => resetVideoState());

  test('the file type is read from its first bytes: mp4 / mov, webm / mkv, gif; anything else is refused', async () => {
    assert.equal(videoFormat(MP4_HEAD), 'mov');
    assert.equal(videoFormat(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moov'), Buffer.alloc(8)])), 'mov');
    assert.equal(videoFormat(WEBM_HEAD), 'matroska');
    assert.equal(videoFormat(await animatedGif()), 'gif');
    assert.equal(videoFormat(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer()), null);
    assert.equal(videoFormat(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nhttp://169.254.169.254/\n')), null, 'a playlist is never opened');
    assert.equal(videoFormat(Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n')), null, 'a concat list is never opened');
    assert.equal(videoFormat(Buffer.alloc(3)), null);
    await assert.rejects(() => videoToGif(Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n'), { ffmpegPath: 'ffmpeg' }), /not a video/);
  });

  test('ffmpeg is told the demuxer, only the file protocol, the first 10 s, 12 fps, at most 480 px, two palette passes', () => {
    const palette = paletteArgs('mov', '/tmp/x/input', '/tmp/x/palette.png');
    const gif = gifArgs('matroska', '/tmp/x/input', '/tmp/x/palette.png', '/tmp/x/out.gif');
    for (const args of [palette, gif]) {
      assert.ok(args.every((arg) => typeof arg === 'string'));
      const at = (flag) => args[args.indexOf(flag) + 1];
      assert.equal(at('-protocol_whitelist'), 'file');
      assert.equal(at('-t'), String(MAX_SECONDS));
      assert.ok(args.indexOf('-t') < args.indexOf('-i'), '-t limits the reading of the input');
      assert.ok(args.includes('-nostdin'));
      assert.equal(at('-max_pixels'), String(3840 * 2160));
      assert.equal(at('-i'), '/tmp/x/input');
    }
    assert.equal(palette[palette.indexOf('-f') + 1], 'mov');
    assert.equal(gif[gif.indexOf('-f') + 1], 'matroska');
    assert.match(palette.join(' '), new RegExp(`fps=${FPS},scale=w='min\\(${MAX_SIDE},iw\\)':h='min\\(${MAX_SIDE},ih\\)'.*palettegen`));
    assert.match(gif.join(' '), /paletteuse/);
    assert.equal(gif[gif.indexOf('-frames:v') + 1], String(MAX_SECONDS * FPS));
    assert.equal(gif[gif.indexOf('-loop') + 1], '0');
    assert.equal(gif.at(-1), '/tmp/x/out.gif');
    assert.deepEqual([MAX_SECONDS, FPS, MAX_SIDE, MAX_VIDEO_BYTES], [10, 12, 480, 20 * 1024 * 1024]);
  });

  test('runs ffmpeg without a shell, returns the GIF and always removes its temporary folder', async () => {
    const tmpdir = await tempRoot();
    const gif = await animatedGif();
    const { spawn, calls } = fakeSpawn(workingFfmpeg(gif));
    const result = await videoToGif(MP4_HEAD, { spawn, ffmpegPath: '/opt/ffmpeg', tmpdir });
    assert.deepEqual(result, gif);
    assert.equal(calls.length, 2, 'palette pass, then the GIF');
    for (const call of calls) {
      assert.equal(call.binary, '/opt/ffmpeg');
      assert.equal(call.options.shell, false);
      assert.ok(Array.isArray(call.args));
      assert.ok(call.inputExisted, 'the video was written before ffmpeg ran');
      assert.ok(call.args[call.args.indexOf('-i') + 1].startsWith(path.join(tmpdir, 'disbot-caption-')));
    }
    assert.ok(calls[0].args.join(' ').includes('palettegen'));
    assert.ok(calls[1].args.join(' ').includes('paletteuse'));
    assert.deepEqual(await fs.readdir(tmpdir), [], 'temporary folder removed');
  });

  test('a failing ffmpeg, a spawn error and a missing ffmpeg are errors, and the folder is still removed', async () => {
    const tmpdir = await tempRoot();
    const failing = fakeSpawn(({ child }) => { child.stderr.emit('data', Buffer.from('moov atom not found\n')); child.emit('close', 1, null); });
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn: failing.spawn, ffmpegPath: 'ffmpeg', tmpdir }), /ffmpeg failed \(1\): moov atom not found/);
    const missing = fakeSpawn(({ child }) => { child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })); child.emit('close', -2, null); });
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn: missing.spawn, ffmpegPath: 'ffmpeg', tmpdir }), /ENOENT/);
    const throwing = () => { throw new Error('spawn EACCES'); };
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn: throwing, ffmpegPath: 'ffmpeg', tmpdir }), /EACCES/);
    const noGif = fakeSpawn(({ child }) => child.emit('close', 0, null));
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn: noGif.spawn, ffmpegPath: 'ffmpeg', tmpdir }), /ENOENT|no GIF/);
    await assert.rejects(() => videoToGif(MP4_HEAD, { ffmpegPath: null, tmpdir }), /no ffmpeg/);
    await assert.rejects(() => videoToGif(Buffer.concat([MP4_HEAD, Buffer.alloc(MAX_VIDEO_BYTES)]), { ffmpegPath: 'ffmpeg', tmpdir }), /too big/);
    assert.deepEqual(await fs.readdir(tmpdir), []);
  });

  test('a stuck ffmpeg is killed at the time limit', async () => {
    const tmpdir = await tempRoot();
    const stuck = fakeSpawn(() => {});
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn: stuck.spawn, ffmpegPath: 'ffmpeg', tmpdir, timeoutMs: 30 }), /ffmpeg timeout/);
    assert.equal(stuck.calls[0].child.killedWith, 'SIGKILL');
    assert.equal(stuck.calls.length, 1);
    assert.deepEqual(await fs.readdir(tmpdir), []);
    await assert.rejects(() => runFfmpeg('ffmpeg', [], { spawn: stuck.spawn, timeoutMs: 0 }), /ffmpeg timeout/);
  });

  test(`one ffmpeg at a time: ${MAX_WAITING} more wait their turn, any more are busy`, async () => {
    const tmpdir = await tempRoot();
    const gif = await animatedGif();
    const gates = [];
    const { spawn, calls } = fakeSpawn((call) => { gates.push(() => workingFfmpeg(gif)(call)); });
    const jobs = Array.from({ length: 1 + MAX_WAITING }, () => videoToGif(MP4_HEAD, { spawn, ffmpegPath: 'ffmpeg', tmpdir }));
    // The others are in line at once, so one more is refused straight away.
    await assert.rejects(() => videoToGif(MP4_HEAD, { spawn, ffmpegPath: 'ffmpeg', tmpdir }), /busy/);
    for (let tries = 0; calls.length < 1 && tries < 1000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, 'only the first job runs ffmpeg');
    // Let every ffmpeg run finish as it comes.
    let finished = 0;
    const results = Promise.all(jobs).finally(() => { finished = jobs.length; });
    for (let tries = 0; finished < jobs.length && tries < 4000; tries += 1) {
      const next = gates.shift();
      if (next) await next();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await results).length, 1 + MAX_WAITING);
    assert.equal(calls.length, 2 * (1 + MAX_WAITING));
    assert.deepEqual(await fs.readdir(tmpdir), []);
  });
});

describe('the caption finds the video of a message', () => {
  const pickerEmbed = () => ({
    type: 'gifv',
    url: 'https://gifs.example.com/view/123',
    thumbnail: { url: 'https://static.example.com/123.png', proxyURL: 'https://images-ext-1.discordapp.net/external/a/https/static.example.com/123.png' },
    video: { url: 'https://static.example.com/123.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/b/https/static.example.com/123.mp4' },
  });
  const message = (replied, own = {}) => ({
    guild: { id: HOME_GUILD_ID }, content: '.caption x', attachments: new Map(), embeds: [], ...own,
    reference: replied ? { messageId: 'r' } : null, fetchReference: async () => replied,
  });

  test('a GIF-picker video from another site: Discord\'s proxy copy of the video first, the still thumbnail as fallback', async () => {
    const source = await findMediaSource(message({ attachments: new Map(), content: '', embeds: [pickerEmbed()] }));
    assert.equal(source.url, 'https://images-ext-1.discordapp.net/external/a/https/static.example.com/123.png');
    assert.equal(source.videoStill, true);
    assert.deepEqual(source.video.candidates, ['https://images-ext-1.discordapp.net/external/b/https/static.example.com/123.mp4']);
    assert.ok(source.video.candidates.every(isSafeUrl), 'never the outside host');
  });

  test('a Tenor GIF from the picker: its animated GIF first, its mp4 kept as the fallback', async () => {
    const embed = {
      type: 'gifv', url: 'https://tenor.com/view/x-1',
      thumbnail: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAAe/x.png' },
      video: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAPo/x.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/c/https/media.tenor.com/AbCdEfGhIjkAAAPo/x.mp4' },
    };
    const source = await findMediaSource(message({ attachments: new Map(), content: '', embeds: [embed] }), [], { fetch: async () => { throw new Error('no fetch'); } });
    assert.equal(source.url, 'https://media.tenor.com/AbCdEfGhIjkAAAAd/x.gif');
    assert.equal(source.videoStill, false);
    assert.deepEqual(source.video.candidates, [embed.video.url, embed.video.proxyURL]);
  });

  test('an uploaded video, own or replied to, and a Discord video link: only the video', async () => {
    const clip = { url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1', proxyURL: 'https://media.discordapp.net/attachments/1/2/clip.mp4?ex=1', contentType: 'video/mp4', name: 'clip.mp4', size: 1234 };
    const own = await findMediaSource(message(null, { attachments: new Map([['1', clip]]) }));
    assert.deepEqual(own, { url: clip.url, candidates: [], videoStill: false, video: { candidates: [clip.url, clip.proxyURL], size: 1234 } });
    const replied = await findMediaSource(message({ attachments: new Map([['1', { ...clip, contentType: undefined, name: 'clip.webm', url: 'https://cdn.discordapp.com/a/clip.webm' }]]), embeds: [], content: '' }));
    assert.deepEqual(replied.video.candidates.slice(0, 1), ['https://cdn.discordapp.com/a/clip.webm']);
    const linked = await findMediaSource(message({ attachments: new Map(), embeds: [], content: 'look https://cdn.discordapp.com/attachments/1/2/v.mov' }));
    assert.deepEqual(linked, { url: 'https://cdn.discordapp.com/attachments/1/2/v.mov', candidates: [], videoStill: false, video: { candidates: ['https://cdn.discordapp.com/attachments/1/2/v.mov'] } });
    const outside = await findMediaSource(message({ attachments: new Map(), embeds: [], content: 'https://evil.example.com/v.mp4' }));
    assert.equal(outside, null, 'a video on another site is not downloaded');
  });

  test('.gif and the background remover keep their picture-only sources', async () => {
    const clip = { url: 'https://cdn.discordapp.com/a/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4' };
    assert.equal(await findImageSource(message(null, { attachments: new Map([['1', clip]]) })), null);
    const source = await findImageSource(message({ attachments: new Map(), content: '', embeds: [pickerEmbed()] }));
    assert.deepEqual(Object.keys(source).sort(), ['candidates', 'url', 'videoStill']);
  });
});

describe('caption on a video GIF answers an animated GIF', () => {
  beforeEach(() => {
    resetCaptionState();
    resetVideoState();
  });

  const commandMessage = (guildId, replied, sent, own = {}) => ({
    guild: { id: guildId },
    author: { id: `u-video-${guildId}-${Math.random()}` },
    content: '.كابشن اصحى',
    attachments: new Map(),
    embeds: [],
    reference: replied ? { messageId: 'm-video' } : null,
    fetchReference: async () => replied,
    channel: { sendTyping: async () => {} },
    reply: async (payload) => { sent.push(payload); return payload; },
    ...own,
  });
  const pickerMessage = () => ({
    attachments: new Map(),
    content: '',
    embeds: [{
      type: 'gifv',
      url: 'https://gifs.example.com/view/9',
      thumbnail: { url: 'https://static.example.com/9.png', proxyURL: 'https://images-ext-1.discordapp.net/external/t/https/static.example.com/9.png' },
      video: { url: 'https://static.example.com/9.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/v/https/static.example.com/9.mp4' },
    }],
  });

  async function assertAnimatedCaption(payload, frames) {
    assert.equal(payload.files[0].name, 'caption.gif');
    assert.equal(payload.content, undefined, 'no "upload it as a GIF file" note');
    const meta = await sharp(payload.files[0].attachment, { animated: true }).metadata();
    assert.equal(meta.format, 'gif');
    assert.equal(meta.pages, frames);
    const tops = [];
    for (let page = 0; page < meta.pages; page += 1) {
      const { data, info } = await sharp(payload.files[0].attachment, { page }).raw().toBuffer({ resolveWithObject: true });
      const at = (y) => [...data.subarray(y * info.width * info.channels, y * info.width * info.channels + 3)];
      assert.ok(at(1).every((value) => value > 245), `frame ${page} has the white caption bar`);
      tops.push(at(info.height - 2).join());
    }
    assert.ok(new Set(tops).size > 1, 'the frames differ: it moves');
  }

  for (const guildId of SERVERS) {
    test(`a GIF-picker video from another site becomes an animated caption (server ${guildId})`, async () => {
      const video = Buffer.concat([MP4_HEAD, Buffer.from('video')]);
      const gif = await animatedGif({ frames: 4 });
      const requested = [];
      const converted = [];
      const fetchStub = async (url) => {
        requested.push(String(url));
        if (String(url).includes('/v/https/static.example.com/9.mp4')) return served(video);
        throw new Error(`unexpected ${url}`);
      };
      const sent = [];
      await handleCaptionCommand(commandMessage(guildId, pickerMessage(), sent), ['اصحى'], {
        fetch: fetchStub,
        videoToGif: async (bytes) => { converted.push(bytes); return gif; },
      });
      assert.deepEqual(requested, ['https://images-ext-1.discordapp.net/external/v/https/static.example.com/9.mp4']);
      assert.deepEqual(converted, [video]);
      assert.equal(sent.length, 1);
      await assertAnimatedCaption(sent[0], 4);
    });

    test(`when the conversion fails the still comes with a short note, not "upload it as a GIF" (server ${guildId})`, async () => {
      const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
      const fetchStub = async (url) => (String(url).endsWith('.mp4') ? served(MP4_HEAD) : served(png));
      const sent = [];
      await handleCaptionCommand(commandMessage(guildId, pickerMessage(), sent), ['اصحى'], {
        fetch: fetchStub,
        videoToGif: async () => { throw new Error('ffmpeg failed (1)'); },
      });
      assert.equal(sent[0].files[0].name, 'caption.png');
      assert.equal(sent[0].content, TEXT.videoStill);
      assert.doesNotMatch(TEXT.videoStill, /ارفعه/u);
    });

    test(`an uploaded video becomes an animated caption; too big or broken gets its own answer (server ${guildId})`, async () => {
      const clip = { url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', contentType: 'video/mp4', name: 'clip.mp4', size: 5000 };
      const gif = await animatedGif({ frames: 3 });
      const sent = [];
      await handleCaptionCommand(commandMessage(guildId, null, sent, { attachments: new Map([['1', clip]]) }), ['اصحى'], {
        fetch: async () => served(MP4_HEAD),
        videoToGif: async () => gif,
      });
      await assertAnimatedCaption(sent[0], 3);

      resetCaptionState();
      const big = [];
      let fetched = false;
      await handleCaptionCommand(commandMessage(guildId, null, big, { attachments: new Map([['1', { ...clip, size: MAX_VIDEO_BYTES + 1 }]]) }), ['اصحى'], {
        fetch: async () => { fetched = true; return served(MP4_HEAD); },
      });
      assert.equal(big[0].content, TEXT.videoTooBig);
      assert.equal(fetched, false, 'not even downloaded');

      resetCaptionState();
      const broken = [];
      await handleCaptionCommand(commandMessage(guildId, null, broken, { attachments: new Map([['1', clip]]) }), ['اصحى'], {
        fetch: async () => served(MP4_HEAD),
        videoToGif: async () => { throw new Error('ffmpeg timeout'); },
      });
      assert.equal(broken[0].content, TEXT.videoFailed);
    });

    test(`a Tenor GIF whose GIF files fail falls back to its mp4 (server ${guildId})`, async () => {
      const gif = await animatedGif({ frames: 2 });
      const replied = {
        attachments: new Map(), content: '',
        embeds: [{ type: 'gifv', url: 'https://tenor.com/view/x-1', thumbnail: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAAe/x.png' }, video: { url: 'https://media.tenor.com/AbCdEfGhIjkAAAPo/x.mp4' } }],
      };
      const requested = [];
      const fetchStub = async (url) => {
        requested.push(String(url));
        return String(url).endsWith('.mp4') ? served(MP4_HEAD) : { ok: false, status: 404, headers: new Headers() };
      };
      const sent = [];
      await handleCaptionCommand(commandMessage(guildId, replied, sent), ['اصحى'], { fetch: fetchStub, videoToGif: async () => gif });
      assert.deepEqual(requested, [
        'https://media.tenor.com/AbCdEfGhIjkAAAAd/x.gif',
        'https://media.tenor.com/AbCdEfGhIjkAAAAC/x.gif',
        'https://media.tenor.com/AbCdEfGhIjkAAAAM/x.gif',
        'https://media.tenor.com/AbCdEfGhIjkAAAPo/x.mp4',
      ]);
      await assertAnimatedCaption(sent[0], 2);
    });

    test(`/caption with a video attachment answers an animated GIF (server ${guildId})`, async () => {
      const gif = await animatedGif({ frames: 3 });
      let replied = null;
      const interaction = {
        guildId,
        user: { id: `slash-video-${guildId}` },
        deferReply: async () => {},
        editReply: async (payload) => { replied = payload; },
        options: {
          getString: (name) => (name === 'text' ? 'اصحى' : null),
          getAttachment: (name) => (name === 'image' ? { url: 'https://cdn.discordapp.com/attachments/1/2/c.webm', contentType: 'video/webm', name: 'c.webm', size: 900 } : null),
        },
      };
      await handleCaptionInteraction(interaction, { fetch: async () => served(WEBM_HEAD), videoToGif: async () => gif });
      assert.equal(replied.files[0].name, 'caption.gif');
      assert.equal(replied.content, '');
    });
  }

  test('a busy converter says so; a video that is not one says it could not convert', async () => {
    const replies = [];
    const respond = (payload) => { replies.push(payload.content); return payload; };
    const image = async () => ({ url: 'https://cdn.discordapp.com/a.mp4', candidates: [], video: { candidates: ['https://cdn.discordapp.com/a.mp4'] } });
    await runCaption({ userId: 'busy-1', text: 'x', getImage: image, respond }, { download: async () => MP4_HEAD, videoToGif: async () => { throw new Error('busy'); } });
    await runCaption({ userId: 'busy-2', text: 'x', getImage: image, respond }, { download: async () => Buffer.from('<html>'), videoToGif: (bytes) => videoToGif(bytes, { ffmpegPath: 'ffmpeg' }) });
    assert.deepEqual(replies, [TEXT.videoBusy, TEXT.videoFailed]);
  });

  test('the video is downloaded with the 20 MB limit and a longer time limit', async () => {
    const seen = [];
    const getImage = async () => ({ url: 'https://cdn.discordapp.com/a.mp4', candidates: [], video: { candidates: ['https://cdn.discordapp.com/a.mp4'] } });
    await runCaption({ userId: 'limits', text: 'x', getImage, respond: (payload) => payload }, {
      download: async (url, fetchImpl, maxBytes, options) => { seen.push({ maxBytes, timeoutMs: options.timeoutMs }); return MP4_HEAD; },
      videoToGif: async () => animatedGif({ frames: 2 }),
    });
    assert.deepEqual(seen, [{ maxBytes: MAX_VIDEO_BYTES, timeoutMs: 20_000 }]);
  });
});

describe('downloads follow redirects only to safe hosts', () => {
  const redirect = (location) => ({ ok: false, status: 302, headers: new Headers({ location }), body: { cancel: async () => {} } });

  test('a redirect to Discord / Tenor / Giphy is followed, anything else is refused', async () => {
    const asked = [];
    const options = [];
    const fetchStub = async (url, init) => {
      asked.push(String(url));
      options.push(init.redirect);
      if (String(url).endsWith('/start.mp4')) return redirect('/moved.mp4');
      if (String(url).endsWith('/moved.mp4')) return redirect('https://media.discordapp.net/final.mp4');
      if (String(url).endsWith('/final.mp4')) return served(MP4_HEAD);
      if (String(url).endsWith('/evil.mp4')) return redirect('https://169.254.169.254/latest/meta-data');
      throw new Error(`unexpected ${url}`);
    };
    assert.deepEqual(await download('https://cdn.discordapp.com/start.mp4', fetchStub, 1000), MP4_HEAD);
    assert.deepEqual(asked, ['https://cdn.discordapp.com/start.mp4', 'https://cdn.discordapp.com/moved.mp4', 'https://media.discordapp.net/final.mp4']);
    assert.ok(options.every((mode) => mode === 'manual'));
    asked.length = 0;
    await assert.rejects(() => download('https://cdn.discordapp.com/evil.mp4', fetchStub, 1000), /unsafe redirect/);
    assert.deepEqual(asked, ['https://cdn.discordapp.com/evil.mp4'], 'the outside host is never asked');
    const loop = async (url) => redirect(String(url));
    await assert.rejects(() => download('https://cdn.discordapp.com/loop.mp4', loop, 1000), /unsafe redirect/);
    await assert.rejects(() => download('https://cdn.discordapp.com/final.mp4', fetchStub, 10), /too big/);
  });

  test('downloadFirst passes the time limit and the safety check to each download', async () => {
    const seen = [];
    await downloadFirst(['https://cdn.discordapp.com/a.mp4'], { timeoutMs: 1234, download: async (url, fetchImpl, maxBytes, options) => { seen.push(options); return MP4_HEAD; } });
    assert.equal(seen[0].timeoutMs, 1234);
    assert.equal(seen[0].safe, isSafeUrl);
  });
});

// Real ffmpeg (the ffmpeg-static binary installed with npm): a tiny generated video becomes an animated caption.
const binary = ffmpegBinary();
const skip = binary ? false : 'the ffmpeg-static binary is not installed';

/** A 1-second, 10-frame video (solid colours changing every frame), made with ffmpeg's own encoders. */
async function tinyVideo(container) {
  const dir = await tempRoot();
  const width = 96;
  const height = 64;
  const frames = 10;
  const raw = Buffer.alloc(width * height * 4 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const [r, g, b] = COLORS[frame % COLORS.length];
    for (let pixel = 0; pixel < width * height; pixel += 1) raw.set([r, g, b, 255], (frame * width * height + pixel) * 4);
  }
  const rawPath = path.join(dir, 'frames.rgba');
  const out = path.join(dir, `clip.${container === 'mp4' ? 'mp4' : 'mkv'}`);
  await fs.writeFile(rawPath, raw);
  await runFfmpeg(binary, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', '10', '-i', rawPath,
    '-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p', '-f', container === 'mp4' ? 'mp4' : 'matroska', out,
  ]);
  return fs.readFile(out);
}

describe('real ffmpeg (ffmpeg-static)', { skip }, () => {
  beforeEach(() => {
    resetCaptionState();
    resetVideoState();
  });

  for (const container of ['mp4', 'matroska']) {
    test(`a tiny ${container} video becomes an animated GIF, and the temporary folder is removed`, async () => {
      const video = await tinyVideo(container);
      assert.equal(videoFormat(video), container === 'mp4' ? 'mov' : 'matroska');
      const tmpdir = await tempRoot();
      const gif = await videoToGif(video, { tmpdir });
      const meta = await sharp(gif, { animated: true }).metadata();
      assert.equal(meta.format, 'gif');
      assert.equal(meta.width, 96);
      assert.ok(meta.pages >= 10, `${meta.pages} frames`);
      assert.ok(Math.abs(meta.delay.reduce((sum, delay) => sum + delay, 0) - 1000) <= 100, 'plays for about a second');
      assert.deepEqual(await fs.readdir(tmpdir), []);
    });
  }

  test('ffmpeg is killed at the time limit and nothing is left behind', async () => {
    const video = await tinyVideo('mp4');
    const tmpdir = await tempRoot();
    await assert.rejects(() => videoToGif(video, { tmpdir, timeoutMs: 1 }), /ffmpeg timeout/);
    assert.deepEqual(await fs.readdir(tmpdir), []);
  });

  for (const guildId of SERVERS) {
    test(`.كابشن on a GIF-picker video, end to end with real ffmpeg (server ${guildId})`, async () => {
      const video = await tinyVideo('mp4');
      const replied = {
        attachments: new Map(), content: '',
        embeds: [{
          type: 'gifv', url: 'https://gifs.example.com/view/real',
          thumbnail: { url: 'https://static.example.com/real.png', proxyURL: 'https://images-ext-1.discordapp.net/external/t/https/static.example.com/real.png' },
          video: { url: 'https://static.example.com/real.mp4', proxyURL: 'https://images-ext-2.discordapp.net/external/v/https/static.example.com/real.mp4' },
        }],
      };
      const sent = [];
      const message = {
        guild: { id: guildId }, author: { id: `real-${guildId}` }, content: '.كابشن اصحى يا ادم', attachments: new Map(), embeds: [],
        reference: { messageId: 'm' }, fetchReference: async () => replied, channel: { sendTyping: async () => {} },
        reply: async (payload) => { sent.push(payload); return payload; },
      };
      await handleCaptionCommand(message, ['اصحى', 'يا', 'ادم'], {
        fetch: async (url) => {
          if (String(url) === 'https://images-ext-2.discordapp.net/external/v/https/static.example.com/real.mp4') return served(video);
          throw new Error(`unexpected ${url}`);
        },
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].files[0].name, 'caption.gif');
      assert.equal(sent[0].content, undefined);
      const meta = await sharp(sent[0].files[0].attachment, { animated: true }).metadata();
      assert.ok(meta.pages >= 2, 'animated');
      assert.ok(meta.pageHeight > 64, 'the caption bar is above the video');
      const first = await sharp(sent[0].files[0].attachment, { page: 0 }).raw().toBuffer({ resolveWithObject: true });
      const later = await sharp(sent[0].files[0].attachment, { page: meta.pages - 1 }).raw().toBuffer({ resolveWithObject: true });
      const bottom = ({ data, info }) => [...data.subarray((info.height - 3) * info.width * info.channels, (info.height - 3) * info.width * info.channels + 3)];
      const top = ({ data, info }) => [...data.subarray(info.width * info.channels, info.width * info.channels + 3)];
      assert.ok(top(first).every((value) => value > 245) && top(later).every((value) => value > 245), 'white caption bar on every frame');
      assert.notDeepEqual(bottom(first), bottom(later), 'the video moves');
    });
  }
});
