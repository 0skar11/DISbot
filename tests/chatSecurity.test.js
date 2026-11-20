import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { checkText, handleChatFilter, INSULTS, IBN_AL_ALLOWED } from '../src/services/moderation/chatFilterService.js';
import { trackMessage, handleOwnerMentionSpam, handleSpam, FLOOD_MESSAGES, OWNER_PING_ID, SPAM_TIMEOUT_MS } from '../src/services/moderation/antiSpamService.js';
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

  test('10 messages in 5 seconds or the same message 5 times is spam', () => {
    const t = 1_000_000;
    for (let i = 0; i < FLOOD_MESSAGES - 1; i += 1) assert.equal(trackMessage(message(`m${i}`, { userId: 'a' }), t + i * 100), null);
    assert.equal(trackMessage(message('m10', { userId: 'a' }), t + (FLOOD_MESSAGES - 1) * 100).kind, 'flood');
    for (let i = 0; i < 4; i += 1) assert.equal(trackMessage(message('نفس الكلام', { userId: 'b' }), t + i * 1500), null);
    assert.equal(trackMessage(message('نفس الكلام', { userId: 'b' }), t + 6000).kind, 'duplicate');
    assert.equal(trackMessage(message('نفس الكلام', { userId: 'c' }), t), null);
  });

  test('spam times the member out for 5 minutes; staff are skipped', async () => {
    const calls = [];
    const member = { id: 'd', moderatable: true, timeout: async (ms) => calls.push(ms), permissions: new PermissionsBitField() };
    let last;
    for (let i = 0; i < FLOOD_MESSAGES; i += 1) {
      last = { ...message(`x${i}`, { userId: 'd' }), member };
      await handleSpam(last, { now: 2_000_000 + i * 100 });
    }
    assert.deepEqual(calls, [SPAM_TIMEOUT_MS]);
    const staff = { ...message('y', { userId: 'e' }), member: { permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageMessages) } };
    for (let i = 0; i < FLOOD_MESSAGES + 2; i += 1) assert.equal(await handleSpam(staff, { now: 3_000_000 + i }), false);
  });

  test('replies to the owner (ping on) are not counted as mentions', async () => {
    const reply = (now) => handleOwnerMentionSpam(message('تمام', { userId: 'h', mentions: [OWNER_PING_ID] }), { now });
    for (let i = 1; i <= 5; i += 1) assert.equal(await reply(i), false);
  });

  test('the 3rd owner mention in a row is deleted; a message without it starts over', async () => {
    const ping = (userId, now) => handleOwnerMentionSpam(message(`<@${OWNER_PING_ID}>`, { userId, mentions: [OWNER_PING_ID] }), { now });
    assert.equal(await ping('f', 1), false);
    assert.equal(await ping('f', 2), false);
    assert.equal(await ping('f', 3), true);
    assert.equal(await ping('g', 1), false);
    assert.equal(await ping('g', 2), false);
    assert.equal(await handleOwnerMentionSpam(message('هاي', { userId: 'g' }), { now: 3 }), false);
    assert.equal(await ping('g', 4), false);
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
    assert.equal(await handleOwnerMentionSpam(homeMessage(member.id, member), { now: 1 }), false);
    assert.equal(await handleOwnerMentionSpam(homeMessage(member.id, member), { now: 2 }), false);
    assert.equal(await handleOwnerMentionSpam(homeMessage(member.id, member), { now: 3 }), true);
  });

  test('another server: staff are still counted like before', async () => {
    const staffRole = { id: '400000000000000001', name: ROLE_DEFINITIONS[6].name };
    const member = plain('300000000000000074', [staffRole]);
    const ping = (now) => handleOwnerMentionSpam(homeMessage(member.id, member, { guildId: '100000000000000099' }), { now });
    assert.equal(await ping(1), false);
    assert.equal(await ping(2), false);
    assert.equal(await ping(3), true);
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
