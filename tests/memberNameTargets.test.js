import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import { getGuildConfigKey } from '../src/utils/database/keys.js';
import { HIERARCHY_REFUSAL } from '../src/services/moderation/memberHierarchy.js';
import { clearInvokers, recentInvoker } from '../src/services/moderation/commandInvoker.js';
import { WarningService } from '../src/services/moderation/warningService.js';
import { handlePrefixCommand } from '../src/events/messageCreate.js';
import commandFeedback from '../src/events/02_commandFeedback.js';
import { handleArabicRoleShortcut, handlePullShortcut, handleClearWarningsShortcut } from '../src/utils/arabicModerationShortcuts.js';
import { handleArabicUtilityShortcuts } from '../src/utils/arabicUtilityShortcuts.js';
import { handleDangerCommand, isOnDangerList } from '../src/services/moderation/dangerList.js';
import nameConfirmButton from '../src/interactions/buttons/moderation/nameConfirm.js';
import {
  NAME_CONFIRM_SETTINGS, MEMBER_NOT_FOUND, LOOKUP_FAILED_TEXT, STALE_TEXT, EXPIRED_TEXT, CANCELLED_TEXT, TRUNCATED_HINT,
  clearNameConfirmations, pendingNameConfirmations, answersUnresolved, FULL_NAME_COMMAND_WORDS,
} from '../src/services/moderation/nameConfirmation.js';
import banCommand from '../src/commands/Moderation/ban.js';
import timeoutCommand from '../src/commands/Moderation/timeout.js';
import warnCommand from '../src/commands/Moderation/warn.js';
import kickCommand from '../src/commands/Moderation/kick.js';
import untimeoutCommand from '../src/commands/Moderation/untimeout.js';
import warningsCommand from '../src/commands/Moderation/warnings.js';

const ALL = PermissionsBitField.All;
const BOT_ID = '999999999999999999';
const GUILD_OWNER = '900000000000000001';
const TRUST_MANAGER = '626263734704275487';
const CHANNEL_ID = '700000000000000001';
const OTHER_GUILD = '100000000000000099';
const PREFIX = '!!';

let seq = 0;
const nextId = () => String(220000000000000000n + BigInt(++seq));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Our server with a staff member and the members given by name. Discord calls are recorded in `actions`
 * (with the invoker remembered for the logs at that moment); ban / kick / timeout stop right after the call.
 */
function setup({ guildId = HOME_GUILD_ID, staffPerms = ALL, staffPos = 10, staffId = nextId(), trusted = [], memberCount, search = null } = {}) {
  const sent = [];
  const actions = [];
  const searches = [];
  const calls = [];
  const store = new Map([[getGuildConfigKey(guildId), { prefix: PREFIX, antiNukeTrustedUsers: trusted }]]);
  const client = {
    user: { id: BOT_ID, bot: true, tag: 'Aether' },
    users: { cache: new Map(), fetch: async (id) => ({ id, tag: `user${id.slice(-2)}` }) },
    channels: { cache: new Map(), fetch: async () => null },
    db: {
      get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    },
    commands: new Map(),
  };
  const guild = {
    id: guildId, name: 'Home', ownerId: GUILD_OWNER, client, memberCount,
    roles: { cache: new Map(), everyone: { id: guildId } },
    channels: { cache: new Map(), fetch: async () => null },
  };
  guild.roles.fetch = async (id) => guild.roles.cache.get(id) || null;
  const members = new Map();
  const invoker = (kind, id) => recentInvoker(guild.id, kind, id)?.id ?? null;
  const add = ({ username, globalName = null, nickname = null, position = 3, perms = 0n, bot = false, id = nextId() } = {}) => {
    const m = {
      id, guild, nickname, displayName: nickname || globalName || username,
      user: { id, username, globalName, tag: username, bot, send: async () => {}, toString: () => `<@${id}>` },
      roles: { highest: { position }, cache: new Map() },
      permissions: new PermissionsBitField(perms),
      kickable: true, moderatable: true, bannable: true, manageable: true,
      voice: {},
      isCommunicationDisabled: () => true,
      toString: () => `<@${id}>`,
      timeout: async (ms, reason) => {
        actions.push({ timedOut: id, ms, reason, invoker: invoker(ms === null ? 'untimeout' : 'timeout', id) });
        throw new Error('stop here');
      },
      setNickname: async (nick) => { actions.push({ nick, id, invoker: invoker('nickname', id) }); },
    };
    m.roles.add = async (role) => { actions.push({ roleAdded: role.id, id, invoker: invoker('roles', id) }); };
    m.roles.remove = async (role) => { actions.push({ roleRemoved: role.id, id, invoker: invoker('roles', id) }); };
    members.set(id, m);
    return m;
  };
  const staff = add({ id: staffId, username: 'staff', position: staffPos, perms: staffPerms });
  guild.members = {
    cache: members,
    me: { id: BOT_ID, roles: { highest: { position: 100 } }, user: client.user, permissions: new PermissionsBitField(ALL) },
    fetchCalls: [],
    fetch: async (arg) => {
      const id = typeof arg === 'object' ? arg.user : arg;
      guild.members.fetchCalls.push(arg);
      if (members.has(id)) return members.get(id);
      throw Object.assign(new Error('Unknown Member'), { code: 10007, status: 404 });
    },
    search: async (options) => { searches.push(options.query); return search ? search(options) : new Map(); },
    ban: async (id, options) => {
      actions.push({ banned: id, reason: options?.reason, invoker: invoker('ban', id) });
      throw new Error('stop here');
    },
  };
  const channel = {
    id: CHANNEL_ID, guild,
    send: async (payload) => {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      const msg = { id: `sent${sent.length}`, ...body, edits: [], deleted: false };
      msg.edit = async (edit) => { msg.edits.push(edit); return msg; };
      msg.delete = async () => { msg.deleted = true; };
      sent.push(msg);
      return msg;
    },
  };
  guild.channels.cache.set(CHANNEL_ID, channel);

  // ban and timeout run for real (permission, hierarchy, ModerationService); the others record what they get.
  const recording = (real) => ({
    ...real,
    prefixExecute: undefined,
    execute: async (interaction) => {
      calls.push({
        command: real.data.name,
        target: interaction.options.getUser('target')?.id ?? null,
        reason: interaction.options.getString('reason'),
        memberId: interaction.member?.id,
        userId: interaction.user?.id,
      });
    },
  });
  client.commands.set('ban', banCommand);
  client.commands.set('timeout', timeoutCommand);
  for (const command of [warnCommand, kickCommand, untimeoutCommand, warningsCommand]) client.commands.set(command.data.name, recording(command));

  const message = (content, extra = {}) => ({
    id: nextId(), content, guild, channel, channelId: CHANNEL_ID, client, member: staff, author: staff.user,
    createdTimestamp: Date.now(), reference: null, fetchReference: async () => null, delete: async () => {}, ...extra,
  });
  const asReplyTo = (author) => ({ reference: { messageId: nextId() }, fetchReference: async () => ({ author: author.user }) });
  const typed = (content, extra) => handlePrefixCommand(message(content, extra), client);
  const press = async (customId, { by = staff } = {}) => {
    const [, ...args] = customId.split(':');
    const interaction = {
      customId, guild, guildId: guild.id, channel, user: by.user, member: by,
      replies: [], updates: [], followUps: [],
      reply: async (payload) => { interaction.replies.push(payload); },
      update: async (payload) => { interaction.updates.push(payload); },
      followUp: async (payload) => { interaction.followUps.push(payload); },
    };
    await nameConfirmButton.execute(interaction, client, args);
    return interaction;
  };
  const prompts = () => sent.filter((msg) => msg.components?.length);
  const buttonsOf = (msg) => msg.components.flatMap((row) => row.toJSON().components.map((c) => ({ id: c.custom_id, label: c.label })));
  const role = (name, position = 1) => {
    const id = nextId();
    const r = { id, name, position, managed: false, toString: () => `<@&${id}>`, permissions: new PermissionsBitField(0n) };
    guild.roles.cache.set(id, r);
    return r;
  };
  return { guild, client, staff, add, members, sent, actions, searches, calls, store, message, asReplyTo, typed, press, prompts, buttonsOf, role, channel };
}

const contents = (s) => s.sent.map((msg) => msg.content ?? '');

describe('typed commands by name: the punishing ones ask first (owner\'s request)', () => {
  beforeEach(() => { clearInvokers(); clearNameConfirmations(); });

  test('`بان محمد سبام`: asks `هل تقصد`, nobody pinged; ✅ bans that member with the reason, as the presser', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'mo_99', nickname: 'محمد' });
    await s.typed('بان محمد سبام');
    assert.equal(s.actions.length, 0, 'nothing happens before the press');
    const [prompt] = s.prompts();
    assert.ok(prompt.content.startsWith(`هل تقصد <@${mohamed.id}>؟`), prompt.content);
    assert.match(prompt.content, new RegExp(`mo_99 ・ ${mohamed.id}`));
    assert.deepEqual(prompt.allowedMentions, { parse: [] });
    const buttons = s.buttonsOf(prompt);
    assert.deepEqual(buttons.map((b) => b.label), ['✅ تأكيد', '❌ إلغاء']);
    assert.match(buttons[0].id, /^nm:confirm:[0-9a-f]{12}$/u);
    assert.match(buttons[1].id, /^nm:cancel:[0-9a-f]{12}$/u);

    const pressed = await s.press(buttons[0].id);
    assert.deepEqual(pressed.updates.at(-1).components, [], 'the buttons go');
    assert.deepEqual(s.actions, [{ banned: mohamed.id, reason: 'سبام', invoker: s.staff.id }]);
    assert.ok(s.guild.members.fetchCalls.some((arg) => typeof arg === 'object' && arg.user === s.staff.id && arg.force), 'the presser is looked up fresh');
    assert.equal(pendingNameConfirmations(), 0);
    // A second press of the same button runs nothing again.
    const again = await s.press(buttons[0].id);
    assert.equal(again.replies[0].content, STALE_TEXT);
    assert.equal(s.actions.length, 1);
  });

  test('a unique prefix also finds the member for a ban, but still only after ✅', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'محمدين' });
    await s.typed('بان محمدي');
    const [prompt] = s.prompts();
    assert.ok(prompt.content.startsWith(`هل تقصد <@${mohamed.id}>؟`));
    assert.equal(s.actions.length, 0);
  });

  test('❌ إلغاء cancels: nothing is done', async () => {
    const s = setup();
    s.add({ nickname: 'محمد', username: 'm' });
    await s.typed('بان محمد');
    const cancel = s.buttonsOf(s.prompts()[0]).find((b) => b.id.startsWith('nm:cancel:'));
    const pressed = await s.press(cancel.id);
    assert.equal(pressed.updates[0].content, CANCELLED_TEXT);
    assert.equal(s.actions.length, 0);
    assert.equal(pendingNameConfirmations(), 0);
  });

  test('after 30 seconds the buttons go and the message says it expired; a late press does nothing', async () => {
    const ttl = NAME_CONFIRM_SETTINGS.ttlMs;
    NAME_CONFIRM_SETTINGS.ttlMs = 30;
    try {
      const s = setup();
      s.add({ nickname: 'محمد', username: 'm' });
      await s.typed('بان محمد');
      const [prompt] = s.prompts();
      await sleep(80);
      assert.deepEqual(prompt.edits.at(-1), { content: EXPIRED_TEXT, components: [], allowedMentions: { parse: [] } });
      const pressed = await s.press(s.buttonsOf(prompt)[0].id);
      assert.equal(pressed.replies[0].content, STALE_TEXT);
      assert.equal(pressed.replies[0].flags, MessageFlags.Ephemeral);
      assert.equal(s.actions.length, 0);
    } finally {
      NAME_CONFIRM_SETTINGS.ttlMs = ttl;
    }
  });

  test('only the member who typed it may press; anyone else gets a short private answer', async () => {
    const s = setup();
    const mohamed = s.add({ nickname: 'محمد', username: 'm' });
    const other = s.add({ username: 'other', position: 50, perms: ALL });
    await s.typed('بان محمد');
    const confirm = s.buttonsOf(s.prompts()[0])[0].id;
    const foreign = await s.press(confirm, { by: other });
    assert.match(foreign.replies[0].content, /الأزرار دي/u);
    assert.equal(foreign.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(s.actions.length, 0);
    await s.press(confirm);
    assert.deepEqual(s.actions.map((a) => a.banned), [mohamed.id]);
  });

  test('the permission is checked again at the press: lost meanwhile, nothing is done and nothing said', async () => {
    const s = setup();
    s.add({ nickname: 'محمد', username: 'm' });
    await s.typed('بان محمد');
    s.staff.permissions = new PermissionsBitField(0n);
    const before = s.sent.length;
    await s.press(s.buttonsOf(s.prompts()[0])[0].id);
    assert.equal(s.actions.length, 0);
    assert.equal(s.sent.length, before);
  });

  test('the role hierarchy is checked again at the press', async () => {
    const s = setup();
    const mohamed = s.add({ nickname: 'محمد', username: 'm' });
    await s.typed('بان محمد');
    mohamed.roles.highest.position = 20;
    await s.press(s.buttonsOf(s.prompts()[0])[0].id);
    assert.equal(s.actions.length, 0);
    assert.ok(contents(s).includes(HIERARCHY_REFUSAL), contents(s).join(' | '));
  });

  test('a press after a restart (nothing pending in memory) gets a polite private answer', async () => {
    const s = setup();
    s.add({ nickname: 'محمد', username: 'm' });
    await s.typed('بان محمد');
    const confirm = s.buttonsOf(s.prompts()[0])[0].id;
    clearNameConfirmations();
    const pressed = await s.press(confirm);
    assert.equal(pressed.replies[0].content, STALE_TEXT);
    assert.equal(pressed.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(s.actions.length, 0);
  });

  test('`تايم احمد 10m سبب`: the duration and the reason are kept; without a duration the default 15m', async () => {
    const s = setup();
    const ahmed = s.add({ username: 'ahmed', globalName: 'أحمد' });
    await s.typed('تايم احمد 10m سبب');
    await s.press(s.buttonsOf(s.prompts()[0])[0].id);
    assert.deepEqual(s.actions, [{ timedOut: ahmed.id, ms: 600_000, reason: 'سبب', invoker: s.staff.id }]);
    await s.typed('تايم احمد');
    await s.press(s.buttonsOf(s.prompts()[1])[0].id);
    assert.equal(s.actions[1].ms, 15 * 60_000);
  });

  test('`وارن محمد سبب طويل`, `كيك محمد`, `انتايم محمد`: asked, then run with the same words as the presser', async () => {
    const s = setup();
    const mohamed = s.add({ nickname: 'محمد', username: 'm' });
    for (const content of ['وارن محمد سبب طويل', 'كيك محمد بره', 'انتايم محمد', 'warn محمد x', 'kick محمد', 'untimeout محمد']) {
      const before = s.prompts().length;
      await s.typed(content);
      assert.equal(s.prompts().length, before + 1, content);
      assert.equal(s.calls.length, before, `${content}: nothing before the press`);
      await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    }
    assert.deepEqual(s.calls.map((c) => [c.command, c.target, c.reason, c.userId, c.memberId]), [
      ['warn', mohamed.id, 'سبب طويل', s.staff.id, s.staff.id],
      ['kick', mohamed.id, 'بره', s.staff.id, s.staff.id],
      ['untimeout', mohamed.id, null, s.staff.id, s.staff.id],
      ['warn', mohamed.id, 'x', s.staff.id, s.staff.id],
      ['kick', mohamed.id, null, s.staff.id, s.staff.id],
      ['untimeout', mohamed.id, null, s.staff.id, s.staff.id],
    ]);
  });

  test('several members with the name: they are listed with a button each and ❌; nothing until one is picked', async () => {
    const s = setup();
    const first = s.add({ username: 'sam.1', nickname: 'sam' });
    const second = s.add({ username: 'sam.2', globalName: 'Sam' });
    await s.typed('ban sam spam');
    const [prompt] = s.prompts();
    for (const member of [first, second]) assert.match(prompt.content, new RegExp(`<@${member.id}> — sam\\.\\d ・ ${member.id}`));
    const buttons = s.buttonsOf(prompt);
    assert.deepEqual(buttons.map((b) => b.id.replace(/:[0-9a-f]{12}/u, '')), ['nm:pick:0', 'nm:pick:1', 'nm:cancel']);
    assert.equal(s.actions.length, 0);
    await s.press(buttons[1].id);
    assert.deepEqual(s.actions, [{ banned: second.id, reason: 'spam', invoker: s.staff.id }]);
  });

  test('more than five members with the name: five buttons and the count of the rest', async () => {
    const s = setup();
    for (let i = 0; i < 7; i += 1) s.add({ username: `ziad${i}`, nickname: 'زياد' });
    await s.typed('بان زياد');
    const [prompt] = s.prompts();
    assert.equal(s.buttonsOf(prompt).filter((b) => b.id.startsWith('nm:pick:')).length, 5);
    assert.match(prompt.content, /و 2 كمان/u);
  });

  test('at most `maxPending` questions wait: the oldest is dropped, says it expired, and its press does nothing', async () => {
    const max = NAME_CONFIRM_SETTINGS.maxPending;
    assert.equal(max, 200);
    NAME_CONFIRM_SETTINGS.maxPending = 3;
    try {
      const s = setup();
      s.add({ nickname: 'محمد', username: 'm' });
      for (let i = 0; i < 5; i += 1) await s.typed('بان محمد');
      assert.equal(pendingNameConfirmations(), 3);
      const [first, second, third] = s.prompts();
      assert.equal(first.edits.at(-1).content, EXPIRED_TEXT);
      assert.equal(second.edits.at(-1).content, EXPIRED_TEXT);
      assert.equal(third.edits.length, 0);
      const late = await s.press(s.buttonsOf(first)[0].id);
      assert.equal(late.replies[0].content, STALE_TEXT);
      assert.equal(s.actions.length, 0);
    } finally {
      NAME_CONFIRM_SETTINGS.maxPending = max;
    }
  });

  test('a bot can be named but is flagged 🤖', async () => {
    const s = setup();
    s.add({ username: 'Helper', bot: true });
    await s.typed('بان helper');
    assert.match(s.prompts()[0].content, /🤖/u);
  });

  test('a name target the staff member may not act on is refused at once, with no question', async () => {
    const s = setup({ staffPos: 5 });
    s.add({ nickname: 'محمد', username: 'm', position: 5 });
    await s.typed('بان محمد');
    assert.deepEqual(contents(s), [HIERARCHY_REFUSAL]);
    const owner = setup();
    owner.add({ id: GUILD_OWNER, username: 'boss' });
    await owner.typed('تايم boss 10m');
    assert.deepEqual(contents(owner), [HIERARCHY_REFUSAL], 'the guild owner is never a target');
    owner.add({ id: SERVER_OWNER_IDS[0], username: 'king' });
    await owner.typed('بان king');
    assert.deepEqual(contents(owner), [HIERARCHY_REFUSAL, HIERARCHY_REFUSAL], 'nor a server owner');
    assert.equal(s.prompts().length + owner.prompts().length + s.actions.length + owner.actions.length, 0);
  });

  test('a mention, an ID or a reply still act at once and win over a name', async () => {
    const s = setup();
    const mohamed = s.add({ nickname: 'محمد', username: 'm' });
    const other = s.add({ username: 'other' });
    await s.typed(`بان <@${other.id}> محمد`);
    await s.typed(`timeout ${other.id} 5m`);
    await s.typed('بان محمد', s.asReplyTo(other));
    assert.equal(s.prompts().length, 0);
    assert.deepEqual(s.actions.map((a) => a.banned || a.timedOut), [other.id, other.id, other.id]);
    assert.equal(s.actions[2].reason, 'محمد', 'the replied-to member is the target, the word is the reason');
    assert.equal(s.actions.some((a) => a.banned === mohamed.id), false);
  });
});

describe('a name nobody has', () => {
  beforeEach(() => { clearInvokers(); clearNameConfirmations(); });

  test('without the prefix a name nobody has is chat: staff get no answer and nothing happens (`بان عليه التعب`)', async () => {
    const s = setup();
    for (const content of ['بان عليه التعب', 'بان فلان', 'تايم فلان 10m', 'وارن فلان سبب', 'وارنات فلان', 'كيك فلان', 'ban someone', 'انتايم فلان']) {
      await s.typed(content);
    }
    assert.equal(s.sent.length, 0);
    assert.equal(s.prompts().length + s.actions.length + s.calls.length, 0);
  });

  test('with the prefix it is `❌ Member Not Found`, deleted after 8 seconds', async () => {
    assert.equal(NAME_CONFIRM_SETTINGS.notFoundDeleteMs, 8_000);
    const deleteMs = NAME_CONFIRM_SETTINGS.notFoundDeleteMs;
    NAME_CONFIRM_SETTINGS.notFoundDeleteMs = 20;
    try {
      const s = setup();
      for (const content of [`${PREFIX}بان فلان`, `${PREFIX}طرد فلان`, `${PREFIX}تايم فلان 10m`, `${PREFIX}وارنات فلان`, `${PREFIX}ban someone`]) {
        const before = s.sent.length;
        await s.typed(content);
        assert.deepEqual(contents(s).slice(before), [MEMBER_NOT_FOUND], content);
      }
      await sleep(60);
      assert.ok(s.sent.every((msg) => msg.deleted), 'every answer deleted itself');
      assert.equal(s.prompts().length + s.actions.length + s.calls.length, 0);
    } finally {
      NAME_CONFIRM_SETTINGS.notFoundDeleteMs = deleteMs;
    }
  });

  test('a member without the permission gets no answer at all, and nobody is looked up', async () => {
    const s = setup({ staffPerms: 0n });
    s.add({ nickname: 'محمد', username: 'm' });
    for (const content of ['بان فلان', 'بان محمد', `${PREFIX}بان فلان`, 'تايم محمد 10m', 'وارنات محمد']) await s.typed(content);
    assert.equal(s.sent.length, 0);
    assert.equal(s.searches.length, 0);
    assert.equal(s.actions.length + s.calls.length, 0);
  });

  test('who is answered: nobody found only with the prefix; a failed search also for a full command word', async () => {
    const s = setup();
    await s.typed('طرد فلان');
    await s.typed('تحذير فلان');
    assert.equal(s.sent.length, 0);
    const notFound = { status: 'none', reason: 'not_found' };
    const failed = { status: 'none', reason: 'lookup_failed' };
    for (const word of ['بان', 'تايم', 'انتايم', 'وارن', 'وارنات', 'سحب', 'نك', 'مسح تحذيرات', 'تراست', 'انتراست', 'خطر', 'كيك', 'ban', 'timeout', 'untimeout', 'warn', 'kick', 'pull', 'trust', 'untrust']) {
      assert.equal(FULL_NAME_COMMAND_WORDS.has(word), true, word);
      assert.equal(answersUnresolved(notFound, word, false), false, word);
      assert.equal(answersUnresolved(failed, word, false), true, word);
    }
    for (const word of ['ب', 'ر', 'ان', 'رول', 'رتبة', 'شيل', 'م', 'ف', 'ق', 'طرد']) {
      assert.equal(answersUnresolved(notFound, word, false), false, word);
      assert.equal(answersUnresolved(failed, word, false), false, word);
      assert.equal(answersUnresolved(notFound, word, true), true, word);
    }
    assert.equal(answersUnresolved({ status: 'none', reason: 'no_name' }, 'بان', true), false, 'no name words: the old behaviour');
  });

  test('an incomplete cache and a failed search: nobody is acted on, staff are told the search failed', async () => {
    const s = setup({ memberCount: 500, search: () => { throw new Error('503'); } });
    const mohamed = s.add({ nickname: 'محمد', username: 'm' });
    s.role('Helpers');
    await s.typed('بان محمد');
    assert.deepEqual(contents(s), [LOOKUP_FAILED_TEXT], 'the one cached محمد is not taken as the only one');
    await s.typed('وارنات محمد');
    assert.equal(await handleArabicRoleShortcut(s.message(`${PREFIX}ر محمد Helpers`), [PREFIX]), true);
    assert.equal(await handlePullShortcut(s.message('سحب محمد'), ['محمد']), true);
    assert.deepEqual(contents(s), [LOOKUP_FAILED_TEXT, LOOKUP_FAILED_TEXT, LOOKUP_FAILED_TEXT, LOOKUP_FAILED_TEXT]);
    assert.equal(await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]), false, 'a short word without the prefix: chat');
    assert.equal(s.prompts().length + s.actions.length + s.calls.length, 0);
    assert.equal(s.sent.length, 4);
    assert.ok(mohamed);
  });

  test('a search cut at its limit: a prefix match asks (with a warning) instead of acting', async () => {
    let fill = [];
    const s = setup({ memberCount: 500, search: () => new Map(fill.map((m) => [m.id, m])) });
    const mohamed = s.add({ username: 'mohamed' });
    const helpers = s.role('Helpers');
    fill = [mohamed, ...Array.from({ length: 9 }, (_, i) => s.add({ username: `zzz${i}` }))];
    assert.equal(await handleArabicRoleShortcut(s.message('ر moh Helpers'), [PREFIX]), true);
    assert.equal(s.actions.length, 0, 'not given at once');
    const [prompt] = s.prompts();
    assert.ok(prompt.content.includes(TRUNCATED_HINT), prompt.content);
    assert.match(prompt.content, new RegExp(`<@${mohamed.id}>`));
    await s.press(s.buttonsOf(prompt)[0].id);
    assert.deepEqual(s.actions, [{ roleAdded: helpers.id, id: mohamed.id, invoker: s.staff.id }]);
  });

  test('words that are not a name keep the old behaviour (`تايم 10m` is chat)', async () => {
    const s = setup();
    await s.typed('تايم 10m');
    await s.typed('بان');
    assert.equal(s.sent.length, 0);
  });

  test('another server keeps mentions and IDs only: no lookup, no answer', async () => {
    const s = setup({ guildId: OTHER_GUILD });
    s.add({ nickname: 'محمد', username: 'm' });
    await s.typed('بان محمد');
    await s.typed('بان فلان');
    s.role('Helpers');
    assert.equal(await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]), false);
    s.staff.voice = { channel: { id: 'A' } };
    assert.equal(await handlePullShortcut(s.message('سحب محمد'), ['محمد']), false);
    await handleClearWarningsShortcut(s.message('مسح تحذيرات محمد'), ['محمد']);
    assert.equal(s.sent.length + s.searches.length + s.actions.length, 1, 'only the old usage line');
    assert.equal(contents(s).at(-1), '⚠️ مسح تحذيرات @user');
    // `نك محمد x` keeps its old meaning there: your own nickname.
    await handleArabicUtilityShortcuts(s.message('نك محمد x'));
    assert.deepEqual(s.actions.at(-1), { nick: 'محمد x', id: s.staff.id, invoker: s.staff.id });
  });
});

describe('the other commands by name: a full name acts directly, a prefix asks first', () => {
  beforeEach(() => { clearInvokers(); clearNameConfirmations(); });

  test('`ر محمد Helpers` / `ب محمد Helpers` (full name): the role is given or taken at once, the log names the staff member', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    const helpers = s.role('Helpers');
    assert.equal(await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]), true);
    assert.equal(await handleArabicRoleShortcut(s.message('ب محمد Helpers'), [PREFIX]), true);
    assert.equal(await handleArabicRoleShortcut(s.message(`ر محمد <@&${helpers.id}>`), [PREFIX]), true, 'the role by mention');
    assert.deepEqual(s.actions, [
      { roleAdded: helpers.id, id: mohamed.id, invoker: s.staff.id },
      { roleRemoved: helpers.id, id: mohamed.id, invoker: s.staff.id },
      { roleAdded: helpers.id, id: mohamed.id, invoker: s.staff.id },
    ]);
    assert.equal(s.prompts().length, 0, 'no question for a full name');
  });

  test('`ر محم Helpers` (a prefix): nothing until ✅; the press gives the role as the presser, checked again', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    const helpers = s.role('Helpers');
    assert.equal(await handleArabicRoleShortcut(s.message('ر محم Helpers'), [PREFIX]), true);
    assert.equal(s.actions.length, 0, 'a prefix never grants a role at once');
    const [prompt] = s.prompts();
    assert.ok(prompt.content.startsWith(`هل تقصد <@${mohamed.id}>؟`), prompt.content);
    await s.press(s.buttonsOf(prompt)[0].id);
    assert.deepEqual(s.actions, [{ roleAdded: helpers.id, id: mohamed.id, invoker: s.staff.id }]);

    // Manage Roles lost before the press: nothing is given, nothing said.
    await handleArabicRoleShortcut(s.message('ب محم Helpers'), [PREFIX]);
    s.staff.permissions = new PermissionsBitField(0n);
    const before = s.sent.length;
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal(s.actions.length, 1);
    assert.equal(s.sent.length, before);
  });

  test('a prefix match on a member above the staff member: asked, then refused at the press (role hierarchy)', async () => {
    const s = setup({ staffPos: 5 });
    const mohamed = s.add({ username: 'mo', nickname: 'محمد', position: 3 });
    s.role('Helpers');
    await handleArabicRoleShortcut(s.message('ر محم Helpers'), [PREFIX]);
    mohamed.roles.highest.position = 9;
    await s.press(s.buttonsOf(s.prompts()[0])[0].id);
    assert.equal(s.actions.length, 0);
    assert.equal(contents(s).at(-1), HIERARCHY_REFUSAL);
  });

  test('ordinary sentences by staff stay silent (`ب كام ده`, `ر دي حلوة`, `ر محمد حلوة` with no such role)', async () => {
    const s = setup();
    s.add({ username: 'mo', nickname: 'محمد' });
    s.role('Helpers');
    for (const content of ['ب كام ده', 'ر دي حلوة', 'ر محمد حلوة', 'شيل ده', 'ان شاء الله', 'رتبة حلوة', 'ب محمد']) {
      assert.equal(await handleArabicRoleShortcut(s.message(content), [PREFIX]), false, content);
    }
    for (const content of ['ب كام ده', 'ر دي حلوة']) await s.typed(content);
    assert.equal(s.sent.length + s.actions.length, 0);
    assert.equal(s.searches.length, 0, 'chat that names no role is not even looked up');
  });

  test('with the prefix the role words answer: Member Not Found, or the role not found', async () => {
    const s = setup();
    s.add({ username: 'mo', nickname: 'محمد' });
    s.role('Helpers');
    assert.equal(await handleArabicRoleShortcut(s.message(`${PREFIX}ر فلان Helpers`), [PREFIX]), true);
    assert.equal(await handleArabicRoleShortcut(s.message(`${PREFIX}ر محمد Nope`), [PREFIX]), true);
    assert.deepEqual(contents(s), [MEMBER_NOT_FOUND, '❌ Role Nope Not Found']);
    assert.equal(s.actions.length, 0);
  });

  test('several members with the name are listed (deleted after a while) and nobody gets the role', async () => {
    const s = setup();
    const a = s.add({ username: 'mo.1', nickname: 'محمد' });
    const b = s.add({ username: 'mo.2', nickname: 'محمد' });
    s.role('Helpers');
    assert.equal(await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]), true);
    assert.equal(s.sent.length, 1);
    assert.match(s.sent[0].content, new RegExp(`<@${a.id}>[\\s\\S]*<@${b.id}>`));
    assert.equal(s.sent[0].components, undefined, 'a list, no buttons');
    assert.equal(s.actions.length, 0);
  });

  test('a name target above the staff member is refused (role hierarchy)', async () => {
    const s = setup({ staffPos: 5 });
    s.add({ username: 'mo', nickname: 'محمد', position: 7 });
    s.role('Helpers');
    await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]);
    assert.deepEqual(contents(s), [HIERARCHY_REFUSAL]);
    assert.equal(s.actions.length, 0);
  });

  test('members named like command words do not change how messages are read', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    const named = ['ر', 'بان', 'Helpers', 'تايم'].map((name) => s.add({ username: name }));
    const helpers = s.role('Helpers');
    await handleArabicRoleShortcut(s.message('ر محمد Helpers'), [PREFIX]);
    await handleArabicRoleShortcut(s.message(`ر <@${named[0].id}> Helpers`), [PREFIX]);
    assert.deepEqual(s.actions.map((a) => [a.roleAdded, a.id]), [[helpers.id, mohamed.id], [helpers.id, named[0].id]]);
    await s.typed(`بان <@${named[1].id}>`);
    assert.equal(s.actions.at(-1).banned, named[1].id, 'a mention still bans at once');
    await s.typed('تايم محمد 10m');
    assert.ok(s.prompts().at(-1).content.startsWith(`هل تقصد <@${mohamed.id}>؟`), 'the member after the word, not the one named like it');
  });

  test('`سحب محمد` (full name) pulls at once, `سحب محم` (prefix) asks; nobody found: silent, or Member Not Found with the prefix', async () => {
    const s = setup();
    const room = { id: 'A', toString: () => '<#A>' };
    s.staff.voice = { channel: room };
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    const moved = [];
    mohamed.voice = { channel: { id: 'B' }, channelId: 'B', setChannel: async (to) => { moved.push([to.id, recentInvoker(s.guild.id, 'voice', mohamed.id)?.id]); } };
    assert.equal(await handlePullShortcut(s.message('سحب محمد'), ['محمد']), true);
    assert.deepEqual(moved, [['A', s.staff.id]]);
    assert.equal(await handlePullShortcut(s.message('سحب محم'), ['محم']), true);
    assert.equal(moved.length, 1, 'a prefix does not pull at once');
    await s.press(s.buttonsOf(s.prompts()[0])[0].id);
    assert.deepEqual(moved, [['A', s.staff.id], ['A', s.staff.id]], 'pulled at the press, as the presser');
    assert.equal(await handlePullShortcut(s.message('سحب فلان'), ['فلان']), true);
    assert.equal(s.sent.filter((msg) => msg.content === MEMBER_NOT_FOUND).length, 0, 'no answer without the prefix');
    assert.equal(await handlePullShortcut(s.message(`${PREFIX}سحب فلان`), ['فلان'], { prefixed: true }), true);
    assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND);
    assert.equal(await handlePullShortcut(s.message('سحب 222200000000000001'), ['222200000000000001']), true);
    assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND, 'an ID nobody in the server has');
    assert.equal(await handlePullShortcut(s.message('سحب 5'), ['5']), false, 'not a name');
    const noPerm = setup({ staffPerms: 0n });
    noPerm.add({ username: 'mo', nickname: 'محمد' });
    assert.equal(await handlePullShortcut(noPerm.message('سحب محمد'), ['محمد']), false);
    assert.equal(await handlePullShortcut(noPerm.message('سحب فلان'), ['فلان'], { prefixed: true }), false);
    await handlePullShortcut(noPerm.message('سحب 222200000000000001'), ['222200000000000001']);
    assert.equal(noPerm.sent.length + noPerm.searches.length, 0);
  });

  test('`نك محمد اسم-جديد` renames another member only after ✅; your own name or nobody\'s is your own nickname', async () => {
    const s = setup();
    s.staff.user.username = 'ywsf';
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    await handleArabicUtilityShortcuts(s.message('نك محمد اسم-جديد'));
    assert.equal(s.actions.length, 0, 'nobody else is renamed at once');
    const [prompt] = s.prompts();
    assert.ok(prompt.content.startsWith(`هل تقصد <@${mohamed.id}>؟`), prompt.content);
    await s.press(s.buttonsOf(prompt)[0].id);
    await handleArabicUtilityShortcuts(s.message('نك اسمي الجديد'));
    await handleArabicUtilityShortcuts(s.message('نك محم جديد'));
    await handleArabicUtilityShortcuts(s.message('نك ywsf الجديد'));
    assert.deepEqual(s.actions, [
      { nick: 'اسم-جديد', id: mohamed.id, invoker: s.staff.id },
      { nick: 'اسمي الجديد', id: s.staff.id, invoker: s.staff.id },
      { nick: 'محم جديد', id: s.staff.id, invoker: s.staff.id },
      { nick: 'ywsf الجديد', id: s.staff.id, invoker: s.staff.id },
    ], 'exact names only; a prefix, nobody, or your own name: the whole text is your own nickname');
    assert.equal(s.prompts().length, 1);
  });

  test('`نك محمد x` asked, then Manage Nicknames lost or محمد above the presser: nobody is renamed', async () => {
    const s = setup({ staffPos: 5 });
    const mohamed = s.add({ username: 'mo', nickname: 'محمد', position: 3 });
    await handleArabicUtilityShortcuts(s.message('نك محمد x'));
    mohamed.roles.highest.position = 9;
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal(contents(s).at(-1), HIERARCHY_REFUSAL);
    mohamed.roles.highest.position = 3;
    await handleArabicUtilityShortcuts(s.message('نك محمد y'));
    s.staff.permissions = new PermissionsBitField(0n);
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal(s.actions.length, 0);
  });

  test('`مسح تحذيرات محمد` clears at once, `مسح تحذيرات محم` asks; nobody found: silent, or Member Not Found with the prefix', async () => {
    const clearWarnings = WarningService.clearWarnings;
    const cleared = [];
    WarningService.clearWarnings = async (guildId, userId) => { cleared.push(userId); return { count: 2 }; };
    try {
      const s = setup();
      const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
      await handleClearWarningsShortcut(s.message('مسح تحذيرات محمد'), ['محمد']);
      assert.deepEqual(cleared, [mohamed.id]);
      await handleClearWarningsShortcut(s.message('مسح تحذيرات محم'), ['محم']);
      assert.equal(cleared.length, 1, 'a prefix does not clear at once');
      await s.press(s.buttonsOf(s.prompts()[0])[0].id);
      assert.deepEqual(cleared, [mohamed.id, mohamed.id]);
      const before = s.sent.length;
      await handleClearWarningsShortcut(s.message('مسح تحذيرات فلان'), ['فلان']);
      assert.equal(s.sent.length, before, 'no answer (not even the usage) without the prefix');
      await handleClearWarningsShortcut(s.message(`${PREFIX}مسح تحذيرات فلان`), ['فلان'], { prefixed: true });
      assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND);
      await handleClearWarningsShortcut(s.message('مسح تحذيرات <@222200000000000002>'), ['<@222200000000000002>']);
      assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND, 'a mention nobody in the server has');
      assert.equal(cleared.length, 2);
    } finally {
      WarningService.clearWarnings = clearWarnings;
    }
  });

  test('`وارنات محمد` shows the warnings at once (viewing does not ask)', async () => {
    const s = setup();
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    await s.typed('وارنات محمد');
    assert.equal(s.prompts().length, 0);
    assert.deepEqual(s.calls.map((c) => [c.command, c.target]), [['warnings', mohamed.id]]);
  });
});

describe('trust and the danger list by name ask first', () => {
  beforeEach(() => { clearInvokers(); clearNameConfirmations(); });

  test('`تراست محمد` / `انتراست محمد`: asked, then trusted / untrusted; a name nobody has is not answered', async () => {
    const s = setup({ staffId: TRUST_MANAGER });
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    const trusted = async () => (await s.client.db.get(getGuildConfigKey(s.guild.id), {})).antiNukeTrustedUsers || [];
    await commandFeedback.execute(s.message('تراست محمد'), s.client);
    assert.equal((await trusted()).includes(mohamed.id), false, 'not before the press');
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal((await trusted()).includes(mohamed.id), true);
    await commandFeedback.execute(s.message('انتراست محمد'), s.client);
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal((await trusted()).includes(mohamed.id), false);
    const before = s.sent.length;
    await commandFeedback.execute(s.message('تراست فلان'), s.client);
    assert.equal(s.sent.length, before, 'chat: no answer, not even the usage');
    await commandFeedback.execute(s.message('تراست <@222200000000000003>'), s.client);
    assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND, 'a mention nobody in the server has');
  });

  test('trust by name from someone who may not give trust: the old answer, no question', async () => {
    const s = setup();
    s.add({ username: 'mo', nickname: 'محمد' });
    await commandFeedback.execute(s.message('تراست محمد'), s.client);
    assert.deepEqual(contents(s), ['🚫 Owner Only']);
    assert.equal(s.prompts().length + s.searches.length, 0);
  });

  test('`خطر محمد`: asked, then listed; the presser must still be trusted at the press', async () => {
    const staffId = nextId();
    const s = setup({ staffId, trusted: [staffId] });
    const mohamed = s.add({ username: 'mo', nickname: 'محمد' });
    assert.equal(await handleDangerCommand(s.message('خطر محمد'), ['محمد']), true);
    assert.equal(await isOnDangerList(s.client, s.guild.id, mohamed.id), false, 'not before the press');
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal(await isOnDangerList(s.client, s.guild.id, mohamed.id), true);

    const ali = s.add({ username: 'ali', nickname: 'علي' });
    await handleDangerCommand(s.message('خطر علي'), ['علي']);
    s.store.set(getGuildConfigKey(s.guild.id), { prefix: PREFIX, antiNukeTrustedUsers: [] });
    await s.press(s.buttonsOf(s.prompts().at(-1))[0].id);
    assert.equal(await isOnDangerList(s.client, s.guild.id, ali.id), false, 'trust lost before the press');

    s.store.set(getGuildConfigKey(s.guild.id), { prefix: PREFIX, antiNukeTrustedUsers: [staffId] });
    const before = s.sent.length;
    assert.equal(await handleDangerCommand(s.message('خطر جدا'), ['جدا']), false, 'chat: the message goes on');
    assert.equal(s.sent.length, before, 'and nothing is answered');
    assert.equal(await handleDangerCommand(s.message(`${PREFIX}خطر فلان`), ['فلان'], { prefixed: true }), true);
    assert.equal(contents(s).at(-1), MEMBER_NOT_FOUND);
    const stranger = setup();
    assert.equal(await handleDangerCommand(stranger.message('خطر محمد'), ['محمد']), false, 'not trusted: chat');
    assert.equal(stranger.sent.length, 0);
  });
});
