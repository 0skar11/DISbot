import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { updateGuildConfig } from '../src/services/config/guildConfig.js';
import { BUGS_REPORTS_CHANNEL_NAME, buildBugsReportsGuide } from '../src/services/bugsReportsRoom.js';
import { handleBugsReportsMessage, resetBugsReportsRateLimit, RATE_LIMIT } from '../src/services/bugsReportsInbox.js';
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
      replies: [], edits: [], deleted: false,
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

async function setup(guildId = HOME_GUILD_ID) {
  const store = new Map();
  const db = { get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback), set: async (key, value) => { store.set(key, structuredClone(value)); return true; } };
  const channelsById = new Map();
  const client = { user: { id: BOT_ID }, db, channels: { fetch: async (id) => channelsById.get(id) || null } };
  const guild = { id: guildId, name: 'Test Server', client };
  const room = { id: snowflake(), name: BUGS_REPORTS_CHANNEL_NAME, guild, posted: [], isTextBased: () => true, toString() { return `<#${this.id}>`; } };
  room.send = async (payload) => store$.make(payload, { author: { id: BOT_ID, bot: true } });
  const store$ = fakeMessageStore(room);
  channelsById.set(room.id, room);
  await updateGuildConfig(client, guildId, { bugsReportsChannelId: room.id });

  const post = (content, { authorId = STAFF_ID, bot = false, attachments = [], reference, repliedUser, system = false } = {}) => {
    const author = { id: authorId, bot, tag: `user${authorId}`, displayAvatarURL: () => '', toString: () => `<@${authorId}>` };
    const message = store$.make({ content }, { author, reference });
    message.system = system;
    message.attachments = new Map(attachments.map((url, index) => [String(index), { url, name: `file${index}.png` }]));
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

  test('a staff message becomes 🐞 بلاغ #N — مفتوح and an issue labelled بلاغ + bugs-reports with the server name', async () => {
    const calls = fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('أمر التايم مش شغال في روم الشات', { attachments: ['https://cdn.example/shot.png'] });
    assert.equal(await handleBugsReportsMessage(original, client), true);

    assert.equal(original.deleted, false, 'the original stays');
    assert.equal(calls.issues.length, 1);
    const [issue] = calls.issues;
    assert.deepEqual(issue.labels, ['بلاغ', 'bugs-reports']);
    assert.match(issue.body, /\*\*السيرفر:\*\* Test Server/u);
    assert.match(issue.body, /https:\/\/cdn\.example\/shot\.png/u);
    const [report] = original.replies;
    assert.match(issue.body, new RegExp(`<!-- discord:${HOME_GUILD_ID}/${room.id}/${report.id}/${STAFF_ID} -->`, 'u'));

    const embed = report.embeds[0];
    assert.equal(embed.title, '🐞 بلاغ #42 — مفتوح');
    assert.match(embed.description, /أمر التايم مش شغال/u);
    assert.match(embed.description, new RegExp(`<@${STAFF_ID}>`, 'u'));
    assert.match(embed.description, /<t:\d+:F>/u);
    assert.match(embed.description, /shot\.png/u);
  });

  test('works in Zenith too', async () => {
    const calls = fakeGitHub();
    const { client, post } = await setup(ZENITH_GUILD_ID);
    assert.equal(await handleBugsReportsMessage(post('البوت مش بيرد'), client), true);
    assert.equal(calls.issues.length, 1);
  });

  test('without GITHUB_TOKEN the embed is still posted with #؟', async () => {
    delete process.env.GITHUB_TOKEN;
    const { client, post } = await setup();
    const original = post('مشكلة في اللوج');
    await handleBugsReportsMessage(original, client);
    assert.equal(original.replies[0].embeds[0].title, '🐞 بلاغ #؟ — مفتوح');
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

  test('completed: the bugs-room embed turns green with the date and a permanent reply pings the reporter', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('مشكلة في الأمر');
    await handleBugsReportsMessage(original, client);
    const [report] = original.replies;
    mock.restoreAll();

    const calls = fakeGitHub({ closed: [closedIssue(42, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: report.id })] });
    mock.timers.enable({ apis: ['setTimeout'] });
    await checkClosedReports(client);
    mock.timers.tick(60_000);

    const embed = report.embeds[0];
    assert.equal(embed.title, '✅ بلاغ #42 — اتقفل (اتحل)');
    assert.equal(embed.color, 0x2ecc71);
    assert.match(embed.footer.text, /اتحل في 2026-11-15/u);
    assert.match(embed.description, /مشكلة في الأمر/u, 'the report text is kept');
    const [notice] = report.replies;
    assert.equal(notice.content, `<@${STAFF_ID}> ✅ البلاغ #42 اتقفل واتحل، متتحلش تاني.`);
    assert.equal(notice.deleted, false, 'never deleted in #bugs-reports');
    assert.deepEqual(calls.labels, [{ path: '/issues/42/labels', body: { labels: ['اتحلت'] } }]);
    assert.ok(calls.gets[0].options.params.since, 'the since window is used');
    assert.equal(calls.gets[0].options.params.labels, 'بلاغ');
  });

  test('not planned: grey 🔒 بلاغ #N — اتقفل, also permanent', async () => {
    fakeGitHub();
    const { client, room, post } = await setup();
    const original = post('حاجة مش مهمة');
    await handleBugsReportsMessage(original, client);
    const [report] = original.replies;
    mock.restoreAll();
    const calls = fakeGitHub({ closed: [closedIssue(42, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: report.id, reason: 'not_planned' })] });
    await checkClosedReports(client);
    assert.equal(report.embeds[0].title, '🔒 بلاغ #42 — اتقفل');
    assert.equal(report.embeds[0].color, 0x95a5a6);
    assert.equal(report.replies.length, 1);
    assert.equal(report.replies[0].deleted, false);
    assert.deepEqual(calls.labels[0].body, { labels: ['اتقفلت'] });
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
    const oldChannel = { id: snowflake(), guild, posted: [], isTextBased: () => true };
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

  test('a deleted report message does not crash: the notice is posted in the room and the issue is labelled', async () => {
    const { client, room } = await setup();
    const calls = fakeGitHub({ closed: [closedIssue(50, { guildId: HOME_GUILD_ID, channelId: room.id, messageId: '799999999999999999' })] });
    await checkClosedReports(client);
    const notice = room.posted.find((message) => /#50/u.test(message.content));
    assert.ok(notice, 'the close notice is still posted in #bugs-reports');
    assert.deepEqual(calls.labels[0].body, { labels: ['اتحلت'] });
  });

  test('a reply to a closed report is just chat: nothing opened or reopened', async () => {
    fakeGitHub();
    const { client, post } = await setup();
    const original = post('مشكلة قديمة');
    await handleBugsReportsMessage(original, client);
    const [report] = original.replies;
    mock.restoreAll();
    const calls = fakeGitHub();
    const reply = post('لسه بتحصل؟', { reference: { messageId: report.id }, repliedUser: { id: BOT_ID } });
    assert.equal(await handleBugsReportsMessage(reply, client), true);
    assert.equal(calls.issues.length, 0);
    assert.equal(reply.replies.length, 0);
  });
});
