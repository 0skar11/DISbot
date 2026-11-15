import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import { assertCanActOn, HIERARCHY_REFUSAL, hierarchyRuleApplies } from '../src/services/moderation/memberHierarchy.js';
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
    fetch: async (id) => members.get(typeof id === 'object' ? id.user : id) || null,
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

describe('role hierarchy for admin commands (owner\'s request)', () => {
  beforeEach(() => clearInvokers());

  test('the executor\'s highest role must be strictly above the target\'s', () => {
    for (const [staffPos, targetPos, ok] of [[5, 3, true], [5, 5, false], [3, 5, false]]) {
      const { guild, staff, target } = setup({ staffPos, targetPos });
      const check = assertCanActOn(guild, staff, target);
      assert.equal(check.ok, ok, `${staffPos} vs ${targetPos}`);
      if (!ok) assert.equal(check.message, HIERARCHY_REFUSAL);
    }
  });

  test('owners act on anyone; nobody acts on an owner or on themselves', () => {
    const { guild, target, member } = setup({ targetPos: 50 });
    assert.equal(assertCanActOn(guild, member(GUILD_OWNER, 1), target).ok, true, 'guild owner');
    assert.equal(assertCanActOn(guild, member(SERVER_OWNER, 1), target).ok, true, 'server owner');
    const high = member('200000000000000003', 99);
    assert.equal(assertCanActOn(guild, high, member(GUILD_OWNER, 1)).reason, 'owner');
    assert.equal(assertCanActOn(guild, high, SERVER_OWNER).reason, 'owner');
    assert.equal(assertCanActOn(guild, member(GUILD_OWNER, 1), SERVER_OWNER).reason, 'owner');
    assert.equal(assertCanActOn(guild, high, high).reason, 'self');
    assert.equal(assertCanActOn(guild, high, high, { allowSelf: true }).ok, true);
  });

  test('a target outside the server (ban by ID) is allowed unless it is an owner', () => {
    const { guild, staff } = setup();
    assert.equal(assertCanActOn(guild, staff, '300000000000000001').ok, true);
    assert.equal(assertCanActOn(guild, staff, { id: GUILD_OWNER }).ok, false);
  });

  test('our server and Zenith only; the bot acting on its own is not checked', () => {
    assert.equal(hierarchyRuleApplies({ id: HOME_GUILD_ID }), true);
    assert.equal(hierarchyRuleApplies({ id: ZENITH_GUILD_ID }), true);
    const other = setup({ guildId: OTHER_GUILD, staffPos: 1, targetPos: 9 });
    assert.equal(assertCanActOn(other.guild, other.staff, other.target).ok, true);
    const home = setup({ targetPos: 9 });
    assert.equal(assertCanActOn(home.guild, home.guild.members.me, home.target).ok, true);
  });

  test('an administrator below the target is refused in our server, still allowed elsewhere (old rule)', () => {
    const home = setup({ staffPos: 3, targetPos: 5 });
    assert.equal(ModerationService.validateHierarchy(home.staff, home.target, 'ban').error, HIERARCHY_REFUSAL);
    const other = setup({ guildId: OTHER_GUILD, staffPos: 3, targetPos: 5 });
    assert.equal(ModerationService.validateHierarchy(other.staff, other.target, 'ban').valid, true);
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
