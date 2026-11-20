import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatFilter, handbackWord, NEW_MEMBER_MS } from '../src/services/moderation/chatFilterService.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

const OWNER = SERVER_OWNER_IDS[0];
const OWNER2 = SERVER_OWNER_IDS[1];
const OTHER = '200000000000000102';
const NOW = 1_800_000_000_000;
const OLD = NOW - 30 * 24 * 60 * 60_000;
const HANDBACK = (id, word) => `<@${id}> متشتمش الاونر يا ${word}`;

let nextAuthor = 200000000000000500n;
const freshAuthor = () => String(nextAuthor++);

function fixture(content, { mentions = [], repliedTo = null, joinedTimestamp = OLD, authorId = freshAuthor(), bot = false } = {}) {
  const calls = [];
  const notice = { deleted: false, delete: async () => { notice.deleted = true; } };
  const member = { id: authorId, moderatable: true, joinedTimestamp, timeout: async (ms, reason) => calls.push(['timeout', ms, reason]) };
  const users = new Map(mentions.map((user) => [user.id, user]));
  const message = {
    content,
    guild: { id: 'g', ownerId: '1', client: { db: { get: async (_key, fallback) => fallback, set: async () => true } }, members: { me: { id: 'bot' }, fetch: async () => member }, channels: { cache: new Map(), fetch: async () => null } },
    member,
    author: { id: authorId, bot },
    client: { user: { id: 'bot' } },
    mentions: { users },
    channel: { send: async (payload) => { calls.push(['notice', payload.content, payload.allowedMentions]); return notice; } },
    delete: async () => calls.push(['delete']),
  };
  if (repliedTo) {
    message.reference = { messageId: '300000000000000001' };
    message.fetchReference = async () => ({ author: repliedTo });
  }
  return { message, calls, notice, authorId };
}

const human = (id) => ({ id, bot: false });
const warns = [];
const warn = async ({ reason }) => { warns.push(reason); return { totalCount: 1, timeoutApplied: false }; };
const run = (f) => handleChatFilter(f.message, { warn, now: NOW });
const notices = (calls) => calls.filter((call) => call[0] === 'notice').map((call) => call[1]);

describe('insult handed back (owner rule 2026-11-20)', () => {
  afterEach(() => mock.timers.reset());

  test('a mention of an owner with an insult: deleted, warned as before, the insult handed back', async () => {
    const cases = [
      [`يا عرص <@${OWNER}>`, 'عرص'],
      [`<@${OWNER}> يا شرموط`, 'شرموط'],
      [`<@${OWNER2}> يا ابن الكلب`, 'ابن الكلب'],
      [`<@${OWNER}> بنت الكلب`, 'بنت الكلب'],
      [`<@${OWNER}> ya 3ars`, '3ars'],
      [`<@${OWNER}> ي ا ع ر ص`, 'عرص'],
    ];
    for (const [text, word] of cases) {
      const f = fixture(text, { mentions: [human(OWNER), human(OWNER2)].filter((u) => text.includes(u.id)) });
      assert.equal(await run(f), true, text);
      assert.equal(f.calls[0][0], 'delete', text);
      assert.deepEqual(notices(f.calls), [HANDBACK(f.authorId, word)], text);
      assert.deepEqual(f.calls.find((call) => call[0] === 'notice')[2], { users: [f.authorId] });
    }
  });

  test('a family insult at an owner is handed back too (the كسمك timeout keeps its own line)', async () => {
    const f = fixture(`<@${OWNER}> كس اختك`, { mentions: [human(OWNER)] });
    assert.equal(await run(f), true);
    assert.deepEqual(notices(f.calls), [HANDBACK(f.authorId, 'كس اختك')]);

    const k = fixture(`<@${OWNER}> كسمك`, { mentions: [human(OWNER)] });
    assert.equal(await run(k), true);
    assert.ok(k.calls.some((call) => call[0] === 'timeout'));
    assert.deepEqual(notices(k.calls), [`<@${k.authorId}> كسمين امك خد تايم يبن الشرموطه 🖕`]);
  });

  test('a reply to an owner\'s message counts as aimed at the owner', async () => {
    const f = fixture('يا عرص', { repliedTo: human(OWNER) });
    assert.equal(await run(f), true);
    assert.deepEqual(notices(f.calls), [HANDBACK(f.authorId, 'عرص')]);
  });

  test('a mention of an owner without an insult: nothing happens', async () => {
    const f = fixture(`<@${OWNER}> ازيك يا باشا عامل ايه`, { mentions: [human(OWNER)] });
    assert.equal(await run(f), false);
    assert.deepEqual(f.calls, []);
  });

  test('a mention of a normal member (old member): the old notice line', async () => {
    const f = fixture(`يا عرص <@${OTHER}>`, { mentions: [human(OTHER)] });
    assert.equal(await run(f), true);
    const sent = notices(f.calls);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith(`🚫 <@${f.authorId}> شتيمة ممنوعة هنا`), sent[0]);
  });

  test('a member who joined less than 5 hours ago: any forbidden insult is handed back, no mention needed', async () => {
    const f = fixture('يا شرموط', { joinedTimestamp: NOW - NEW_MEMBER_MS + 60_000 });
    assert.equal(await run(f), true);
    assert.deepEqual(notices(f.calls), [HANDBACK(f.authorId, 'شرموط')]);

    const fam = fixture('كس اختك', { joinedTimestamp: NOW - 60_000 });
    assert.equal(await run(fam), true);
    assert.deepEqual(notices(fam.calls), [HANDBACK(fam.authorId, 'كس اختك')]);

    const clean = fixture('السلام عليكم يا جماعة', { joinedTimestamp: NOW - 60_000 });
    assert.equal(await run(clean), false);
    assert.deepEqual(clean.calls, []);
  });

  test('a member of 5 hours or more, or with an unknown join time: the old behaviour', async () => {
    for (const joinedTimestamp of [NOW - NEW_MEMBER_MS, OLD, null, undefined]) {
      const f = fixture('يا شرموط', { joinedTimestamp });
      assert.equal(await run(f), true);
      const sent = notices(f.calls);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].startsWith('🚫'), String(joinedTimestamp));
    }
    // A quiet family insult from an old member stays quiet.
    const quiet = fixture('كس اختك');
    assert.equal(await run(quiet), true);
    assert.deepEqual(notices(quiet.calls), []);
  });

  test('the reply deletes itself after 5 seconds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(`يا عرص <@${OWNER}>`, { mentions: [human(OWNER)] });
    assert.equal(await run(f), true);
    mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(f.notice.deleted, false);
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(f.notice.deleted, true);
  });

  test('bots are ignored', async () => {
    const f = fixture(`يا عرص <@${OWNER}>`, { mentions: [human(OWNER)], bot: true });
    assert.equal(await run(f), false);
    assert.deepEqual(f.calls, []);
  });

  test('the echoed word is escaped, has no mentions, no leading "يا" and at most 30 characters', () => {
    assert.equal(handbackWord('يا عرص'), 'عرص');
    assert.equal(handbackWord('ya ebn el kalb'), 'ebn el kalb');
    assert.equal(handbackWord('f*ck_you'), 'f\\*ck\\_you');
    assert.equal(handbackWord('`x` ~~y~~ |z|'), '\\`x\\` \\~\\~y\\~\\~ \\|z\\|');
    assert.equal(handbackWord(`<@${OTHER}> @everyone عرص @here`), 'عرص');
    assert.ok(!handbackWord(`a <@&123> b`).includes('<@'));
    assert.equal(handbackWord('ش'.repeat(50)).length, 30);
    assert.equal(handbackWord('يا'), '');
    assert.equal(handbackWord(null), '');
  });
});
