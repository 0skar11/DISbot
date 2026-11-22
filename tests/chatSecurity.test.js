import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { checkText, handleChatFilter, INSULTS, IBN_AL_ALLOWED } from '../src/services/moderation/chatFilterService.js';
import {
  trackMessage, handleOwnerMentionSpam, handleSpam, countOwnerMentions, FLOOD_MESSAGES, DUPLICATE_MESSAGES, DUPLICATE_WINDOW_MS,
  OWNER_MENTION_LIMIT, OWNER_PING_ID, SPAM_TIMEOUT_MS,
} from '../src/services/moderation/antiSpamService.js';
import { runSecurityCleanup, untrust } from '../src/services/securityCleanupService.js';
import securityCleanupEvent from '../src/events/securityCleanup.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import { MAIN_INVITE_CODE } from '../src/config/security.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { ROLE_DEFINITIONS } from '../src/services/staffRoleHierarchyService.js';

describe('chat filter (reports #146, #147, #151)', () => {
  const cases = {
    family: ['كسمك', 'كس امك', 'كـسـمـك', 'ك س م ك', 'ك.س.م.ك', 'كسسسمك', 'يا كسمك', 'كس اختك', 'ksmk', 'kosomak', 'kos omak', 'k$mk', 'KOSOMK', 'كسومك', 'زانية', 'ميتين امك'],
    ibnAl: ['ابن الكلب', 'يا ابن الوسخه', 'يابن الجزمه', 'ebn el kalb', 'إبن الكلب', 'ابن الجزمة', 'ebn el gazma'],
    insult: ['يا شرموط', 'متناك', 'انت خول', 'يا عرص', 'معرص', 'طيزك', 'يا منيوك', 'ya khawal', 'sharmota', 'خوووول'],
  };
  for (const [rule, texts] of Object.entries(cases)) {
    test(`catches ${rule}`, () => {
      for (const text of texts) assert.equal(checkText(text), rule, text);
    });
  }

  test('leaves normal words alone', () => {
    for (const text of ['ابن الحلال', 'ابن عمي', 'ابن العم', 'ابن الناس', 'ابن البلد', 'ابن الكلية', 'ابن ال***', 'ميتين جنيه', 'خوله صاحبتي', 'دخول', 'بوكس مان', 'مكس مصر', 'كسبت', 'كسرت الكوباية', 'اكسسوار', 'نيكون', 'زبادي', 'زبون', 'زبيب', 'حفره في الشارع', 'kosmos', 'kiss me', 'كسول', 'مكسيكو', 'نيكول', 'احا', 'hello', 'تعالوا الحفره', 'الحفرة احسن', 'el7ofra']) {
      assert.equal(checkText(text), null, text);
    }
    assert.ok(INSULTS.length > 10 && IBN_AL_ALLOWED.includes('الحلال'));
  });

  function filterMessage(content, { authorId = '200000000000000001', me = null } = {}) {
    const calls = [];
    const member = { id: authorId, moderatable: true, timeout: async (ms) => calls.push(['timeout', ms]) };
    return {
      calls,
      message: {
        content,
        guild: { id: 'g', ownerId: '1', client: { db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: ['200000000000000077'] } : fallback), set: async () => true } }, members: { me, fetch: async () => member }, channels: { cache: new Map(), fetch: async () => null } },
        member,
        author: { id: authorId, bot: false },
        client: { user: { id: 'bot' } },
        channel: { send: async (payload) => { calls.push(['notice', payload.content]); return { delete: async () => {} }; } },
        delete: async () => calls.push(['delete']),
      },
    };
  }

  test('family insults: always deleted, never a timeout, one warning on the 3rd hit in 30 minutes', async () => {
    const me = { id: 'bot' };
    const warnings = [];
    const warn = async ({ member }) => { warnings.push(member.id); return { totalCount: warnings.length, timeoutApplied: false }; };
    const send = (content, now, authorId = '200000000000000011') => {
      const fixture = filterMessage(content, { authorId, me });
      return handleChatFilter(fixture.message, { now, warn }).then((handled) => ({ handled, ...fixture }));
    };
    const t = 10_000_000;
    for (const [i, text] of ['يا ك س م ك', 'زانية', 'ksomak'].entries()) {
      const { handled, calls } = await send(text, t + i * 60_000);
      assert.equal(handled, true, text);
      assert.deepEqual(calls[0], ['delete'], text);
      assert.ok(!calls.some(([kind]) => kind === 'timeout'), text);
      if (i < 2) assert.equal(calls.find(([kind]) => kind === 'notice'), undefined, 'quiet until the warning');
    }
    assert.deepEqual(warnings, ['200000000000000011'], 'one warning on the 3rd hit');
    // The counter starts again: two more hits give nothing, the third warns again.
    await send('كسمك', t + 4 * 60_000);
    await send('كسمك', t + 5 * 60_000);
    assert.equal(warnings.length, 1);
    await send('كسمك', t + 6 * 60_000);
    assert.equal(warnings.length, 2);

    // Hits more than 30 minutes apart never add up.
    for (let i = 0; i < 4; i += 1) await send('كسمك', t + i * 31 * 60_000, '200000000000000012');
    assert.equal(warnings.length, 2);
  });

  test('ibn al insults: deleted + a warning every time; ordinary ابن ال... is not touched; owners are skipped', async () => {
    const me = { id: 'bot' };
    let warned = 0;
    const warn = async () => ({ totalCount: ++warned, timeoutApplied: false });
    let { calls, message } = filterMessage('ابن الجزمة', { me });
    assert.equal(await handleChatFilter(message, { warn }), true);
    assert.deepEqual(calls[0], ['delete']);
    assert.ok(!calls.some(([kind]) => kind === 'timeout'));
    assert.equal(warned, 1);

    ({ calls, message } = filterMessage('ابن الناس', { me }));
    assert.equal(await handleChatFilter(message, { warn }), false);
    assert.equal(calls.length, 0);

    ({ calls, message } = filterMessage('الحفره'));
    assert.equal(await handleChatFilter(message), false);
    assert.equal(calls.length, 0);

    ({ calls, message } = filterMessage('كسمك', { authorId: '1159601661392715906' }));
    assert.equal(await handleChatFilter(message), false);
    assert.equal(calls.length, 0);

    // Trusted staff may swear.
    ({ calls, message } = filterMessage('كسمك', { authorId: '200000000000000077' }));
    assert.equal(await handleChatFilter(message), false);
    assert.equal(calls.length, 0);

    ({ calls, message } = filterMessage('فلان قالي كسمك'));
    message.channelId = '1552304815713943602'; // the report channel
    assert.equal(await handleChatFilter(message), false);
    assert.equal(calls.length, 0);
  });
});

describe('anti spam (#144) and owner mentions (#148)', () => {
  const message = (content, { userId = '300000000000000001', id = String(Math.random()), mentions = [] } = {}) => ({
    id, content, channelId: 'c', guild: { id: 'g2', channels: { cache: new Map() }, members: { me: null, fetch: async () => null } },
    author: { id: userId, bot: false }, member: null,
    mentions: { users: new Map(mentions.map((m) => [m, {}])) },
    client: { user: { id: 'bot' } },
    channel: { send: async () => ({ delete: async () => {} }), bulkDelete: async () => {}, messages: { delete: async () => {} } },
    delete: async () => {},
  });

  test('GH #323: 10 different messages in 5 seconds, or the same message 20 times in 10 seconds, is spam', () => {
    const t = 1_000_000;
    assert.equal(DUPLICATE_MESSAGES, 20);
    assert.equal(DUPLICATE_WINDOW_MS, 10_000);
    for (let i = 0; i < FLOOD_MESSAGES - 1; i += 1) assert.equal(trackMessage(message(`m${i}`, { userId: 'a' }), t + i * 100), null);
    assert.equal(trackMessage(message('m10', { userId: 'a' }), t + (FLOOD_MESSAGES - 1) * 100).kind, 'flood');
    // The same message, fast: 19 copies are not spam yet (the flood rule leaves copies to the duplicate rule).
    for (let i = 0; i < DUPLICATE_MESSAGES - 1; i += 1) assert.equal(trackMessage(message('نفس الكلام', { userId: 'b' }), t + i * 400), null, `copy ${i + 1}`);
    assert.equal(trackMessage(message('نفس الكلام', { userId: 'b' }), t + 9_500).kind, 'duplicate');
    // 20 copies spread over more than 10 seconds are not.
    for (let i = 0; i < DUPLICATE_MESSAGES + 5; i += 1) assert.equal(trackMessage(message('تاني', { userId: 'c' }), t + i * 600), null);
    // Pictures (no text) still count as a flood.
    for (let i = 0; i < FLOOD_MESSAGES - 1; i += 1) assert.equal(trackMessage(message('', { userId: 'p' }), t + i * 100), null);
    assert.equal(trackMessage(message('', { userId: 'p' }), t + 1_000).kind, 'flood');
  });

  const spamFixture = (userId, member, { guildId = 'g2', trustedUsers = [] } = {}) => {
    const deleted = [];
    const notices = [];
    return {
      deleted,
      notices,
      message: (content, at) => ({
        ...message(content, { userId, id: `${userId}-${at}` }),
        member,
        guild: {
          id: guildId, ownerId: '1', channels: { cache: new Map() },
          client: { db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: trustedUsers } : fallback), set: async () => true } },
          members: { me: { id: 'bot' }, fetch: async () => member },
        },
        channel: { id: 'c', send: async (payload) => { notices.push(payload.content); return { delete: async () => {} }; }, bulkDelete: async (ids) => { deleted.push(...ids); }, messages: { delete: async (id) => { deleted.push(id); } } },
      }),
    };
  };

  for (const guildId of [HOME_GUILD_ID, '1569932761471524874']) {
    test(`GH #323: the same message 20 times in 10 s is deleted and warned, never timed out (server ${guildId})`, async () => {
      assert.equal(SPAM_TIMEOUT_MS, 0);
      const timeouts = [];
      const warnings = [];
      const member = { id: '300000000000000031', moderatable: true, user: { bot: false }, timeout: async (ms, reason) => timeouts.push([ms, reason]), permissions: new PermissionsBitField() };
      const fixture = spamFixture(member.id, member, { guildId });
      const warn = async ({ member: warned, reason }) => { warnings.push([warned.id, reason]); return { totalCount: warnings.length, timeoutApplied: false }; };
      const results = [];
      for (let i = 0; i < DUPLICATE_MESSAGES; i += 1) results.push(await handleSpam(fixture.message('سبااام', 2_000_000 + i * 400), { now: 2_000_000 + i * 400, warn }));
      assert.deepEqual(results, [...Array(DUPLICATE_MESSAGES - 1).fill(false), true]);
      assert.equal(fixture.deleted.length, DUPLICATE_MESSAGES, 'every copy is deleted');
      assert.deepEqual(timeouts, [], 'no timeout');
      assert.deepEqual(warnings.map(([id]) => id), [member.id]);
      assert.match(fixture.notices[0], /وارن \(1\)/u);
      assert.ok(!/تايم/u.test(fixture.notices[0]));
    });
  }

  test('a flood of different messages gets the warning, no timeout', async () => {
    const timeouts = [];
    const member = { id: '300000000000000032', moderatable: true, user: { bot: false }, timeout: async (ms) => timeouts.push(ms), permissions: new PermissionsBitField() };
    const fixture = spamFixture(member.id, member);
    let warned = 0;
    const warn = async () => ({ totalCount: ++warned, timeoutApplied: false });
    for (let i = 0; i < FLOOD_MESSAGES; i += 1) await handleSpam(fixture.message(`x${i}`, 4_000_000 + i * 100), { now: 4_000_000 + i * 100, warn });
    assert.deepEqual(timeouts, []);
    assert.equal(warned, 1);
  });

  test('no timeout for staff, the trusted, or a member the bot cannot moderate (who is still warned)', async () => {
    const timeouts = [];
    let warned = 0;
    const warn = async () => ({ totalCount: ++warned, timeoutApplied: false });
    const flood = async (fixture, start) => {
      const results = [];
      for (let i = 0; i < FLOOD_MESSAGES + 2; i += 1) results.push(await handleSpam(fixture.message(`z${i}`, start + i), { now: start + i, warn }));
      return results;
    };

    const staff = { id: '300000000000000033', moderatable: true, timeout: async (ms) => timeouts.push(ms), permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageMessages) };
    assert.ok((await flood(spamFixture(staff.id, staff), 5_000_000)).every((handled) => handled === false));

    const trusted = { id: '300000000000000034', moderatable: true, timeout: async (ms) => timeouts.push(ms), permissions: new PermissionsBitField() };
    assert.ok((await flood(spamFixture(trusted.id, trusted, { trustedUsers: [trusted.id] }), 6_000_000)).every((handled) => handled === false));

    const owner = { id: SERVER_OWNER_IDS[1], moderatable: true, timeout: async (ms) => timeouts.push(ms), permissions: new PermissionsBitField() };
    assert.ok((await flood(spamFixture(owner.id, owner), 7_000_000)).every((handled) => handled === false));

    const above = { id: '300000000000000035', moderatable: false, timeout: async (ms) => timeouts.push(ms), permissions: new PermissionsBitField() };
    const fixture = spamFixture(above.id, above);
    assert.ok((await flood(fixture, 8_000_000)).includes(true));
    assert.equal(warned, 1, 'warned');
    assert.deepEqual(timeouts, [], 'never timed out');
    assert.ok(fixture.notices[0] && !/تايم/u.test(fixture.notices[0]));

    // A failing timeout (missing permission) is caught.
    const failing = { id: '300000000000000036', moderatable: true, timeout: async () => { throw new Error('Missing Permissions'); }, permissions: new PermissionsBitField() };
    assert.ok((await flood(spamFixture(failing.id, failing), 9_000_000)).includes(true));
  });

  test('replies to the owner (ping on) are not counted as mentions', async () => {
    const reply = (now) => handleOwnerMentionSpam(message('تمام', { userId: 'h', mentions: [OWNER_PING_ID] }), { now });
    for (let i = 1; i <= 8; i += 1) assert.equal(await reply(i), false);
  });

  test(`GH #323: ${OWNER_MENTION_LIMIT} owner mentions are allowed, the next one is deleted; a message without it starts over`, async () => {
    assert.equal(OWNER_MENTION_LIMIT, 5);
    const ping = (userId, now, times = 1) => handleOwnerMentionSpam(message(Array(times).fill(`<@${OWNER_PING_ID}>`).join(' '), { userId, mentions: [OWNER_PING_ID] }), { now });
    for (let i = 1; i <= OWNER_MENTION_LIMIT; i += 1) assert.equal(await ping('f', i), false, `mention ${i}`);
    assert.equal(await ping('f', 6), true);
    // The count starts again after the warning.
    assert.equal(await ping('f', 7), false);

    for (let i = 1; i <= 4; i += 1) assert.equal(await ping('g', i), false);
    assert.equal(await handleOwnerMentionSpam(message('هاي', { userId: 'g' }), { now: 5 }), false);
    assert.equal(await ping('g', 6), false);

    // Counted in one message too: 5 at once are fine, 6 at once are not, and 5 then 1 more is the 6th.
    assert.equal(await ping('k', 1, 5), false);
    assert.equal(await ping('k', 2), true);
    assert.equal(await ping('m', 1, 6), true);
    // Mentions more than OWNER_MENTION_WINDOW_MS apart do not add up.
    for (let i = 0; i < 8; i += 1) assert.equal(await ping('n', i * 30_000), false);
  });

  test('every owner counts: the other server owner and the server\'s own owner', () => {
    const withOwner = (content) => ({ ...message(content), guild: { id: 'g9', ownerId: '300000000000000099' } });
    assert.equal(countOwnerMentions(withOwner(`<@${SERVER_OWNER_IDS[1]}> <@!300000000000000099> <@${OWNER_PING_ID}> <@300000000000000001>`)), 3);
    assert.equal(countOwnerMentions(withOwner('بدون منشن')), 0);
  });
});

describe('staff may mention the owner in our server (report #196)', () => {
  const homeMessage = (userId, member, { guildId = HOME_GUILD_ID } = {}) => ({
    id: String(Math.random()), content: `<@${OWNER_PING_ID}>`, channelId: 'c',
    guild: {
      id: guildId, ownerId: '1', channels: { cache: new Map() },
      client: { db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: ['300000000000000077'] } : fallback), set: async () => true } },
      members: { me: null, fetch: async () => member },
    },
    author: { id: userId, bot: false }, member,
    mentions: { users: new Map([[OWNER_PING_ID, {}]]) },
    client: { user: { id: 'bot' } },
    channel: { send: async () => ({ delete: async () => {} }) },
    delete: async () => {},
  });
  const plain = (id, roles = []) => ({ id, permissions: new PermissionsBitField(0n), roles: { cache: new Map(roles.map((role) => [role.id, role])) } });

  test('staff roles, Manage Messages and the trusted list mention freely; members still get the warning', async () => {
    const staffRole = { id: '400000000000000001', name: ROLE_DEFINITIONS.find((definition) => definition.name.includes('Support')).name };
    const cases = [
      ['300000000000000071', plain('300000000000000071', [staffRole])],
      ['300000000000000072', { ...plain('300000000000000072'), permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageMessages) }],
      ['300000000000000077', plain('300000000000000077')],
    ];
    for (const [userId, member] of cases) {
      for (let i = 1; i <= 5; i += 1) assert.equal(await handleOwnerMentionSpam(homeMessage(userId, member), { now: i }), false, userId);
    }
    const member = plain('300000000000000073');
    for (let i = 1; i <= OWNER_MENTION_LIMIT; i += 1) assert.equal(await handleOwnerMentionSpam(homeMessage(member.id, member), { now: i }), false);
    assert.equal(await handleOwnerMentionSpam(homeMessage(member.id, member), { now: 6 }), true);
  });

  test('another server (all-servers rule): staff mention freely too, members still get the warning', async () => {
    const staffRole = { id: '400000000000000001', name: ROLE_DEFINITIONS[6].name };
    const staff = plain('300000000000000074', [staffRole]);
    const ping = (member, now) => handleOwnerMentionSpam(homeMessage(member.id, member, { guildId: '1569932761471524874' }), { now });
    for (let i = 1; i <= OWNER_MENTION_LIMIT + 3; i += 1) assert.equal(await ping(staff, i), false);
    const member = plain('300000000000000075');
    for (let i = 1; i <= OWNER_MENTION_LIMIT; i += 1) assert.equal(await ping(member, i), false);
    assert.equal(await ping(member, OWNER_MENTION_LIMIT + 1), true);
  });
});

describe('security cleanup (#145, #149, #150, #152)', () => {
  test('izatona is no longer an owner', () => {
    assert.deepEqual(SERVER_OWNER_IDS, ['1159601661392715906', '626263734704275487']);
  });

  test('invites are never deleted on startup or cleanup (owner request)', async () => {
    let deleteCalled = false;
    const invite = (code) => ({
      code,
      delete: async () => {
        deleteCalled = true;
        throw new Error('invite.delete must never be called');
      },
    });
    const guild = {
      id: 'g_invite_test',
      name: 'g',
      members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } },
      invites: { fetch: async () => new Map(['a1', MAIN_INVITE_CODE, 'b2'].map((code) => [code, invite(code)])) },
    };
    const store = new Map();
    const client = {
      guilds: { cache: new Map([[guild.id, guild]]) },
      db: { get: async (k, f) => (store.has(k) ? store.get(k) : f), set: async (k, v) => { store.set(k, v); return true; } },
    };
    const result = await runSecurityCleanup(client, guild);
    assert.equal(deleteCalled, false, 'runSecurityCleanup does not delete invites');
    assert.equal(result.skipped, false);
    assert.equal('invitesDeleted' in result, false);

    // Also verify the ready event execution does not delete invites
    store.clear();
    await securityCleanupEvent.execute(client);
    assert.equal(deleteCalled, false, 'securityCleanup event does not delete invites');
  });

  test('takes izatona and role 1547448260661084161 out of the trusted list', async () => {
    const store = new Map();
    const client = { db: { get: async (k, f) => (store.has(k) ? store.get(k) : f), set: async (k, v) => { store.set(k, v); return true; } } };
    const config = { antiNukeTrustedUsers: ['1308224908576428079', '1'], antiNukeTrustedRoles: ['1547448260661084161', '2'] };
    assert.deepEqual(await untrust(client, 'g3', config), { users: 1, roles: 1 });
  });
});
