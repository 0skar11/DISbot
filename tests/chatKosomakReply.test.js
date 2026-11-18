import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatFilter } from '../src/services/moderation/chatFilterService.js';

const REPLY = (id) => `<@${id}> كسمين امك خد تايم يبن الشرموطه 🖕`;
const AUTHOR = '200000000000000001';
const OTHER = '200000000000000002';

function fixture(content, { mentions = [], repliedTo = null, moderatable = true, authorId = AUTHOR } = {}) {
  const calls = [];
  const notice = { deleted: false, delete: async () => { notice.deleted = true; } };
  const member = { id: authorId, moderatable, timeout: async (ms, reason) => calls.push(['timeout', ms, reason]) };
  const users = new Map(mentions.map((user) => [user.id, user]));
  const message = {
    content,
    guild: { id: 'g', ownerId: '1', client: { db: { get: async (_key, fallback) => fallback, set: async () => true } }, members: { me: { id: 'bot' }, fetch: async () => member }, channels: { cache: new Map(), fetch: async () => null } },
    member,
    author: { id: authorId, bot: false },
    client: { user: { id: 'bot' } },
    mentions: { users },
    channel: { send: async (payload) => { calls.push(['notice', payload.content, payload.allowedMentions]); return notice; } },
    delete: async () => calls.push(['delete']),
  };
  if (repliedTo) {
    message.reference = { messageId: '300000000000000001' };
    message.fetchReference = async () => ({ author: repliedTo });
  }
  return { message, calls, notice };
}

const human = (id) => ({ id, bot: false });
const warn = async () => ({ totalCount: 1, timeoutApplied: false });
const run = (f) => handleChatFilter(f.message, { warn });
const kinds = (calls) => calls.map((call) => call[0]);

describe('كسمك aimed at a member (owner rule 2026-11-18)', () => {
  afterEach(() => mock.timers.reset());

  test('a mention of another member: deleted, one-hour timeout, the owner line, gone after 5 seconds', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(`كسمك يا <@${OTHER}>`, { mentions: [human(OTHER)] });
    assert.equal(await run(f), true);
    assert.deepEqual(kinds(f.calls).filter((kind) => kind !== 'notice'), ['delete', 'timeout']);
    assert.equal(f.calls.find((call) => call[0] === 'timeout')[1], 60 * 60_000);
    const sent = f.calls.find((call) => call[0] === 'notice');
    assert.equal(sent[1], REPLY(AUTHOR));
    assert.deepEqual(sent[2], { users: [AUTHOR] });
    mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(f.notice.deleted, false, 'still there before 5 seconds');
    mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(f.notice.deleted, true, 'deleted after 5 seconds');
  });

  test('a reply to another member\'s message counts, and كسمكو / كس امك / ksomak too', async () => {
    for (const text of ['كسمكو', 'كسمك', 'ك س م ك', 'كس امك', 'ksomak', 'kosomak']) {
      const f = fixture(text, { repliedTo: human(OTHER) });
      assert.equal(await run(f), true, text);
      assert.ok(f.calls.some((call) => call[0] === 'timeout'), `${text}: timeout`);
      assert.equal(f.calls.find((call) => call[0] === 'notice')[1], REPLY(AUTHOR), text);
    }
  });

  test('said to nobody (no mention, no reply): the old quiet behaviour, no timeout and no line', async () => {
    const f = fixture('كسمك');
    assert.equal(await run(f), true);
    assert.deepEqual(kinds(f.calls), ['delete']);
  });

  test('a mention of a bot, of the swearer himself, or a reply to a bot or to himself is not "aimed at a member"', async () => {
    const cases = [
      fixture('كسمك', { mentions: [{ id: 'b1', bot: true }], authorId: '200000000000000011' }),
      fixture('كسمك', { mentions: [human('200000000000000012')], authorId: '200000000000000012' }),
      fixture('كسمك', { repliedTo: { id: 'b2', bot: true }, authorId: '200000000000000013' }),
      fixture('كسمك', { repliedTo: human('200000000000000014'), authorId: '200000000000000014' }),
    ];
    for (const f of cases) {
      assert.equal(await run(f), true);
      assert.deepEqual(kinds(f.calls), ['delete']);
    }
  });

  test('a member the bot cannot time out gets only the old quiet deletion (no false "take a timeout")', async () => {
    const f = fixture(`كسمك <@${OTHER}>`, { mentions: [human(OTHER)], moderatable: false });
    assert.equal(await run(f), true);
    assert.deepEqual(kinds(f.calls), ['delete']);
  });

  test('other insults aimed at a member keep their own rules (no timeout line)', async () => {
    const f = fixture(`يا شرموط <@${OTHER}>`, { mentions: [human(OTHER)] });
    assert.equal(await run(f), true);
    assert.ok(!f.calls.some((call) => call[0] === 'timeout'));
    assert.ok(!f.calls.some((call) => call[0] === 'notice' && call[1] === REPLY(AUTHOR)));
  });
});
