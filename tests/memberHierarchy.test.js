import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import {
  assertCanActOn, HIERARCHY_REFUSAL, hierarchyRuleApplies, lookupMember, LOOKUP_FAILED_MESSAGE,
} from '../src/services/moderation/memberHierarchy.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { clearInvokers, recentInvoker } from '../src/services/moderation/commandInvoker.js';
import { executePrefixCommand } from '../src/utils/messageAdapter.js';
import { handleArabicRoleShortcut, handleClearWarningsShortcut, pullToVoice } from '../src/utils/arabicModerationShortcuts.js';
import { handleArabicUtilityShortcuts } from '../src/utils/arabicUtilityShortcuts.js';
import { handleMessageDeleteShortcut } from '../src/utils/messageDeleteShortcut.js';
import { isWrittenAsCommand } from '../src/events/messageCreate.js';
import banCommand from '../src/commands/Moderation/ban.js';
import kickCommand from '../src/commands/Moderation/kick.js';
import timeoutCommand from '../src/commands/Moderation/timeout.js';
import untimeoutCommand from '../src/commands/Moderation/untimeout.js';
import warnCommand from '../src/commands/Moderation/warn.js';
import masskickCommand from '../src/commands/Moderation/masskick.js';
import massbanCommand from '../src/commands/Moderation/massban.js';

const GUILD_OWNER = '900000000000000001';
const SERVER_OWNER = SERVER_OWNER_IDS[0];
const STAFF = '200000000000000001';
const TARGET = '200000000000000002';
const OTHER_GUILD = '100000000000000099';
const ALL = PermissionsBitField.All;

/** A server with a staff member (position `staffPos`) and a target member (position `targetPos`). */
function setup({ guildId = HOME_GUILD_ID, staffPos = 5, targetPos = 3, staffPerms = ALL, staffId = STAFF, targetId = TARGET } = {}) {
  const sent = [];
  const roleCache = new Map();
  const client = {
    user: { id: 'bot', bot: true },
    users: { cache: new Map(), fetch: async (id) => ({ id, tag: `user${id.slice(-2)}` }) },
    db: { get: async (_key, fallback) => fallback, set: async () => true },
  };
  const guild = { id: guildId, name: 'Server', ownerId: GUILD_OWNER, client, roles: { cache: roleCache, everyone: { id: guildId } } };
  const member = (id, position, perms = 0n) => {
    const m = {
      id,
      guild,
      user: { id, tag: `user${id.slice(-2)}`, bot: false, send: async () => {} },
      roles: { highest: { position }, cache: new Map(), remove: async () => {} },
      permissions: new PermissionsBitField(perms),
      kickable: true,
      moderatable: true,
      bannable: true,
      manageable: true,
      voice: {},
      isCommunicationDisabled: () => true,
      kick: async () => { sent.push({ kicked: id }); },
      timeout: async () => { sent.push({ timedOut: id }); },
      setNickname: async (nick) => { sent.push({ nick, id }); },
    };
    m.roles.add = async (role) => { m.added = role; };
    return m;
  };
  const staff = member(staffId, staffPos, staffPerms);
  const target = member(targetId, targetPos);
  const members = new Map([[staff.id, staff], [target.id, target]]);
  guild.members = {
    cache: members,
    me: { id: 'bot', roles: { highest: { position: 100 } }, user: client.user },
    fetches: [],
    // Like discord.js: someone who isn't in the server is Discord's Unknown Member (10007).
    fetch: async (id) => {
      const key = typeof id === 'object' ? id.user : id;
      guild.members.fetches.push(key);
      if (members.has(key)) return members.get(key);
      throw discordError(10007, 'Unknown Member', 404);
    },
    ban: async (id) => { sent.push({ banned: id }); },
  };
  const channel = { id: '700000000000000001', send: async (payload) => { sent.push(payload); return { delete: async () => {} }; } };
  const message = (content, extra = {}) => ({
    id: '800000000000000001', content, guild, channel, client, member: staff, author: staff.user, createdTimestamp: Date.now(), reference: null, ...extra,
  });
  const interaction = (options = {}) => ({
    id: '800000000000000002', guild, guildId: guild.id, member: staff, user: staff.user, channel, client, createdTimestamp: Date.now(),
    deferred: false, replied: false, deferCalls: 0,
    options: {
      getUser: () => (options.target ?? target).user || options.target,
      getMember: () => (options.target === undefined ? target : options.target),
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    deferReply: async function () { this.deferCalls += 1; this.deferred = true; },
    reply: async (payload) => sent.push(payload),
    editReply: async (payload) => sent.push(payload),
    followUp: async (payload) => sent.push(payload),
    isRepliable: () => true,
  });
  return { guild, client, staff, target, members, sent, message, interaction, member };
}

const refused = (error) => error?.userMessage === HIERARCHY_REFUSAL;

/** A discord.js-like API error (`code` is Discord's JSON error code). */
function discordError(code, message, status = 500) {
  return Object.assign(new Error(message), { name: 'DiscordAPIError', code, status });
}

/** Takes the target out of the member cache; Discord still knows them (or answers `fetchError`). */
function uncache(s, fetchError = null) {
  s.members.delete(TARGET);
  const fetchFromDiscord = s.guild.members.fetch;
  s.guild.members.fetch = async (id) => {
    if (fetchError && (typeof id === 'object' ? id.user : id) === TARGET) {
      s.guild.members.fetches.push(TARGET);
      throw fetchError;
    }
    if ((typeof id === 'object' ? id.user : id) === TARGET) {
      s.guild.members.fetches.push(TARGET);
      return s.target;
    }
    return fetchFromDiscord(id);
  };
}

describe('role hierarchy for admin commands (owner\'s request)', () => {
  beforeEach(() => clearInvokers());

  test('the executor\'s highest role must be strictly above the target\'s', async () => {
    for (const [staffPos, targetPos, ok] of [[5, 3, true], [5, 5, false], [3, 5, false]]) {
      const { guild, staff, target } = setup({ staffPos, targetPos });
      const check = await assertCanActOn(guild, staff, target);
      assert.equal(check.ok, ok, `${staffPos} vs ${targetPos}`);
      if (!ok) assert.equal(check.message, HIERARCHY_REFUSAL);
    }
  });

  test('owners act on anyone; nobody acts on an owner or on themselves', async () => {
    const { guild, target, member } = setup({ targetPos: 50 });
    assert.equal((await assertCanActOn(guild, member(GUILD_OWNER, 1), target)).ok, true, 'guild owner');
    assert.equal((await assertCanActOn(guild, member(SERVER_OWNER, 1), target)).ok, true, 'server owner');
    const high = member('200000000000000003', 99);
    assert.equal((await assertCanActOn(guild, high, member(GUILD_OWNER, 1))).reason, 'owner');
    assert.equal((await assertCanActOn(guild, high, SERVER_OWNER)).reason, 'owner');
    assert.equal((await assertCanActOn(guild, member(GUILD_OWNER, 1), SERVER_OWNER)).reason, 'owner');
    assert.equal((await assertCanActOn(guild, high, high)).reason, 'self');
    assert.equal((await assertCanActOn(guild, high, high, { allowSelf: true })).ok, true);
  });

  test('a target outside the server (Discord: Unknown Member, 10007) is allowed unless it is an owner', async () => {
    const { guild, staff } = setup();
    assert.equal((await assertCanActOn(guild, staff, '300000000000000001')).ok, true);
    assert.deepEqual(guild.members.fetches, ['300000000000000001'], 'Discord was asked');
    assert.equal((await assertCanActOn(guild, staff, { id: GUILD_OWNER })).ok, false);
  });

  test('a cached member of the same or a higher role is refused, by member, user or ID', async () => {
    const s = setup({ staffPos: 3, targetPos: 5 });
    for (const target of [s.target, s.target.user, TARGET]) {
      const check = await assertCanActOn(s.guild, s.staff, target);
      assert.equal(check.reason, 'hierarchy');
      assert.equal(check.message, HIERARCHY_REFUSAL);
    }
    assert.equal(s.guild.members.fetches.length, 0, 'the cache answered');
  });

  test('a member missing from the cache is fetched from Discord and refused', async () => {
    const s = setup({ staffPos: 3, targetPos: 5 });
    uncache(s);
    const check = await assertCanActOn(s.guild, s.staff, TARGET);
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'hierarchy');
    assert.deepEqual(s.guild.members.fetches, [TARGET]);
    // Below the staff member, the fetched member is allowed.
    const below = setup({ staffPos: 5, targetPos: 3 });
    uncache(below);
    assert.equal((await assertCanActOn(below.guild, below.staff, TARGET)).ok, true);
  });

  test('a member Discord answers Unknown Member (10007) for is allowed, unless an owner', async () => {
    const s = setup({ staffPos: 3, targetPos: 5 });
    uncache(s, discordError(10007, 'Unknown Member', 404));
    assert.equal((await assertCanActOn(s.guild, s.staff, TARGET)).ok, true);
    assert.equal((await assertCanActOn(s.guild, s.staff, GUILD_OWNER)).reason, 'owner');
  });

  test('any other lookup failure (500, 429, timeout, Unknown User) is refused: fail-closed', async () => {
    const failures = [
      discordError(0, 'Internal Server Error', 500),
      Object.assign(new Error('You are being rate limited.'), { name: 'RateLimitError', status: 429 }),
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError', code: 20 }),
      discordError(10013, 'Unknown User', 404),
    ];
    for (const failure of failures) {
      const s = setup({ staffPos: 9, targetPos: 1 });
      uncache(s, failure);
      const check = await assertCanActOn(s.guild, s.staff, TARGET);
      assert.equal(check.ok, false, failure.message);
      assert.equal(check.reason, 'hierarchy', failure.message);
      assert.equal(check.lookupFailed, true, failure.message);
      assert.equal(check.message, HIERARCHY_REFUSAL);
      // The owners stay exempt as executors.
      assert.equal((await assertCanActOn(s.guild, s.member(GUILD_OWNER, 1), TARGET)).ok, true, failure.message);
    }
    // A fetch that resolves with nothing, or no way to fetch at all, is no answer either.
    const empty = setup({ staffPos: 9, targetPos: 1 });
    empty.members.delete(TARGET);
    empty.guild.members.fetch = async () => null;
    assert.equal((await assertCanActOn(empty.guild, empty.staff, TARGET)).reason, 'hierarchy');
    delete empty.guild.members.fetch;
    assert.equal((await assertCanActOn(empty.guild, empty.staff, TARGET)).reason, 'hierarchy');
  });

  test('a target whose ID can not be determined is refused', async () => {
    const { guild, staff } = setup();
    for (const target of [null, undefined, '', {}, { user: {} }]) {
      const check = await assertCanActOn(guild, staff, target);
      assert.equal(check.ok, false, JSON.stringify(target));
      assert.equal(check.message, HIERARCHY_REFUSAL);
    }
  });

  test('lookupMember: only 10007 is "not in the server"; a lookup for another ID is not reused', async () => {
    const s = setup({ staffPos: 3, targetPos: 5 });
    uncache(s, discordError(0, 'Bad Gateway', 502));
    const failed = await lookupMember(s.guild, TARGET);
    assert.equal(failed.member, null);
    assert.equal(failed.absent, false);
    assert.equal(failed.error.status, 502);
    const absent = await lookupMember(s.guild, '300000000000000001');
    assert.deepEqual({ absent: absent.absent, member: absent.member }, { absent: true, member: null });
    // An Unknown Member answer about someone else does not clear this target.
    assert.equal((await assertCanActOn(s.guild, s.staff, TARGET, { lookup: absent })).ok, false);
    assert.equal((await assertCanActOn(s.guild, s.staff, '300000000000000001', { lookup: absent })).ok, true);
  });

  test('our server and Zenith only; the bot acting on its own is not checked', async () => {
    assert.equal(hierarchyRuleApplies({ id: HOME_GUILD_ID }), true);
    assert.equal(hierarchyRuleApplies({ id: ZENITH_GUILD_ID }), true);
    const other = setup({ guildId: OTHER_GUILD, staffPos: 1, targetPos: 9 });
    assert.equal((await assertCanActOn(other.guild, other.staff, other.target)).ok, true);
    const home = setup({ targetPos: 9 });
    assert.equal((await assertCanActOn(home.guild, home.guild.members.me, home.target)).ok, true);
  });

  test('an administrator below the target is refused in our server, still allowed elsewhere (old rule)', async () => {
    const home = setup({ staffPos: 3, targetPos: 5 });
    assert.equal((await ModerationService.validateHierarchy(home.staff, home.target, 'ban')).error, HIERARCHY_REFUSAL);
    const other = setup({ guildId: OTHER_GUILD, staffPos: 3, targetPos: 5 });
    assert.equal((await ModerationService.validateHierarchy(other.staff, other.target, 'ban')).valid, true);
  });

  test('banUser: a member Discord could not look up is refused before any DM or ban', async () => {
    const s = setup({ staffPos: 9, targetPos: 1 });
    let dms = 0;
    s.target.user.send = async () => { dms += 1; };
    uncache(s, discordError(0, 'Internal Server Error', 500));
    await assert.rejects(ModerationService.banUser({ guild: s.guild, user: s.target.user, moderator: s.staff }), refused);
    assert.equal(s.sent.length + dms, 0, 'nothing was done');
    assert.equal(recentInvoker(s.guild.id, 'ban', TARGET), null, 'no invoker left behind');
    // Other servers have no role rule, but a member who couldn't be looked up isn't banned blind either.
    const other = setup({ guildId: OTHER_GUILD, staffPos: 9, targetPos: 1 });
    uncache(other, discordError(0, 'Internal Server Error', 500));
    await assert.rejects(
      ModerationService.banUser({ guild: other.guild, user: other.target.user, moderator: other.staff }),
      (error) => error?.userMessage === LOOKUP_FAILED_MESSAGE,
    );
    assert.equal(other.sent.length, 0);
  });

  test('banUser: an uncached member is fetched and refused; one not in the server is banned by ID', async () => {
    const s = setup({ staffPos: 3, targetPos: 5 });
    uncache(s);
    await assert.rejects(ModerationService.banUser({ guild: s.guild, user: s.target.user, moderator: s.staff }), refused);
    assert.equal(s.sent.length, 0);

    const away = setup({ staffPos: 3, targetPos: 5 });
    uncache(away, discordError(10007, 'Unknown Member', 404));
    // Stops right after the ban (the case log needs the database).
    away.guild.members.ban = async (id) => { away.sent.push({ banned: id }); throw new Error('stop here'); };
    await ModerationService.banUser({ guild: away.guild, user: away.target.user, moderator: away.staff }).catch(() => {});
    assert.deepEqual(away.sent, [{ banned: TARGET }]);
    assert.equal(recentInvoker(away.guild.id, 'ban', TARGET), null, 'a ban that threw forgets its invoker');
  });

  test('massban: a member Discord could not look up is listed as skipped with the refusal, not banned', async () => {
    const s = setup({ staffPos: 9, targetPos: 1 });
    s.client.db.get = async (key, fallback) => (key.includes(':config') ? { antiNukeTrustedUsers: [STAFF] } : fallback);
    uncache(s, discordError(0, 'Service Unavailable', 503));
    const interaction = s.interaction({ users: `<@${TARGET}>` });
    await massbanCommand.execute(interaction, null, s.client);
    assert.equal(s.sent.some((entry) => entry.banned), false, 'nobody was banned');
    const description = s.sent.at(-1).embeds[0].data.description;
    assert.match(description, /Skipped \(1\)/u);
    // The embed drops emoji: the refusal's text without its 🚫.
    assert.ok(description.includes(HIERARCHY_REFUSAL.replace(/^🚫\s*/u, '')), description);
    assert.doesNotMatch(description, /Successfully Banned/u);
  });

  test('ModerationService refuses before acting: ban, ban by owner ID, kick, timeout, untimeout, unban of an owner', async () => {
    const s = setup({ staffPos: 3, targetPos: 3 });
    await assert.rejects(ModerationService.banUser({ guild: s.guild, user: s.target.user, moderator: s.staff }), refused);
    await assert.rejects(ModerationService.banUser({ guild: s.guild, user: { id: SERVER_OWNER, tag: 'owner' }, moderator: s.staff }), refused);
    await assert.rejects(ModerationService.kickUser({ guild: s.guild, member: s.target, moderator: s.staff }), refused);
    await assert.rejects(ModerationService.timeoutUser({ guild: s.guild, member: s.target, moderator: s.staff, durationMs: 60_000 }), refused);
    await assert.rejects(ModerationService.removeTimeoutUser({ guild: s.guild, member: s.target, moderator: s.staff }), refused);
    s.guild.bans = { fetch: async () => ({}) };
    await assert.rejects(ModerationService.unbanUser({ guild: s.guild, user: { id: GUILD_OWNER }, moderator: s.staff }), refused);
    assert.equal(s.sent.length, 0, 'nothing was done');
  });

  test('ModerationService remembers who ran the command right before it acts (for the logs)', async () => {
    const s = setup();
    let invokerAtKick = null;
    // Stops right after the kick (the case log needs the database).
    s.target.kick = async () => { invokerAtKick = recentInvoker(s.guild.id, 'kick', s.target.id); throw new Error('stop here'); };
    await ModerationService.kickUser({ guild: s.guild, member: s.target, moderator: s.staff, reason: 'x' }).catch(() => {});
    assert.equal(invokerAtKick?.id, STAFF);
    assert.equal(recentInvoker(s.guild.id, 'kick', s.target.id), null, 'the kick threw: its invoker is forgotten');
  });

  test('lifting a timeout is remembered as `untimeout`, setting one as `timeout`', async () => {
    const s = setup();
    const seen = [];
    s.target.timeout = async (ms) => {
      seen.push([ms === null ? 'lift' : 'set', recentInvoker(s.guild.id, 'timeout', TARGET)?.id || null, recentInvoker(s.guild.id, 'untimeout', TARGET)?.id || null]);
      throw new Error('stop here');
    };
    await ModerationService.timeoutUser({ guild: s.guild, member: s.target, moderator: s.staff, durationMs: 60_000 }).catch(() => {});
    await ModerationService.removeTimeoutUser({ guild: s.guild, member: s.target, moderator: s.staff }).catch(() => {});
    assert.deepEqual(seen, [['set', STAFF, null], ['lift', null, STAFF]]);
  });

  test('slash ban, kick, timeout, untimeout and warn refuse a member of the same or a higher role', async () => {
    for (const command of [banCommand, kickCommand, timeoutCommand, untimeoutCommand, warnCommand]) {
      const s = setup({ staffPos: 4, targetPos: 4 });
      const interaction = s.interaction();
      await assert.rejects(command.execute(interaction, null, s.client), refused, command.data.name);
      assert.equal(interaction.deferCalls, 0, `${command.data.name}: refused before the reply is deferred (ephemeral)`);
      assert.equal(s.sent.length, 0, `${command.data.name}: nothing done`);
    }
  });

  test('masskick skips a member of the same or a higher role with the refusal', async () => {
    const s = setup({ staffPos: 4, targetPos: 6 });
    const interaction = s.interaction({ users: `<@${TARGET}>` });
    await masskickCommand.execute(interaction, null, s.client);
    assert.equal(s.sent.some((entry) => entry.kicked), false);
    const embed = s.sent.at(-1).embeds[0];
    assert.match(embed.data.description, /مينفعش تنفذ الأمر ده/u);
  });

  test('typed warn: the refusal is shown (and deletes itself), even though typed permission errors are silent', async () => {
    const s = setup({ staffPos: 2, targetPos: 2 });
    await executePrefixCommand(warnCommand, s.message(`وارن <@${TARGET}>`), [`<@${TARGET}>`], s.client);
    assert.equal(s.sent.at(-1).content, HIERARCHY_REFUSAL);
    assert.ok(HIERARCHY_REFUSAL.startsWith('🚫'), 'a 🚫 reply is deleted after a few seconds (noPermissionReply.js)');
  });

  test('typed timeout / ban / kick without the permission: no answer at all', async () => {
    for (const command of [timeoutCommand, banCommand, kickCommand]) {
      const s = setup({ staffPerms: 0n });
      await executePrefixCommand(command, s.message(`x <@${TARGET}>`), [`<@${TARGET}>`], s.client);
      assert.equal(s.sent.length, 0, command.data.name);
    }
  });
});

describe('typed Arabic shortcuts', () => {
  beforeEach(() => clearInvokers());

  function withRole(s, { id = '400000000000000001', name = 'Helpers', position = 1 } = {}) {
    const role = { id, name, position, managed: false, toString: () => `<@&${id}>`, permissions: new PermissionsBitField(0n) };
    s.guild.roles.cache.set(role.id, role);
    return role;
  }

  test('ر / ب refuse a member of the same or a higher role; below them the role is given and the invoker remembered', async () => {
    const refusedCase = setup({ staffPos: 3, targetPos: 3 });
    withRole(refusedCase);
    assert.equal(await handleArabicRoleShortcut(refusedCase.message(`ر <@${TARGET}> Helpers`)), true);
    assert.equal(refusedCase.sent.at(-1).content, HIERARCHY_REFUSAL);
    assert.equal(refusedCase.target.added, undefined);

    const ok = setup({ staffPos: 5, targetPos: 3 });
    const role = withRole(ok);
    assert.equal(await handleArabicRoleShortcut(ok.message(`ر <@${TARGET}> Helpers`)), true);
    assert.equal(ok.target.added, role);
    assert.equal(recentInvoker(ok.guild.id, 'roles', TARGET)?.id, STAFF);
  });

  test('role by ID or role mention: `ر @member <roleId>`, `ر <memberId> <roleId>`, `ب @member <@&roleId>`', async () => {
    for (const content of [`ر <@${TARGET}> 400000000000000007`, `ر ${TARGET} 400000000000000007`, `ب <@${TARGET}> <@&400000000000000007>`]) {
      const s = setup();
      const role = withRole(s, { id: '400000000000000007', name: 'Some Role' });
      let removed = null;
      s.target.roles.remove = async (r) => { removed = r; };
      assert.equal(await handleArabicRoleShortcut(s.message(content)), true, content);
      assert.equal(content.startsWith('ب') ? removed : s.target.added, role, content);
    }
  });

  test('ordinary chat is left alone and members without Manage Roles get no answer', async () => {
    const s = setup();
    withRole(s);
    for (const content of ['ب', 'شيل ده', 'ان شاء الله', 'رتبة حلوة']) {
      assert.equal(await handleArabicRoleShortcut(s.message(content)), false, content);
    }
    // A reply that names no role is chat too.
    const replyChat = s.message('شيل ده', { reference: { messageId: '1' }, fetchReference: async () => ({ author: s.target.user }) });
    assert.equal(await handleArabicRoleShortcut(replyChat), false);
    const noPerm = setup({ staffPerms: 0n });
    withRole(noPerm);
    assert.equal(await handleArabicRoleShortcut(noPerm.message(`ر <@${TARGET}> Helpers`)), false);
    assert.equal(s.sent.length + noPerm.sent.length, 0);
    // A written member without a role is a command: the usage is shown.
    await handleArabicRoleShortcut(s.message(`ر <@${TARGET}>`));
    assert.match(s.sent.at(-1).content, /@user role/u);
  });

  test('سحب, مسح تحذيرات and نك refuse a member of the same or a higher role', async () => {
    const pull = setup({ staffPos: 3, targetPos: 3 });
    pull.staff.voice = { channel: { id: 'A', toString: () => '<#A>' } };
    pull.target.voice = { channel: { id: 'B' }, channelId: 'B', setChannel: async () => pull.sent.push({ moved: true }) };
    await pullToVoice(pull.message(`سحب <@${TARGET}>`), pull.target);
    assert.equal(pull.sent.at(-1).content, HIERARCHY_REFUSAL);

    const warnings = setup({ staffPos: 3, targetPos: 4 });
    await handleClearWarningsShortcut(warnings.message(`مسح تحذيرات <@${TARGET}>`), [`<@${TARGET}>`]);
    assert.equal(warnings.sent.at(-1).content, HIERARCHY_REFUSAL);

    const nick = setup({ staffPos: 3, targetPos: 3 });
    await handleArabicUtilityShortcuts(nick.message(`نك <@${TARGET}> new`));
    assert.equal(nick.sent.at(-1).content, HIERARCHY_REFUSAL);
    assert.equal(nick.sent.some((entry) => entry.nick), false);
    // Your own nickname is fine.
    await handleArabicUtilityShortcuts(nick.message('نك me'));
    assert.deepEqual(nick.sent.find((entry) => entry.nick), { nick: 'me', id: STAFF });
  });

  test('ق / ف / م / font only react to a real command; without the permission nothing is answered', async () => {
    const s = setup();
    assert.equal(await handleArabicUtilityShortcuts(s.message('ف البيت')), false);
    assert.equal(await handleArabicUtilityShortcuts(s.message('ق ده')), false);
    assert.equal(await handleArabicUtilityShortcuts(s.message('font')), false);
    assert.equal(await handleMessageDeleteShortcut(s.message('م')), false);
    assert.equal(await handleMessageDeleteShortcut(s.message('م كده')), false);
    const noPerm = setup({ staffPerms: 0n });
    assert.equal(await handleArabicUtilityShortcuts(noPerm.message('ق')), false);
    assert.equal(await handleArabicUtilityShortcuts(noPerm.message('نك x')), false);
    assert.equal(await handleMessageDeleteShortcut(noPerm.message('م 5')), false);
    assert.equal(s.sent.length + noPerm.sent.length, 0);
  });

  test('without the prefix a command word only runs when written as a command', () => {
    assert.equal(isWrittenAsCommand(timeoutCommand.data, [`<@${TARGET}>`, '5m']), true);
    assert.equal(isWrittenAsCommand(timeoutCommand.data, ['الغداء']), false);
    assert.equal(isWrittenAsCommand(banCommand.data, ['عليه', 'التعب']), false);
    assert.equal(isWrittenAsCommand(warnCommand.data, []), false);
    const lock = { options: [] };
    assert.equal(isWrittenAsCommand(lock, []), true);
    assert.equal(isWrittenAsCommand(lock, ['الباب']), false);
  });
});

describe('other servers keep their checks', () => {
  test('a lower staff member still pulls nobody higher, with the old answer', async () => {
    const s = setup({ guildId: OTHER_GUILD, staffPos: 3, targetPos: 3, staffPerms: PermissionFlagsBits.MoveMembers });
    s.staff.voice = { channel: { id: 'A' } };
    s.target.voice = { channel: { id: 'B' }, channelId: 'B', setChannel: async () => {} };
    await pullToVoice(s.message(`سحب <@${TARGET}>`), s.target);
    assert.match(s.sent.at(-1).content, /ماتقدرش تسحب/u);
  });
});
