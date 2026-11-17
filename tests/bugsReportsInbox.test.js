import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { getGuildConfig, updateGuildConfig } from '../src/services/config/guildConfig.js';
import { BUGS_REPORTS_CHANNEL_NAME, buildBugsReportsGuide } from '../src/services/bugsReportsRoom.js';
import {
  handleBugsReportsMessage, resetBugsReportsRateLimit, RATE_LIMIT, COUNTER_KEY, MAX_REUPLOAD_BYTES, nextBugReportNumber, pickReuploads, resetBugReportCounter,
} from '../src/services/bugsReportsInbox.js';
import { checkClosedReports } from '../src/services/reportIssueService.js';

const BOT_ID = '100000000000000001';
const STAFF_ID = '200000000000000001';
let nextId = 1;
const snowflake = () => `7${String(nextId++).padStart(17, '0')}`;

// GitHub fake: records the issues opened and the labels added; `closed` is what the watcher sees.
function fakeGitHub({ closed = [] } = {}) {
  const calls = { issues: [], labels: [], gets: [] };
  let number = 41;
  mock.method(axios, 'create', () => ({
    post: async (path, body) => {
      if (path === '/issues') {
        calls.issues.push(body);
        number += 1;
        return { data: { number } };
      }
      calls.labels.push({ path, body });
      return { data: {} };
    },
    get: async (path, options) => {
      calls.gets.push({ path, options });
      return { data: closed };
    },
  }));
  return calls;
}

function fakeMessageStore(channel) {
  const messages = new Map();
  const make = (payload, { author, reference } = {}) => {
    const message = {
      id: snowflake(), channelId: channel.id, guildId: channel.guild.id, channel, guild: channel.guild,
      author, content: payload.content || '', embeds: payload.embeds || [], reference,
      url: `https://discord.com/channels/${channel.guild.id}/${channel.id}/x`,
      replies: [], edits: [], deleted: false, sent: payload,
      // Files sent with the message come back as new attachments on the bot's own message.
      attachments: new Map((payload.files || []).map((file, index) => [String(index), { url: `https://cdn.discordapp.com/re/${file.name}`, name: file.name }])),
    };
    message.edit = async (next) => { message.edits.push(next); message.embeds = next.embeds; return message; };
    message.reply = async (next) => {
      const reply = make(next, { author: { id: BOT_ID, bot: true }, reference: { messageId: message.id } });
      message.replies.push(reply);
      return reply;
    };
    message.delete = async () => { message.deleted = true; messages.delete(message.id); };
    messages.set(message.id, message);
    channel.posted.push(message);
    return message;
  };
  channel.messages = { fetch: async (id) => messages.get(id) || Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 })) };
  return { make, messages };
}

function fakeDb(store = new Map()) {
  return {
    store,
    // A short pause on every read and write, so parallel reports really overlap.
    get: async (key, fallback) => { await new Promise((resolve) => setImmediate(resolve)); return store.has(key) ? structuredClone(store.get(key)) : fallback; },
    set: async (key, value) => { await new Promise((resolve) => setImmediate(resolve)); store.set(key, structuredClone(value)); return true; },
  };
}

async function setup(guildId = HOME_GUILD_ID, { db = fakeDb() } = {}) {
  const channelsById = new Map();
  const client = { user: { id: BOT_ID }, db, channels: { fetch: async (id) => channelsById.get(id) || null } };
  const guild = { id: guildId, name: 'Test Server', client };
  const room = { id: snowflake(), name: BUGS_REPORTS_CHANNEL_NAME, guild, posted: [], sendFailures: 0, filesFail: false, isTextBased: () => true, toString() { return `<#${this.id}>`; } };
  room.send = async (payload) => {
    if (room.sendFailures > 0) { room.sendFailures -= 1; throw new Error('Missing Permissions'); }
    if (room.filesFail && payload.files?.length) throw new Error('Request entity too large');
    return store$.make(payload, { author: { id: BOT_ID, bot: true } });
  };
  const store$ = fakeMessageStore(room);
  channelsById.set(room.id, room);
  await updateGuildConfig(client, guildId, { bugsReportsChannelId: room.id });

  const post = (content, { authorId = STAFF_ID, bot = false, attachments = [], reference, repliedUser, system = false } = {}) => {
    const author = { id: authorId, bot, tag: `user${authorId}`, displayAvatarURL: () => '', toString: () => `<@${authorId}>` };
    const message = store$.make({ content }, { author, reference });
    message.system = system;
    message.attachments = new Map(attachments.map((entry, index) => {
      const file = typeof entry === 'string' ? { url: entry } : entry;
      return [String(index), { name: `file${index}.png`, size: 1000, ...file }];
    }));
    message.mentions = { repliedUser: repliedUser || null };
    message.createdTimestamp = Date.now();
    return message;
  };
  return { client, guild, room, channelsById, post };
}

const reportsIn = (room) => room.posted.filter((message) => message.author.id === BOT_ID && message.embeds?.[0]?.title?.startsWith('🐞 بلاغ #'));

describe('#bugs-reports inbox', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    resetBugsReportsRateLimit();
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env.GITHUB_TOKEN;
  });

  test('a staff message becomes 🐞 بلاغ #1 — مفتوح (not a reply), files re-uploaded, original deleted, issue [bugs #1]', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('أمر التايم مش شغال في روم الشات', { attachments: [{ url: 'https://cdn.example/shot.png', name: 'shot.png' }] });
    assert.equal(await handleBugsReportsMessage(original, client), true);

    const [report] = reportsIn(room);
    assert.ok(report, 'the report is posted in the room');
    assert.equal(report.reference, undefined, 'not a reply to the original');
    assert.equal(original.replies.length, 0);
    assert.deepEqual(report.sent.allowedMentions, { parse: [] }, 'nobody is pinged');
    assert.deepEqual(report.sent.files, [{ attachment: 'https://cdn.example/shot.png', name: 'shot.png' }]);
    assert.equal(original.deleted, true, 'the original is removed once the report holds everything');

    assert.equal(calls.issues.length, 1);
    const [issue] = calls.issues;
    assert.equal(issue.title, `[bugs #1] user${STAFF_ID}: أمر التايم مش شغال في روم الشات`);
    assert.deepEqual(issue.labels, ['بلاغ', 'bugs-reports']);
    assert.match(issue.body, /\*\*رقم البلاغ:\*\* #1/u);
    assert.match(issue.body, /\*\*السيرفر:\*\* Test Server/u);
    assert.match(issue.body, /https:\/\/cdn\.discordapp\.com\/re\/shot\.png/u, 'the re-uploaded file, not the dead link');
    assert.match(issue.body, new RegExp(`<!-- discord:${HOME_GUILD_ID}/${room.id}/${report.id}/${STAFF_ID} -->$`, 'u'));
    assert.doesNotMatch(issue.body, /الرسالة الأصلية/u, 'no link to a deleted message');

    const embed = report.embeds[0];
    assert.equal(embed.title, '🐞 بلاغ #1 — مفتوح');
    assert.equal(embed.footer.text, 'bugs-reports • GitHub #42');
    assert.match(embed.description, /أمر التايم مش شغال/u);
    assert.match(embed.description, new RegExp(`<@${STAFF_ID}>`, 'u'));
    assert.match(embed.description, /<t:\d+:F>/u);
    assert.match(embed.description, /📎 shot\.png/u);
  });

  test('every report gets the next number of its guild, and the counter survives a restart', async () => {
    fakeGitHub();
    const db = fakeDb();
    const first = await setup(HOME_GUILD_ID, { db });
    for (const text of ['مشكلة أولى', 'مشكلة تانية']) await handleBugsReportsMessage(first.post(text), first.client);
    assert.deepEqual(reportsIn(first.room).map((report) => report.embeds[0].title), ['🐞 بلاغ #1 — مفتوح', '🐞 بلاغ #2 — مفتوح']);

    // A restart: a new client and a new room object, the same database.
    resetBugsReportsRateLimit();
    const second = await setup(HOME_GUILD_ID, { db });
    await handleBugsReportsMessage(second.post('مشكلة بعد الريستارت'), second.client);
    assert.equal(reportsIn(second.room)[0].embeds[0].title, '🐞 بلاغ #3 — مفتوح');
    assert.equal((await getGuildConfig(second.client, HOME_GUILD_ID))[COUNTER_KEY], 3);

    // Another guild counts on its own.
    const zenith = await setup(ZENITH_GUILD_ID, { db });
    await handleBugsReportsMessage(zenith.post('في زينيث'), zenith.client);
    assert.equal(reportsIn(zenith.room)[0].embeds[0].title, '🐞 بلاغ #1 — مفتوح');
  });

  test('reports posted at the same moment never share a number', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    const messages = ['200000000000000011', '200000000000000012', '200000000000000013', '200000000000000014']
      .map((authorId, index) => post(`مشكلة متوازية ${index}`, { authorId }));
    await Promise.all(messages.map((message) => handleBugsReportsMessage(message, client)));
    const numbers = reportsIn(room).map((report) => Number(report.embeds[0].title.match(/#(\d+)/u)[1])).sort();
    assert.deepEqual(numbers, [1, 2, 3, 4]);
    assert.deepEqual(calls.issues.map((issue) => issue.title.match(/^\[bugs #(\d+)\]/u)[1]).sort(), ['1', '2', '3', '4']);
    const direct = await Promise.all([nextBugReportNumber(client, HOME_GUILD_ID), nextBugReportNumber(client, HOME_GUILD_ID)]);
    assert.deepEqual(direct, [5, 6]);
  });

  test('when posting the report fails, the original is never deleted', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    room.sendFailures = 1;
    const original = post('مشكلة والبوت مش قادر يكتب');
    assert.equal(await handleBugsReportsMessage(original, client), true);
    assert.equal(original.deleted, false);
    assert.equal(reportsIn(room).length, 0);
    assert.equal(calls.issues.length, 0);
  });

  test('when the files cannot be uploaded, the report is posted with links and the original stays', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    room.filesFail = true;
    const original = post('صورة المشكلة', { attachments: [{ url: 'https://cdn.example/a.png', name: 'a.png' }] });
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    assert.equal(report.sent.files, undefined);
    assert.match(report.embeds[0].description, /https:\/\/cdn\.example\/a\.png/u);
    assert.equal(original.deleted, false);
  });

  test('at most 5 files and 20 MB are re-uploaded; a bigger one stays a link and the original is kept', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const big = { url: 'https://cdn.example/video.mp4', name: 'video.mp4', size: MAX_REUPLOAD_BYTES };
    const small = Array.from({ length: 6 }, (_, index) => ({ url: `https://cdn.example/s${index}.png`, name: `s${index}.png`, size: 10 }));
    const original = post('ملفات كتير', { attachments: [small[0], big, ...small.slice(1)] });
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    assert.deepEqual(report.sent.files.map((file) => file.name), ['s0.png', 's1.png', 's2.png', 's3.png', 's4.png']);
    assert.match(report.embeds[0].description, /https:\/\/cdn\.example\/video\.mp4/u);
    assert.match(report.embeds[0].description, /https:\/\/cdn\.example\/s5\.png/u);
    assert.equal(original.deleted, false, 'a file that is only a link would die with the original');
    assert.deepEqual(pickReuploads([{ size: MAX_REUPLOAD_BYTES + 1 }, { size: 5 }]).uploads, [{ size: 5 }]);
  });

  test('works in Zenith too', async () => {
    const calls = fakeGitHub();
    const { client, post } = await setup(ZENITH_GUILD_ID);
    assert.equal(await handleBugsReportsMessage(post('البوت مش بيرد'), client), true);
    assert.equal(calls.issues.length, 1);
  });

  test('without GITHUB_TOKEN the report is still numbered, with the warning footer', async () => {
    delete process.env.GITHUB_TOKEN;
    const { client, room, post } = await setup();
    const original = post('مشكلة في اللوج');
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    assert.equal(report.embeds[0].title, '🐞 بلاغ #1 — مفتوح');
    assert.equal(report.embeds[0].footer.text, 'bugs-reports • ⚠️ مش متسجل في GitHub');
    assert.equal(original.deleted, true);
  });

  test('when GitHub refuses the issue, the report is still numbered, with the warning footer', async () => {
    mock.method(axios, 'create', () => ({
      post: async () => { throw Object.assign(new Error('Forbidden'), { response: { status: 403, data: { message: 'Resource not accessible' } } }); },
      get: async () => ({ data: [] }),
    }));
    const { client, room, post } = await setup();
    await handleBugsReportsMessage(post('مشكلة والتوكن بايظ'), client);
    const [report] = reportsIn(room);
    assert.equal(report.embeds[0].title, '🐞 بلاغ #1 — مفتوح');
    assert.match(report.embeds[0].footer.text, /⚠️ مش متسجل في GitHub/u);
  });

  test('another channel named bugs-reports (not the saved one) is left alone', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    const message = post('مشكلة في البوت');
    message.channel = { ...room, id: snowflake() };
    assert.equal(await handleBugsReportsMessage(message, client), false);
    assert.equal(calls.issues.length, 0);
  });

  test('the guide, the bot, other bots, system, empty, short and replies to the bot are never reports', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    const guide = await room.send({ embeds: [buildBugsReportsGuide()] });
    guide.attachments = new Map();
    guide.mentions = { repliedUser: null };
    const cases = [
      guide,
      post('رسالة من بوت تاني', { authorId: '300000000000000001', bot: true }),
      post('', {}),
      post('   '),
      post('ok'),
      post('pinned', { system: true }),
      post('تمام اتحلت شكراً', { reference: { messageId: guide.id }, repliedUser: { id: BOT_ID } }),
    ];
    for (const message of cases) assert.equal(await handleBugsReportsMessage(message, client), true);
    assert.equal(calls.issues.length, 0);
    assert.equal(reportsIn(room).length, 0);
    // A picture with no text is a report.
    await handleBugsReportsMessage(post('', { attachments: ['https://cdn.example/a.png'] }), client);
    assert.equal(calls.issues.length, 1);
  });

  test(`at most ${RATE_LIMIT} reports per member in 10 minutes, then one short notice and silence`, async () => {
    const calls = fakeGitHub();
    const { client, post } = await setup();
    const messages = [];
    for (let index = 0; index < RATE_LIMIT + 3; index += 1) {
      const message = post(`مشكلة رقم ${index + 1}`);
      messages.push(message);
      await handleBugsReportsMessage(message, client);
    }
    assert.equal(calls.issues.length, RATE_LIMIT);
    const notices = messages.slice(RATE_LIMIT).flatMap((message) => message.replies);
    assert.equal(notices.length, 1);
    assert.match(notices[0].content, /⏱️/u);
    assert.equal(notices[0].embeds.length, 0);
    // Another member is not limited.
    await handleBugsReportsMessage(post('مشكلة من حد تاني', { authorId: '200000000000000002' }), client);
    assert.equal(calls.issues.length, RATE_LIMIT + 1);
  });
});

describe('closing a report (checkClosedReports)', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    resetBugsReportsRateLimit();
  });
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
    delete process.env.GITHUB_TOKEN;
  });

  const closedIssue = (number, { guildId, channelId, messageId, reporterId = STAFF_ID, reason = 'completed', labels = ['بلاغ', 'bugs-reports'] }) => ({
    number,
    state_reason: reason,
    closed_at: '2026-11-15T10:00:00Z',
    labels: labels.map((name) => ({ name })),
    body: `x\n<!-- discord:${guildId}/${channelId}/${messageId}/${reporterId} -->`,
  });

  test('completed: the embed turns green with the report number (not the issue number) and a permanent reply', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('مشكلة في الأمر');
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    mock.restoreAll();

    const calls = fakeGitHub({ closed: [closedIssue(42, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: report.id })] });
    mock.timers.enable({ apis: ['setTimeout'] });
    await checkClosedReports(client);
    mock.timers.tick(60_000);

    const embed = report.embeds[0];
    assert.equal(embed.title, '✅ بلاغ #1 — اتقفل (اتحل)', 'report #1, GitHub issue #42');
    assert.equal(embed.color, 0x2ecc71);
    assert.match(embed.footer.text, /GitHub #42 • ✅ اتحل في 2026-11-15/u);
    assert.match(embed.description, /مشكلة في الأمر/u, 'the report text is kept');
    const [notice] = report.replies;
    assert.equal(notice.content, `<@${STAFF_ID}> ✅ البلاغ #1 اتحل`);
    assert.equal(notice.deleted, true, 'the short notice deletes itself after 5 seconds');
    assert.deepEqual(calls.labels, [{ path: '/issues/42/labels', body: { labels: ['اتحلت'] } }]);
    assert.ok(calls.gets[0].options.params.since, 'the since window is used');
    assert.equal(calls.gets[0].options.params.labels, 'بلاغ');
  });

  test('not planned: grey 🔒 بلاغ #N — اتقفل stays, the "closed without a fix" reply deletes itself after 5 seconds (report #281)', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('حاجة مش مهمة');
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    mock.restoreAll();
    const calls = fakeGitHub({ closed: [closedIssue(42, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: report.id, reason: 'not_planned' })] });
    mock.timers.enable({ apis: ['setTimeout'] });
    await checkClosedReports(client);
    assert.equal(report.embeds[0].title, '🔒 بلاغ #1 — اتقفل');
    assert.equal(report.embeds[0].color, 0x95a5a6);
    assert.equal(report.replies.length, 1);
    const [notice] = report.replies;
    assert.equal(notice.content, `<@${STAFF_ID}> 🔒 البلاغ #1 اتقفل`);
    mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(notice.deleted, false, 'still there before 5 seconds');
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(notice.deleted, true, 'deleted after 5 seconds');
    assert.deepEqual(calls.labels[0].body, { labels: ['اتقفلت'] });
  });

  test('not planned with the report message gone: the notice posted in the room deletes itself too', async () => {
    const { client, room } = await setup();
    const gone = closedIssue(51, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: '799999999999999998', reason: 'not_planned' });
    gone.title = `[bugs #8] user${STAFF_ID}: مشكلة`;
    fakeGitHub({ closed: [gone] });
    mock.timers.enable({ apis: ['setTimeout'] });
    await checkClosedReports(client);
    const notice = room.posted.find((message) => message.content?.includes('البلاغ #8'));
    assert.ok(notice);
    assert.equal(notice.deleted, false);
    mock.timers.tick(5_000);
    await Promise.resolve();
    assert.equal(notice.deleted, true);
  });

  test('an issue already labelled اتحلت is not announced again', async () => {
    const { client, room, post } = await setup();
    const original = post('مشكلة');
    const calls = fakeGitHub({ closed: [closedIssue(7, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: original.id, labels: ['بلاغ', 'bugs-reports', 'اتحلت'] })] });
    await checkClosedReports(client);
    assert.equal(original.replies.length, 0);
    assert.equal(calls.labels.length, 0);
  });

  test('the old report channel still gets the self-deleting reply', async () => {
    const { client, channelsById, guild } = await setup();
    // The watcher only answers in the real report channel (REPORT_CHANNEL_ID) or the saved bugs room.
    const { REPORT_CHANNEL_ID } = await import('../src/services/reportChannelService.js');
    const oldChannel = { id: REPORT_CHANNEL_ID, guild, posted: [], isTextBased: () => true };
    const { make } = fakeMessageStore(oldChannel);
    channelsById.set(oldChannel.id, oldChannel);
    const report = make({ embeds: [{ toJSON: () => ({ title: '📩 بلاغ #9' }) }] }, { author: { id: BOT_ID, bot: true } });

    const calls = fakeGitHub({ closed: [closedIssue(9, { guildId: HOME_GUILD_ID, channelId: oldChannel.id, messageId: report.id, labels: ['بلاغ'] })] });
    mock.timers.enable({ apis: ['setTimeout'] });
    await checkClosedReports(client);
    assert.equal(report.embeds[0].title, '✅ بلاغ #9 — اتحلت');
    const [mention] = report.replies;
    assert.equal(mention.deleted, false);
    mock.timers.tick(5_000);
    await Promise.resolve();
    assert.equal(mention.deleted, true, 'deleted after 5 seconds in the old channel');
    assert.equal(calls.labels.length, 1);
  });

  test('a marker written by a member, or pointing at another room or server, never moves the notice', async () => {
    const { client, room, channelsById, guild } = await setup();
    const other = { id: snowflake(), name: 'chat', guild, posted: [], isTextBased: () => true };
    const { make } = fakeMessageStore(other);
    channelsById.set(other.id, other);
    const victim = make({ embeds: [{ toJSON: () => ({ title: 'hello' }) }] }, { author: { id: BOT_ID, bot: true } });
    // The member's text carries a fake marker first; the bot's real marker is last. The fake one must be ignored.
    const spoofed = closedIssue(60, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: '799999999999999999' });
    spoofed.body = `<!-- discord:${HOME_GUILD_ID}/${other.id}/${victim.id}/${STAFF_ID} -->\n${spoofed.body}`;
    // A marker that points at a channel that is not a report room is dropped.
    const stray = closedIssue(61, { guildId: HOME_GUILD_ID, channelId: other.id, messageId: victim.id });
    fakeGitHub({ closed: [spoofed, stray] });
    await checkClosedReports(client);
    assert.equal(victim.edits.length, 0, 'the victim message was not edited');
    assert.equal(victim.replies.length, 0, 'nothing was said under it');
    assert.equal(other.posted.filter((message) => message.author.id === BOT_ID && message.content).length, 0);
  });

  test('a deleted report message does not crash: the notice is posted in the room and the issue is labelled', async () => {
    const { client, room } = await setup();
    const gone = closedIssue(50, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: '799999999999999999' });
    gone.title = `[bugs #7] user${STAFF_ID}: مشكلة`;
    const calls = fakeGitHub({ closed: [gone] });
    await checkClosedReports(client);
    const notice = room.posted.find((message) => message.content?.includes('البلاغ #'));
    assert.ok(notice, 'the close notice is still posted in #bugs-reports');
    assert.equal(notice.content, `<@${STAFF_ID}> ✅ البلاغ #7 اتحل`, 'the number comes from the issue title');
    assert.deepEqual(calls.labels[0].body, { labels: ['اتحلت'] });
  });

  test('a reply to a closed report is just chat: nothing opened or reopened', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('مشكلة قديمة');
    await handleBugsReportsMessage(original, client);
    const [report] = reportsIn(room);
    mock.restoreAll();
    const calls = fakeGitHub();
    const reply = post('لسه بتحصل؟', { reference: { messageId: report.id }, repliedUser: { id: BOT_ID } });
    assert.equal(await handleBugsReportsMessage(reply, client), true);
    assert.equal(calls.issues.length, 0);
    assert.equal(reply.replies.length, 0);
  });

  test('resetBugReportCounter resets the counter to 0 so next report starts at #1', async () => {
    const { client } = await setup();
    await updateGuildConfig(client, HOME_GUILD_ID, { [COUNTER_KEY]: 42 });
    assert.equal(await nextBugReportNumber(client, HOME_GUILD_ID), 43);

    const success = await resetBugReportCounter(client, HOME_GUILD_ID);
    assert.equal(success, true);
    assert.equal(await nextBugReportNumber(client, HOME_GUILD_ID), 1);
  });

  test('resetbugscounter command is owner-only and resets the counter', async () => {
    const { default: resetCmd } = await import('../src/commands/Utility/resetbugscounter.js');
    const { SERVER_OWNER_IDS } = await import('../src/config/serverOwners.js');
    const { client } = await setup();
    await updateGuildConfig(client, HOME_GUILD_ID, { [COUNTER_KEY]: 10 });

    // Non-owner is refused
    const nonOwnerReplies = [];
    const nonOwnerInteraction = {
      id: snowflake(),
      user: { id: '999999999999999999' },
      guildId: HOME_GUILD_ID,
      createdTimestamp: Date.now(),
      reply: async (p) => nonOwnerReplies.push(p),
      deferred: false,
      replied: false,
    };
    await resetCmd.execute(nonOwnerInteraction, {}, client);
    assert.match(nonOwnerReplies[0].content, /الأمر ده للأونر بس/);

    // Owner succeeds
    const ownerReplies = [];
    const ownerInteraction = {
      id: snowflake(),
      user: { id: SERVER_OWNER_IDS[0] },
      guildId: HOME_GUILD_ID,
      createdTimestamp: Date.now(),
      reply: async (p) => ownerReplies.push(p),
      deferred: false,
      replied: false,
    };
    await resetCmd.execute(ownerInteraction, {}, client);
    assert.match(ownerReplies[0].content, /تم تصفير عداد البلاغات/);
    assert.equal(await nextBugReportNumber(client, HOME_GUILD_ID), 1);
  });
});
