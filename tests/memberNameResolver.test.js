import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMemberByName, normalizeName, isNameWord, nameWordsOf, remainingText, memberNames, isCertainMatch, MIN_PREFIX_LENGTH,
} from '../src/utils/memberNameResolver.js';

let seq = 0;
const nextId = () => String(300000000000000000n + BigInt(++seq));

/** A guild member like discord.js: username, global display name, server nickname. */
function member({ username, globalName = null, nickname = null, bot = false, id = nextId() }) {
  return {
    id,
    nickname,
    displayName: nickname || globalName || username,
    user: { id, username, globalName, bot, tag: username },
  };
}

function guildOf(cached = [], { memberCount, search } = {}) {
  const cache = new Map(cached.map((m) => [m.id, m]));
  const searches = [];
  return {
    id: 'g',
    memberCount,
    searches,
    members: {
      cache,
      search: search && (async (options) => { searches.push(options); return search(options); }),
    },
  };
}

describe('normalizeName', () => {
  test('case, tashkeel, tatweel, alef / ya / ta marbuta, spaces and a leading @', () => {
    assert.equal(normalizeName('AhMeD'), 'ahmed');
    assert.equal(normalizeName('مُحَمَّد'), 'محمد');
    assert.equal(normalizeName('مـحـمـد'), 'محمد');
    assert.equal(normalizeName('أحمد'), normalizeName('احمد'));
    assert.equal(normalizeName('إسلام'), normalizeName('اسلام'));
    assert.equal(normalizeName('آدم'), normalizeName('ادم'));
    assert.equal(normalizeName('مصطفى'), normalizeName('مصطفي'));
    assert.equal(normalizeName('فاطمة'), normalizeName('فاطمه'));
    assert.equal(normalizeName('  محمد    علي  '), 'محمد علي');
    assert.equal(normalizeName('@Sara'), 'sara');
    assert.equal(normalizeName('𝐒𝐚𝐫𝐚'), 'sara', 'fancy letters (NFKC)');
    assert.equal(normalizeName(`sa${String.fromCodePoint(0x200B)}ra${String.fromCodePoint(0x202E)}`), 'sara', 'invisible marks');
  });
});

describe('words that are never a name', () => {
  test('durations, numbers, mentions and IDs', () => {
    for (const word of ['10m', '2h', '1d', '30s', '1w', '5د', '٥', '7', '-3', '2.5', '123456789012345678', '<@123456789012345678>', '<@!123456789012345678>', '<@&123456789012345678>', '<#123456789012345678>', '@', '']) {
      assert.equal(isNameWord(word), false, word);
    }
    for (const word of ['محمد', 'ahmed', 'x10', 'm10', '@sara']) assert.equal(isNameWord(word), true, word);
  });

  test('the name stops at the first word that is not one; the tail keeps its words', () => {
    assert.deepEqual(nameWordsOf('احمد 10m سبام'), ['احمد']);
    assert.deepEqual(nameWordsOf('10m احمد'), []);
    assert.deepEqual(nameWordsOf('محمد علي سبام كتير'), ['محمد', 'علي', 'سبام'], 'at most three words');
    assert.deepEqual(nameWordsOf('محمد Helpers', { minTailWords: 1 }), ['محمد'], 'a role must stay');
    assert.deepEqual(nameWordsOf('محمد', { minTailWords: 1 }), []);
    assert.deepEqual(nameWordsOf('محمد علي', { wholeText: true }), ['محمد', 'علي']);
    assert.deepEqual(nameWordsOf('محمد 5', { wholeText: true }), []);
    assert.equal(remainingText('@محمد علي سبام', 2), 'سبام');
    assert.equal(remainingText('محمد', 1), '');
  });

  test('a member whose name is a duration or a number is never found by it', async () => {
    const guild = guildOf([member({ username: '10m' }), member({ username: '12345' })]);
    assert.equal((await resolveMemberByName(guild, '10m')).reason, 'no_name');
    assert.equal((await resolveMemberByName(guild, '12345 سبام')).reason, 'no_name');
  });
});

describe('resolveMemberByName', () => {
  const mohamed = member({ username: 'mo_99', globalName: 'Mohamed', nickname: 'محمد' });
  const ahmed = member({ username: 'ahmed.k', globalName: 'أحمد' });
  const sara = member({ username: 'sara' });

  test('an exact match on the username, the global name or the nickname', async () => {
    const guild = guildOf([mohamed, ahmed, sara]);
    for (const text of ['mo_99', 'mohamed', 'MOHAMED', 'محمد', 'مُحَمَّد', '@محمد']) {
      const found = await resolveMemberByName(guild, text);
      assert.equal(found.status, 'one', text);
      assert.equal(found.member, mohamed, text);
      assert.equal(found.usedWords, 1, text);
      assert.equal(found.bot, false);
    }
    assert.equal((await resolveMemberByName(guild, 'احمد')).member, ahmed, 'alef forms are one letter');
    assert.equal((await resolveMemberByName(guild, 'Sara')).member, sara);
  });

  test('with a tail: the first word, then two, then three; the used words are counted', async () => {
    const ali = member({ username: 'x1', nickname: 'محمد علي' });
    const guild = guildOf([ali, sara]);
    const found = await resolveMemberByName(guild, 'محمد علي سبام كتير');
    assert.equal(found.member, ali);
    assert.equal(found.usedWords, 2);
    assert.equal(remainingText('محمد علي سبام كتير', found.usedWords), 'سبام كتير');
    const withDuration = await resolveMemberByName(guild, 'sara 10m spam');
    assert.deepEqual([withDuration.member, withDuration.usedWords], [sara, 1]);
  });

  test('a unique prefix of at least 3 characters; shorter, shared or disallowed prefixes find nobody', async () => {
    const guild = guildOf([mohamed, ahmed, sara]);
    assert.equal(MIN_PREFIX_LENGTH, 3);
    assert.equal((await resolveMemberByName(guild, 'محم')).member, mohamed);
    assert.equal((await resolveMemberByName(guild, 'sar spam')).member, sara);
    assert.equal((await resolveMemberByName(guild, 'sa')).status, 'none', 'two letters are not enough');
    assert.equal((await resolveMemberByName(guild, 'محم', { allowPrefix: false })).status, 'none', 'exact only');
    const shared = guildOf([member({ username: 'samir' }), member({ username: 'samy' })]);
    const many = await resolveMemberByName(shared, 'sam');
    assert.equal(many.status, 'many');
    assert.equal(many.candidates.length, 2);
  });

  test('an exact name wins over a longer name it starts', async () => {
    const mohamedeen = member({ username: 'محمدين' });
    const guild = guildOf([mohamed, mohamedeen]);
    assert.equal((await resolveMemberByName(guild, 'محمد')).member, mohamed);
  });

  test('two members with the same name, or names matched by different word counts, are many', async () => {
    const twin = member({ username: 'other', nickname: 'محمد' });
    const many = await resolveMemberByName(guildOf([mohamed, twin]), 'محمد سبام');
    assert.equal(many.status, 'many');
    assert.deepEqual(many.candidates.map((c) => c.member.id).sort(), [mohamed.id, twin.id].sort());
    const ali = member({ username: 'x2', nickname: 'محمد علي' });
    const byLength = await resolveMemberByName(guildOf([mohamed, ali]), 'محمد علي');
    assert.equal(byLength.status, 'many', '`محمد` + reason `علي`, or `محمد علي`: not guessed');
    assert.deepEqual(byLength.candidates.map((c) => [c.member.id, c.usedWords]).sort(), [[mohamed.id, 1], [ali.id, 2]].sort());
  });

  test('bots are found and flagged', async () => {
    const bot = member({ username: 'Aether', bot: true });
    const found = await resolveMemberByName(guildOf([bot, sara]), 'aether');
    assert.equal(found.status, 'one');
    assert.equal(found.bot, true);
  });

  test('nobody: not_found for name words, no_name when the text has none', async () => {
    const guild = guildOf([mohamed]);
    assert.deepEqual(await resolveMemberByName(guild, 'فلان'), { status: 'none', reason: 'not_found' });
    assert.deepEqual(await resolveMemberByName(guild, '10m سبام'), { status: 'none', reason: 'no_name' });
    assert.deepEqual(await resolveMemberByName(guild, ''), { status: 'none', reason: 'no_name' });
    assert.deepEqual(await resolveMemberByName({}, 'محمد'), { status: 'none', reason: 'not_found' }, 'no member manager at all');
  });

  test('the cache first; Discord is searched (first word, limit 10) only when the cache has nobody', async () => {
    const far = member({ username: 'karim' });
    const guild = guildOf([sara], { search: () => new Map([[far.id, far]]) });
    const found = await resolveMemberByName(guild, 'karim سبام');
    assert.equal(found.member, far);
    assert.deepEqual(guild.searches, [{ query: 'karim', limit: 10 }]);
    const cached = guildOf([sara], { search: () => assert.fail('searched although the full cache answered') });
    assert.equal((await resolveMemberByName(cached, 'sara')).member, sara);
  });

  test('an incomplete cache is completed by the search, so a second member with the name is not missed', async () => {
    const twin = member({ username: 'sara.2', nickname: 'Sara' });
    const guild = guildOf([sara], { memberCount: 500, search: () => new Map([[twin.id, twin], [sara.id, sara]]) });
    const found = await resolveMemberByName(guild, 'sara');
    assert.equal(found.status, 'many');
    assert.equal(guild.searches.length, 1);
  });

  test('incomplete cache + a slow, failing or missing search: fail-closed (lookup_failed), even if the cache knows one', async () => {
    const lookupFailed = { status: 'none', reason: 'lookup_failed' };
    const slow = guildOf([sara], { memberCount: 500, search: () => new Promise(() => {}) });
    const started = Date.now();
    assert.deepEqual(await resolveMemberByName(slow, 'sara', { timeoutMs: 30 }), lookupFailed);
    assert.ok(Date.now() - started < 1_000, 'the timeout is short');
    const failing = guildOf([sara], { memberCount: 500, search: () => { throw new Error('500'); } });
    assert.deepEqual(await resolveMemberByName(failing, 'sara'), lookupFailed);
    const rejecting = guildOf([], { memberCount: 500, search: () => Promise.reject(new Error('429')) });
    assert.deepEqual(await resolveMemberByName(rejecting, 'karim'), lookupFailed);
    const noSearch = guildOf([sara], { memberCount: 500 });
    assert.deepEqual(await resolveMemberByName(noSearch, 'sara'), lookupFailed);
    // A complete cache needs no search: a failing one changes nothing.
    const complete = guildOf([sara], { memberCount: 1, search: () => { throw new Error('500'); } });
    assert.equal((await resolveMemberByName(complete, 'sara')).member, sara);
    const completeNobody = guildOf([sara], { memberCount: 1, search: () => { throw new Error('500'); } });
    assert.equal((await resolveMemberByName(completeNobody, 'karim')).reason, 'not_found');
  });

  test('the result says how it matched: exact or prefix, and whether the search was cut; only exact + whole is certain', async () => {
    const guild = guildOf([mohamed, sara]);
    const exact = await resolveMemberByName(guild, 'sara');
    assert.deepEqual([exact.exact, exact.truncated, isCertainMatch(exact)], [true, false, true]);
    const prefix = await resolveMemberByName(guild, 'sar');
    assert.deepEqual([prefix.status, prefix.exact, isCertainMatch(prefix)], ['one', false, false]);
    assert.equal(isCertainMatch({ status: 'many', exact: true, truncated: false }), false);
    assert.equal(isCertainMatch({ status: 'none', reason: 'not_found' }), false);
  });

  test('a search cut at its limit (10): a unique prefix match becomes many, an exact one is flagged truncated', async () => {
    const karim = member({ username: 'karim' });
    const others = Array.from({ length: 9 }, (_, i) => member({ username: `kar.${i}x` }));
    const full = new Map([karim, ...others].map((m) => [m.id, m]));
    const guild = guildOf([], { memberCount: 5_000, search: () => full });
    const byPrefix = await resolveMemberByName(guild, 'kari');
    assert.equal(byPrefix.status, 'many', 'more members may start like this beyond the 10 returned');
    assert.equal(byPrefix.truncated, true);
    assert.deepEqual(byPrefix.candidates.map((c) => c.member), [karim]);
    const byName = await resolveMemberByName(guild, 'karim');
    assert.deepEqual([byName.status, byName.member, byName.exact, byName.truncated, isCertainMatch(byName)], ['one', karim, true, true, false]);
    // Fewer than 10 results: not cut, a unique prefix stays one.
    const small = guildOf([], { memberCount: 5_000, search: () => new Map([[karim.id, karim]]) });
    const whole = await resolveMemberByName(small, 'kari');
    assert.deepEqual([whole.status, whole.truncated], ['one', false]);
  });

  test('memberNames lists every name once, normalised', () => {
    assert.deepEqual(memberNames(mohamed).sort(), ['mo_99', 'mohamed', 'محمد'].sort());
  });
});
