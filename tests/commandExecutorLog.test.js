import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import {
  rememberInvoker, recentInvoker, takeInvoker, forgetInvoker, withInvoker, clearInvokers, invokerCount, executorText,
  AUTOMATED_EXECUTOR, UNKNOWN_EXECUTOR, INVOKER_TTL_MS, MAX_INVOKERS,
} from '../src/services/moderation/commandInvoker.js';
import { handleArabicRoleShortcut } from '../src/utils/arabicModerationShortcuts.js';
import { AUDIT_LOG_SETTINGS, clearAuditRoomCache } from '../src/services/logging/auditRooms.js';
import { ROLE_LOG_SETTINGS, logMemberRoles } from '../src/services/logging/roleLogs.js';
import { buildModerationLogData } from '../src/utils/moderation.js';
import { MODERATION_ACTION_LOG_CHANNEL_ID } from '../src/services/moderation/moderationActionLogService.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import guildBanAdd from '../src/events/guildBanAdd.js';
import guildBanRemove from '../src/events/guildBanRemove.js';
import guildMemberRemove from '../src/events/guildMemberRemove.js';
import guildMemberUpdate from '../src/events/guildMemberUpdate.js';
import channelUpdate from '../src/events/channelUpdate.js';
import messageBulkDelete from '../src/events/messageBulkDelete.js';
import voiceLog from '../src/events/dedicatedVoiceAuditLog.js';
import banCommand from '../src/commands/Moderation/ban.js';
import timeoutCommand from '../src/commands/Moderation/timeout.js';

const BOT = { id: '999999999999999999', tag: 'Aether', username: 'Aether', bot: true };
const STAFF = { id: '200000000000000001', tag: 'staff', username: 'staff', bot: false };
const TARGET = { id: '200000000000000002', tag: 'target', username: 'target', bot: false, displayAvatarURL: () => null };
const CHANNEL_ID = '500000000000000001';
const ROOMS = ['ban', 'timeout', 'roles', 'channels', 'message', 'voice'];
const MODERATOR = { id: '200000000000000005', tag: 'moderator', username: 'moderator', bot: false };
const ADMIN = { id: '200000000000000009', tag: 'admin', username: 'admin', bot: false };
const STAFF_TEXT = /<@200000000000000001> \(staff - 200000000000000001\)/u;
const MODERATOR_TEXT = /<@200000000000000005> \(moderator - 200000000000000005\)/u;
const STAFF_LINE = /🧑‍💻 \*\*اللي نفّذ الأمر:\*\* <@200000000000000001> \(staff - 200000000000000001\)/u;
const MODERATOR_LINE = /🧑‍💻 \*\*اللي نفّذ الأمر:\*\* <@200000000000000005> \(moderator - 200000000000000005\)/u;
const AUTOMATED_LINE = /🧑‍💻 \*\*اللي نفّذ الأمر:\*\* 🤖 تلقائي \(حماية البوت\)/u;

/** A server with every audit room; the audit log says `executor` did everything. */
function setup({ executor = BOT } = {}) {
  const posted = Object.fromEntries(ROOMS.map((key) => [key, []]));
  const room = (key) => ({
    id: `room_${key}`, type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { posted[key].push(payload); return { id: `sent_${key}` }; },
  });
  const auditChannels = Object.fromEntries(ROOMS.map((key) => [key, `room_${key}`]));
  const client = { user: BOT, db: { get: async (key, fallback) => (key.includes(':config') ? { auditChannels } : fallback), set: async () => true } };
  const guild = {
    id: HOME_GUILD_ID, name: 'Home', client,
    channels: { cache: new Map(ROOMS.map((key) => [`room_${key}`, room(key)])), fetch: async () => null },
    members: { me: { id: BOT.id, permissions: { has: () => true } } },
    fetchAuditLogs: async () => ({
      entries: [TARGET.id, CHANNEL_ID].map((id) => ({
        target: { id }, executor, reason: 'سبام', createdTimestamp: Date.now(),
        changes: [{ key: 'nick', new: 'new' }, { key: '$add', new: [{ id: 'r1' }] }],
      })),
    }),
  };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  const descriptionOf = (key, index = 0) => {
    const embed = posted[key][index]?.embeds?.[0];
    return embed?.data?.description ?? embed?.description ?? '';
  };
  return { guild, client, posted, descriptionOf };
}

describe('🧑‍💻 اللي نفّذ الأمر in every moderation log (owner\'s request)', () => {
  beforeEach(() => {
    clearInvokers();
    clearAuditRoomCache();
    AUDIT_LOG_SETTINGS.auditRetryMs = 0;
    ROLE_LOG_SETTINGS.auditRetryMs = 0;
  });

  test('the invoker is remembered for a short while; bots are never remembered', () => {
    const now = Date.now();
    assert.equal(rememberInvoker('g', 'ban', 't', STAFF, now), true);
    assert.equal(recentInvoker('g', 'ban', 't', now + 1_000)?.id, STAFF.id);
    assert.equal(recentInvoker('g', 'kick', 't', now), null);
    assert.equal(recentInvoker('g', 'ban', 't', now + INVOKER_TTL_MS + 1), null);
    assert.equal(rememberInvoker('g', 'ban', 't', BOT, now), false);
    assert.equal(rememberInvoker('g', 'ban', 't', { user: STAFF }, now), true, 'a GuildMember works too');
  });

  test('executorText: the invoker, else a human actor, else 🤖 for our bot, else unknown', () => {
    assert.match(executorText({ invoker: STAFF, actor: BOT, botId: BOT.id }), /<@200000000000000001> \(staff - 200000000000000001\)/u);
    assert.equal(executorText({ actor: BOT, botId: BOT.id }), AUTOMATED_EXECUTOR);
    assert.match(executorText({ actor: STAFF, botId: BOT.id }), /<@200000000000000001>/u);
    assert.equal(executorText({}), UNKNOWN_EXECUTOR);
  });

  test('ban / hard ban (guildBanAdd): the member who ran it; the bot on its own is 🤖', async () => {
    let s = setup();
    rememberInvoker(HOME_GUILD_ID, 'ban', TARGET.id, STAFF);
    await guildBanAdd.execute({ guild: s.guild, user: TARGET, reason: 'سبام' });
    assert.match(s.descriptionOf('ban'), STAFF_LINE);
    assert.match(s.descriptionOf('ban'), /👮 \*\*المشرف:\*\* <@999999999999999999>/u, 'the moderator line still says what Discord says');
    clearInvokers();
    s = setup();
    await guildBanAdd.execute({ guild: s.guild, user: TARGET, reason: 'سبام' });
    assert.match(s.descriptionOf('ban'), AUTOMATED_LINE);
  });

  test('a ban done by hand in Discord names that member', async () => {
    const s = setup({ executor: STAFF });
    await guildBanAdd.execute({ guild: s.guild, user: TARGET });
    assert.match(s.descriptionOf('ban'), STAFF_LINE);
  });

  test('unban (guildBanRemove)', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'unban', TARGET.id, STAFF);
    await guildBanRemove.execute({ guild: s.guild, user: TARGET });
    assert.match(s.descriptionOf('ban'), STAFF_LINE);
  });

  test('kick / mass kick (guildMemberRemove)', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'kick', TARGET.id, STAFF);
    await guildMemberRemove.execute({ guild: s.guild, user: TARGET, client: s.client, joinedTimestamp: Date.now() });
    assert.match(s.descriptionOf('ban'), STAFF_LINE);
  });

  test('timeout and untimeout (guildMemberUpdate): set and lifted are separate kinds', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'timeout', TARGET.id, STAFF);
    rememberInvoker(HOME_GUILD_ID, 'untimeout', TARGET.id, STAFF);
    const member = (until) => ({ id: TARGET.id, user: TARGET, guild: s.guild, nickname: 'same', communicationDisabledUntilTimestamp: until });
    await guildMemberUpdate.execute(member(0), member(Date.now() + 600_000));
    await guildMemberUpdate.execute(member(Date.now() + 600_000), member(0));
    assert.match(s.descriptionOf('timeout', 0), STAFF_LINE);
    assert.match(s.descriptionOf('timeout', 1), STAFF_LINE);
    assert.equal(recentInvoker(HOME_GUILD_ID, 'timeout', TARGET.id), null, 'each log took its entry');
    assert.equal(recentInvoker(HOME_GUILD_ID, 'untimeout', TARGET.id), null);
  });

  test('scenario A: staff A times X out through the bot, moderator B lifts it by hand within 30 s: the lift names B', async () => {
    const s = setup();
    let entries = [];
    s.guild.fetchAuditLogs = async () => ({ entries });
    const auditEntry = (executor, newValue) => ({
      target: { id: TARGET.id }, executor, reason: null, createdTimestamp: Date.now(),
      changes: [{ key: 'communication_disabled_until', new: newValue }],
    });
    const until = Date.now() + 600_000;
    // Staff A runs the timeout through the bot, as ModerationService.timeoutUser does: the audit log names the bot.
    await withInvoker(HOME_GUILD_ID, 'timeout', TARGET.id, STAFF, async () => { entries = [auditEntry(BOT, new Date(until).toISOString())]; });
    const member = (stamp) => ({ id: TARGET.id, user: TARGET, guild: s.guild, nickname: 'same', communicationDisabledUntilTimestamp: stamp });
    await guildMemberUpdate.execute(member(0), member(until));
    assert.match(s.descriptionOf('timeout', 0), STAFF_LINE, 'the timeout names A');

    // B lifts it by hand in Discord a few seconds later; A's own timeout entry is still in the audit log.
    entries = [auditEntry(MODERATOR, null), ...entries];
    rememberInvoker(HOME_GUILD_ID, 'timeout', TARGET.id, STAFF); // even an entry nobody took is not used for B's lift
    await guildMemberUpdate.execute(member(until), member(0));
    assert.match(s.descriptionOf('timeout', 1), MODERATOR_LINE);
    assert.doesNotMatch(s.descriptionOf('timeout', 1), /staff - 200000000000000001/u);
  });

  test('scenario A, the guard alone: a person as the audit actor is always shown, even with an invoker for the same kind', async () => {
    const s = setup({ executor: MODERATOR });
    rememberInvoker(HOME_GUILD_ID, 'ban', TARGET.id, STAFF);
    await guildBanAdd.execute({ guild: s.guild, user: TARGET, reason: 'سبام' });
    assert.match(s.descriptionOf('ban'), MODERATOR_LINE);
    assert.equal(recentInvoker(HOME_GUILD_ID, 'ban', TARGET.id)?.id, STAFF.id, 'left for the bot\'s own ban event');
  });

  test('nickname (`نك`): the member who typed it; an automatic one is 🤖', async () => {
    let s = setup();
    rememberInvoker(HOME_GUILD_ID, 'nickname', TARGET.id, STAFF);
    const member = (nickname) => ({ id: TARGET.id, user: { ...TARGET, toString: () => `<@${TARGET.id}>` }, guild: s.guild, nickname });
    await guildMemberUpdate.execute(member('old'), member('new'));
    assert.match(s.descriptionOf('roles'), STAFF_LINE);
    clearInvokers();
    s = setup();
    await guildMemberUpdate.execute(member('old'), member('new'));
    assert.match(s.descriptionOf('roles'), AUTOMATED_LINE);
  });

  test('nickname: someone else changing it by hand within 30 s of a `نك` is named, and the audit log is always read', async () => {
    const s = setup({ executor: MODERATOR });
    let auditReads = 0;
    const read = s.guild.fetchAuditLogs;
    s.guild.fetchAuditLogs = async (options) => { auditReads += 1; return read(options); };
    // `نك` ran a moment ago (its own change gave no event: the same name), so its invoker is still remembered.
    rememberInvoker(HOME_GUILD_ID, 'nickname', TARGET.id, STAFF);
    const member = (nickname) => ({ id: TARGET.id, user: { ...TARGET, toString: () => `<@${TARGET.id}>` }, guild: s.guild, nickname });
    await guildMemberUpdate.execute(member('old'), member('by hand'));
    assert.equal(auditReads, 1, 'the audit log was read although an invoker was remembered');
    assert.match(s.descriptionOf('roles'), MODERATOR_LINE);
    assert.doesNotMatch(s.descriptionOf('roles'), /staff - 200000000000000001/u);
  });

  test('roles (`ر` / `ب`): a role the bot gave for a member is logged with them; the bot\'s own changes are not', async () => {
    const s = setup();
    const member = (roleIds) => ({ id: TARGET.id, user: TARGET, guild: s.guild, roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });
    assert.equal(await logMemberRoles(member([]), member(['r1'])), false, 'the bot on its own: not logged (as before)');
    rememberInvoker(HOME_GUILD_ID, 'roles', TARGET.id, STAFF);
    assert.equal(await logMemberRoles(member([]), member(['r1'])), true);
    assert.match(s.posted.roles.at(-1).embeds[0].description, /🧑‍💻 اللي نفّذ الأمر: <@200000000000000001> \(staff - 200000000000000001\)/u);
    assert.equal(recentInvoker(HOME_GUILD_ID, 'roles', TARGET.id), null, 'used once');
  });

  /** A typed `ر @target Helpers` by the staff member whose role add fails in Discord. */
  async function failedRoleShortcut(s) {
    const role = { id: 'r1', name: 'Helpers', position: 1, managed: false, toString: () => '<@&r1>', permissions: new PermissionsBitField(0n) };
    s.guild.ownerId = '1';
    s.guild.roles = { cache: new Map([[role.id, role]]), everyone: { id: HOME_GUILD_ID } };
    const staffMember = { id: STAFF.id, user: STAFF, guild: s.guild, roles: { highest: { position: 9 } }, permissions: new PermissionsBitField(PermissionsBitField.All) };
    const targetMember = {
      id: TARGET.id, user: TARGET, guild: s.guild,
      roles: { highest: { position: 1 }, cache: new Map(), add: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); } },
    };
    s.guild.members.cache = new Map([[STAFF.id, staffMember], [TARGET.id, targetMember]]);
    s.guild.members.me = { ...s.guild.members.me, roles: { highest: { position: 100 } } };
    const replies = [];
    const message = {
      id: 'm', content: `ر <@${TARGET.id}> Helpers`, guild: s.guild, member: staffMember, author: STAFF, client: s.client, reference: null,
      channel: { send: async (payload) => { replies.push(payload); return { delete: async () => {} }; } },
    };
    assert.equal(await handleArabicRoleShortcut(message), true);
    assert.match(replies.at(-1).content, /Missing Permissions/u);
  }

  test('scenario B: a failed `ر` leaves no invoker; an admin\'s manual role add right after is theirs, a bot change is not logged', async () => {
    const memberIn = (guild) => (roleIds) => ({ id: TARGET.id, user: TARGET, guild, roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } });
    const s = setup({ executor: ADMIN });
    await failedRoleShortcut(s);
    assert.equal(recentInvoker(HOME_GUILD_ID, 'roles', TARGET.id), null, 'the failed command left nothing behind');
    const member = memberIn(s.guild);
    assert.equal(await logMemberRoles(member([]), member(['r1'])), true);
    const logged = s.posted.roles.at(-1).embeds[0].description;
    assert.match(logged, /🧑‍💻 اللي نفّذ الأمر: <@200000000000000009> \(admin - 200000000000000009\)/u);
    assert.doesNotMatch(logged, /staff - 200000000000000001/u);

    // The bot changing a role on its own after the failed `ر` is the bot's own change: not logged as the command.
    const bot = setup();
    await failedRoleShortcut(bot);
    const botMember = memberIn(bot.guild);
    assert.equal(await logMemberRoles(botMember([]), botMember(['r1'])), false);
    assert.equal(bot.posted.roles.length, 0);
  });

  test('commandInvoker: the actor guard, used once, forgotten on failure, at most MAX_INVOKERS kept', async () => {
    // A person in the audit log is shown over the invoker; our bot (by ID, else any bot user) or nobody gives the invoker.
    assert.match(executorText({ invoker: STAFF, actor: MODERATOR, botId: BOT.id }), MODERATOR_TEXT);
    assert.match(executorText({ invoker: STAFF, actor: BOT }), STAFF_TEXT, 'without botId: actor.bot');
    assert.match(executorText({ invoker: STAFF, botId: BOT.id }), STAFF_TEXT);
    const otherBot = { id: '888888888888888888', tag: 'Other', bot: true };
    assert.match(executorText({ invoker: STAFF, actor: otherBot, botId: BOT.id }), /<@888888888888888888>/u, 'another bot is not ours');

    rememberInvoker('g', 'roles', 't', STAFF);
    assert.equal(takeInvoker('g', 'roles', 't', { actor: MODERATOR, botId: BOT.id }), null, 'a person did it: not taken');
    assert.equal(takeInvoker('g', 'roles', 't', { actor: BOT, botId: BOT.id })?.id, STAFF.id);
    assert.equal(takeInvoker('g', 'roles', 't', { actor: BOT, botId: BOT.id }), null, 'taken once');

    await assert.rejects(withInvoker('g', 'kick', 't', STAFF, async () => { throw new Error('Missing Permissions'); }), /Missing Permissions/u);
    assert.equal(recentInvoker('g', 'kick', 't'), null);
    assert.equal(await withInvoker('g', 'kick', 't', STAFF, async () => 'kicked'), 'kicked');
    assert.equal(recentInvoker('g', 'kick', 't')?.id, STAFF.id);
    assert.equal(forgetInvoker('g', 'kick', 't', MODERATOR), false, 'only their own entry');
    assert.equal(forgetInvoker('g', 'kick', 't', STAFF), true);

    clearInvokers();
    const now = Date.now();
    for (let i = 0; i < MAX_INVOKERS + 25; i += 1) rememberInvoker('g', 'ban', `t${i}`, STAFF, now);
    assert.equal(invokerCount(), MAX_INVOKERS);
    assert.equal(recentInvoker('g', 'ban', 't0', now), null, 'the oldest was dropped');
    assert.equal(recentInvoker('g', 'ban', `t${MAX_INVOKERS + 24}`, now)?.id, STAFF.id);
  });

  test('lock / unlock (channelUpdate)', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'channel', CHANNEL_ID, STAFF);
    const overwrites = (deny) => ({ cache: new Map([[HOME_GUILD_ID, { allow: { bitfield: 0n }, deny: { bitfield: deny } }]]) });
    await channelUpdate.execute(
      { id: CHANNEL_ID, name: 'chat', guild: s.guild, permissionOverwrites: overwrites(0n) },
      { id: CHANNEL_ID, name: 'chat', guild: s.guild, permissionOverwrites: overwrites(2048n) },
    );
    assert.match(s.descriptionOf('channels'), STAFF_LINE);
  });

  test('clear / purge (messageBulkDelete)', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'bulkDelete', CHANNEL_ID, STAFF);
    await messageBulkDelete.execute(new Map([['1', {}], ['2', {}]]), { id: CHANNEL_ID, name: 'chat', guild: s.guild, client: s.client, toString: () => `<#${CHANNEL_ID}>` });
    assert.match(s.descriptionOf('message'), /اللي نفّذ الأمر:\*\* <@200000000000000001> \(staff - 200000000000000001\)/u);
  });

  test('pull (`سحب`, the voice log)', async () => {
    const s = setup();
    rememberInvoker(HOME_GUILD_ID, 'voice', TARGET.id, STAFF);
    const member = { id: TARGET.id, user: TARGET, guild: s.guild, toString: () => `<@${TARGET.id}>` };
    const room = (id) => ({ id, toString: () => `<#${id}>` });
    await voiceLog.execute({ member, channel: room('A'), channelId: 'A' }, { member, channel: room('B'), channelId: 'B' });
    assert.match(s.descriptionOf('voice'), STAFF_LINE);
  });

  test('the case logs (logModerationAction) of every command family name who ran it; the bot on its own is 🤖', () => {
    const actions = ['Member Banned', 'Member Kicked', 'Member Timed Out', 'Member Untimeouted', 'Member Unbanned', 'User Warned', 'Messages Purged', 'Channel Locked', 'Channel Unlocked'];
    for (const action of actions) {
      const data = buildModerationLogData({ action, target: `target (${TARGET.id})`, executor: `staff (${STAFF.id})`, metadata: { moderatorId: STAFF.id } }, BOT.id);
      assert.ok(data.lines.some((line) => /اللي نفّذ الأمر:\*\* <@200000000000000001> \(staff - 200000000000000001\)/u.test(line)), action);
    }
    const auto = buildModerationLogData({ action: 'Member Timed Out', target: `target (${TARGET.id})`, executor: `Aether (${BOT.id})`, metadata: { moderatorId: BOT.id } }, BOT.id);
    assert.ok(auto.lines.some((line) => line.includes(AUTOMATED_EXECUTOR)));
  });

  test('slash or typed ban and timeout pass the member who ran them to the moderation log room', async () => {
    const sent = [];
    const proofRoom = { isTextBased: () => true, send: async (payload) => { sent.push(payload); return { id: 'm' }; } };
    const guild = { id: HOME_GUILD_ID, ownerId: '1', client: { user: BOT }, channels: { cache: new Map([[MODERATION_ACTION_LOG_CHANNEL_ID, proofRoom]]) }, members: { me: { id: BOT.id }, cache: new Map() } };
    const staffMember = { id: STAFF.id, user: STAFF, guild, roles: { highest: { position: 9 } }, permissions: new PermissionsBitField(PermissionsBitField.All) };
    const targetMember = { id: TARGET.id, user: TARGET, guild, roles: { highest: { position: 1 } } };
    const interaction = {
      id: 'i', guild, guildId: guild.id, member: staffMember, user: STAFF, channel: { id: 'c', toString: () => '<#c>' }, createdTimestamp: Date.now(),
      options: { getUser: () => TARGET, getMember: () => targetMember, getString: () => null, getInteger: () => 10 },
      deferReply: async () => {}, reply: async () => {}, editReply: async () => {}, followUp: async () => {}, isRepliable: () => true,
    };
    const originals = { banUser: ModerationService.banUser, timeoutUser: ModerationService.timeoutUser };
    ModerationService.banUser = async () => ({});
    ModerationService.timeoutUser = async () => ({});
    try {
      await banCommand.execute(interaction, null, { user: BOT }).catch(() => {});
      await timeoutCommand.execute(interaction, null, { user: BOT }).catch(() => {});
    } finally {
      Object.assign(ModerationService, originals);
    }
    assert.equal(sent.length, 2);
    for (const payload of sent) assert.match(payload.embeds[0].description, /\*\*🧑‍💻 اللي نفّذ الأمر:\*\* <@200000000000000001> \(staff - 200000000000000001\)/u);
  });
});
