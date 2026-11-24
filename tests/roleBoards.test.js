import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import {
  buildRoleBoardEmbed,
  handleRoleBoardPacket,
  loadGuildBoards,
  parseBoardMessageEntries,
  parseEmoji,
  publishRoleBoard,
  registerRoleBoardReactions,
  resolveBoardEntries,
  ROLE_BOARD_MAX_ROLES,
} from '../src/services/roleBoardService.js';
import { pruneMissingPanelRoles } from '../src/services/reactionRoleService.js';
import { ROLE_BOARDS, getRoleBoardConfig } from '../src/config/roleBoards.js';
import { getRoleBoardsKey, getReactionRoleKey } from '../src/utils/database/keys.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import publishBoardCommand from '../src/commands/Core/publish-board.js';
import roleDeleteCleanup from '../src/events/roleBoardRoleDelete.js';
import roleBoardReady from '../src/events/roleBoardReactions.js';

// Two servers: everything here works in any server the bot is in (owner's rule of 2026-11-17).
const ZENITH = '1569932761471524874';
const OTHER = '1155236281706627173';
const BOT_ID = '900000000000000001';
const BOARD_CHANNEL = '1569949365072691302';
let seq = 0;
const snowflake = () => String(800000000000000000n + BigInt(++seq));

function makeRole(id, name, position, { managed = false, permissions = 0n } = {}) {
  return { id, name, position, managed, permissions: new PermissionsBitField(permissions), toString: () => `<@&${id}>` };
}

function makeMember(id, { bot = false, failAdd = false } = {}) {
  const roles = new Map();
  return {
    id,
    user: { id, bot },
    roles: {
      cache: roles,
      add: async (role) => { if (failAdd) throw new Error('Missing Permissions'); roles.set(role.id, role); },
      remove: async (role) => { roles.delete(role.id); },
    },
  };
}

function makeDb() {
  const store = new Map();
  return {
    store,
    get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    delete: async (key) => store.delete(key),
    list: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
  };
}

function emojiFromText(text) {
  const custom = String(text).match(/^<(a?):(\w+):(\d+)>$/);
  return custom ? { id: custom[3], name: custom[2], animated: Boolean(custom[1]) } : { id: null, name: text };
}

function makeChannel(guild, id, { permissions = PermissionsBitField.All, failReact = [] } = {}) {
  const messages = new Map();
  const sent = [];
  const channel = {
    id, guild, sent, messages: null,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(permissions),
    send: async (payload) => { sent.push(payload); return post(payload); },
  };
  function post(payload, { author = { id: BOT_ID } } = {}) {
    const messageId = snowflake();
    const reactions = new Map();
    const message = {
      id: messageId, channel, channelId: id, author, content: payload.content || '', embeds: payload.embeds || [],
      url: `https://discord.com/channels/${guild.id}/${id}/${messageId}`,
      edits: [], deleted: false, reactions: { cache: reactions },
      edit: async (next) => { message.edits.push(next); if (next.embeds) message.embeds = next.embeds; return message; },
      delete: async () => { message.deleted = true; messages.delete(messageId); },
      react: async (emoji) => {
        if (failReact.includes(emoji)) throw new Error('Unknown Emoji');
        const parsed = emojiFromText(emoji);
        const key = parsed.id || parsed.name.replaceAll(String.fromCodePoint(0xfe0f), '');
        const reaction = reactions.get(key) || { emoji: parsed, me: false, count: 0, removed: false, remove: async () => { reaction.removed = true; reactions.delete(key); } };
        reaction.me = true; reaction.count += 1; reactions.set(key, reaction);
        message.reactOrder = [...(message.reactOrder || []), emoji];
      },
    };
    messages.set(messageId, message);
    return message;
  }
  channel.post = post;
  channel.messages = {
    store: messages,
    fetch: async (arg) => {
      if (typeof arg !== 'string') return new Map(messages);
      if (channel.fetchError) throw channel.fetchError;
      const message = messages.get(arg);
      if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return message;
    },
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

function makeGuild(id, { name = 'Zenith', roles = [], botTop = 50 } = {}) {
  const roleCache = new Map([[id, makeRole(id, '@everyone', 0)], ...roles.map((role) => [role.id, role])]);
  const members = new Map();
  const guild = {
    id, name, available: true,
    roles: { cache: roleCache },
    members: {
      me: { id: BOT_ID, roles: { highest: { position: botTop } }, permissions: new PermissionsBitField(PermissionsBitField.All) },
      cache: members,
      fetch: async (userId) => { const member = members.get(userId); if (!member) throw new Error('Unknown Member'); return member; },
      fetchMe: async () => guild.members.me,
    },
    channels: { cache: new Map(), fetch: async (channelId) => guild.channels.cache.get(channelId) || null },
    iconURL: () => null,
  };
  return guild;
}

function makeClient(guilds = []) {
  const rest = { calls: [] };
  for (const method of ['put', 'delete', 'patch']) rest[method] = async (route, options) => { rest.calls.push({ method, route, options }); };
  const listeners = [];
  return {
    user: { id: BOT_ID },
    db: makeDb(),
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    emojis: { cache: new Map() },
    rest,
    listeners,
    on: (event, fn) => listeners.push({ event, fn }),
  };
}

const gameRoles = () => [
  makeRole('700000000000000001', 'Rocket League', 10),
  makeRole('700000000000000002', 'Roblox', 9),
  makeRole('700000000000000003', 'Valorant', 8),
];
const gamesBoard = (roles) => ({
  key: 'games', title: '🎮 ┃ Games', description: 'اختار لعبتك', color: 0x5865f2, roles,
});

function setup(guildId = ZENITH, guildOptions = {}) {
  const guild = makeGuild(guildId, { roles: gameRoles(), ...guildOptions });
  const client = makeClient([guild]);
  const channel = makeChannel(guild, BOARD_CHANNEL);
  return { guild, client, channel };
}

const reactionPacket = (type, { guildId = ZENITH, channelId = BOARD_CHANNEL, messageId, userId, emoji, member }) => ({
  t: type,
  d: { guild_id: guildId, channel_id: channelId, message_id: messageId, user_id: userId, emoji, ...(member ? { member } : {}) },
});

describe('role boards: resolving roles', () => {
  test('keeps only roles the bot can hand out and says why the others were skipped', () => {
    const guild = makeGuild(ZENITH, {
      roles: [
        makeRole('700000000000000001', 'Rocket League', 10),
        makeRole('700000000000000002', 'Brawl Stars', 9),
        makeRole('700000000000000003', 'Codenames', 8),
        makeRole('700000000000000004', 'Twin', 7),
        makeRole('700000000000000005', 'Twin', 6),
        makeRole('700000000000000006', 'Staff', 5, { permissions: PermissionFlagsBits.BanMembers }),
        makeRole('700000000000000007', 'Some Bot', 4, { managed: true }),
        makeRole('700000000000000008', 'Owner Role', 99),
        makeRole('700000000000000009', 'Pinger', 3, { permissions: PermissionFlagsBits.MentionEveryone }),
        makeRole('700000000000000010', 'Among Us', 2),
      ],
    });
    const { entries, skipped } = resolveBoardEntries(guild, [
      { emoji: '🚀', name: 'rocket league' },
      { emoji: '⭐', name: 'brawl stars' },
      { emoji: '🕵️', name: 'Code names' },
      { emoji: '🎯', name: 'Valorant' }, // no such role in this server
      { emoji: '🧱', roleId: '799999999999999999' }, // deleted role
      { emoji: '👯', name: 'Twin' },
      { emoji: '🛡️', roleId: '700000000000000006' },
      { emoji: '🤖', roleId: '700000000000000007' },
      { emoji: '👑', roleId: '700000000000000008' },
      { emoji: '📢', roleId: '700000000000000009' },
      { emoji: '🌍', roleId: ZENITH },
      { emoji: '🚀', roleId: '700000000000000010' },
      { emoji: '🎲', roleId: '700000000000000001' },
      { emoji: 'not an emoji', roleId: '700000000000000002' },
    ], guild.members.me);

    assert.deepEqual(entries.map((entry) => [entry.emoji, entry.roleId]), [
      ['🚀', '700000000000000001'],
      ['⭐', '700000000000000002'],
      ['🕵️', '700000000000000003'],
    ]);
    assert.deepEqual(skipped.map((item) => item.reason), [
      'missing', 'missing', 'ambiguous', 'dangerous', 'managed', 'above_bot', 'dangerous', 'everyone',
      'duplicate_emoji', 'duplicate_role', 'bad_emoji',
    ]);
  });

  test('a board holds at most 20 roles (Discord reaction limit)', () => {
    const roles = Array.from({ length: 22 }, (_, index) => makeRole(String(710000000000000000n + BigInt(index)), `Game ${index}`, 5));
    const guild = makeGuild(OTHER, { roles });
    const emojis = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒'];
    const { entries, skipped } = resolveBoardEntries(guild, roles.map((role, index) => ({ emoji: emojis[index], roleId: role.id })), guild.members.me);
    assert.equal(entries.length, ROLE_BOARD_MAX_ROLES);
    assert.deepEqual(skipped.map((item) => item.reason), ['limit', 'limit']);
  });

  test('a server emoji the bot cannot see is skipped', () => {
    const guild = makeGuild(ZENITH, { roles: gameRoles() });
    const client = makeClient([guild]);
    client.emojis.cache.set('123456789012345678', {});
    const { entries, skipped } = resolveBoardEntries(guild, [
      { emoji: '<:rl:123456789012345678>', roleId: '700000000000000001' },
      { emoji: '<:gone:223456789012345678>', roleId: '700000000000000002' },
    ], guild.members.me, client);
    assert.deepEqual(entries.map((entry) => entry.roleId), ['700000000000000001']);
    assert.deepEqual(skipped.map((item) => item.reason), ['emoji_unavailable']);
  });

  test('the embed lists only resolved roles and never an unknown role', () => {
    const embed = buildRoleBoardEmbed(gamesBoard([]), [{ emoji: '🚀', roleId: '700000000000000001' }], { name: 'Zenith' });
    assert.match(embed.description, /🚀 ┃ <@&700000000000000001>/);
    assert.doesNotMatch(embed.description, /unknown/i);
    assert.equal(embed.title, '🎮 ┃ Games');
    assert.match(embed.footer.text, /Zenith • 1 رول/);
    assert.ok(embed.description.length <= 4096);
  });
});

describe('role boards: posting', () => {
  test('posts once with one reaction per role, without pinging anyone, and saves the board', async () => {
    const { client, channel } = setup();
    const board = gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '🎯', name: 'Valorant' }, { emoji: '🧱', name: 'Roblox' }, { emoji: '💀', name: 'Deleted Game' }]);
    const result = await publishRoleBoard(client, { channel, board, actorId: SERVER_OWNER_IDS[0] });

    assert.equal(result.status, 'sent');
    assert.equal(channel.sent.length, 1);
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    const message = channel.messages.store.get(result.messageId);
    assert.deepEqual(message.reactOrder, ['🚀', '🎯', '🧱']);
    assert.deepEqual(result.skipped.map((item) => [item.label, item.reason]), [['Deleted Game', 'missing']]);

    const saved = client.db.store.get(getRoleBoardsKey(ZENITH)).boards.games;
    assert.equal(saved.messageId, result.messageId);
    assert.equal(saved.channelId, BOARD_CHANNEL);
    assert.deepEqual(saved.entries, [
      { emoji: '🚀', roleId: '700000000000000001' },
      { emoji: '🎯', roleId: '700000000000000003' },
      { emoji: '🧱', roleId: '700000000000000002' },
    ]);
  });

  test('running it again edits the same message, drops removed lines and stray reactions', async () => {
    const { client, channel } = setup();
    const first = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '🎯', name: 'Valorant' }]) });
    const message = channel.messages.store.get(first.messageId);
    const stray = { emoji: { id: null, name: '😂' }, me: false, removed: false, remove: async () => { stray.removed = true; } };
    message.reactions.cache.set('😂', stray);

    const second = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '🧱', name: 'Roblox' }]) });
    assert.equal(second.status, 'updated');
    assert.equal(second.messageId, first.messageId);
    assert.equal(channel.sent.length, 1, 'no second post');
    assert.equal(stray.removed, true);
    assert.equal(message.reactions.cache.has('🎯'), false, 'the dropped line loses its reaction');
    assert.deepEqual(message.reactOrder, ['🚀', '🎯', '🧱']);
    assert.deepEqual(message.edits.at(-1).allowedMentions, { parse: [] });
    assert.doesNotMatch(message.edits.at(-1).embeds[0].description, /700000000000000003/);
  });

  test('moving the board to another channel posts it there and removes the old copy', async () => {
    const { client, channel, guild } = setup();
    const first = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }]) });
    const newChannel = makeChannel(guild, '1569949365072699999');
    const moved = await publishRoleBoard(client, { channel: newChannel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }]) });
    assert.equal(moved.status, 'sent');
    assert.equal(channel.messages.store.has(first.messageId), false);
    assert.equal(client.db.store.get(getRoleBoardsKey(ZENITH)).boards.games.channelId, '1569949365072699999');
  });

  test('a fetch error on the saved board does not post a second copy', async () => {
    const { client, channel } = setup();
    await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }]) });
    channel.fetchError = Object.assign(new Error('Service Unavailable'), { code: 0 });
    await assert.rejects(publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }]) }), /Service Unavailable/);
    assert.equal(channel.sent.length, 1);
  });

  test('a line whose reaction cannot be added is dropped from the board', async () => {
    const guild = makeGuild(ZENITH, { roles: gameRoles() });
    const client = makeClient([guild]);
    const channel = makeChannel(guild, BOARD_CHANNEL, { failReact: ['🎯'] });
    const result = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '🎯', name: 'Valorant' }]) });
    assert.deepEqual(result.entries.map((entry) => entry.emoji), ['🚀']);
    assert.deepEqual(result.skipped.map((item) => item.reason), ['react_failed']);
    assert.deepEqual(client.db.store.get(getRoleBoardsKey(ZENITH)).boards.games.entries.map((entry) => entry.emoji), ['🚀']);
    const message = channel.messages.store.get(result.messageId);
    assert.doesNotMatch(message.embeds[0].description, /🎯/);
  });

  test('nothing is posted when no role resolves, or when the bot lacks permissions', async () => {
    const { client, channel } = setup();
    const empty = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Not Here' }]) });
    assert.equal(empty.status, 'empty');
    assert.equal(channel.sent.length, 0);

    const guild = makeGuild(OTHER, { roles: gameRoles() });
    const limited = makeChannel(guild, '1569949365072600001', { permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    await assert.rejects(
      publishRoleBoard(makeClient([guild]), { channel: limited, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }]) }),
      (error) => error.missingPermissions.includes('AddReactions') && error.missingPermissions.includes('ManageMessages'),
    );
    assert.equal(limited.sent.length, 0);
  });
});

describe('role boards: reactions', () => {
  async function postedBoard(guildId = ZENITH) {
    const env = setup(guildId);
    const result = await publishRoleBoard(env.client, { channel: env.channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '⚔️', name: 'Valorant' }]) });
    const member = makeMember('600000000000000001');
    env.guild.members.cache.set(member.id, member);
    return { ...env, result, member, messageId: result.messageId };
  }

  test('reacting gives the role and removing the reaction takes it back (in a second server too)', async () => {
    for (const guildId of [ZENITH, OTHER]) {
      const { client, member, messageId } = await postedBoard(guildId);
      const add = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { guildId, messageId, userId: member.id, emoji: { id: null, name: '⚔️' }, member: { user: { id: member.id } } }));
      assert.deepEqual(add, { action: 'added', roleId: '700000000000000003' });
      assert.ok(member.roles.cache.has('700000000000000003'));

      const remove = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_REMOVE', { guildId, messageId, userId: member.id, emoji: { id: null, name: '⚔' } }));
      assert.deepEqual(remove, { action: 'removed', roleId: '700000000000000003' });
      assert.equal(member.roles.cache.has('700000000000000003'), false);
    }
  });

  test('a reaction that is not on the board is removed, and the bot ignores its own reactions', async () => {
    const { client, member, messageId } = await postedBoard();
    const stray = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: member.id, emoji: { id: null, name: '😂' } }));
    assert.equal(stray.action, 'stray_removed');
    assert.deepEqual(client.rest.calls.map((call) => [call.method, call.route]), [
      ['delete', `/channels/${BOARD_CHANNEL}/messages/${messageId}/reactions/${encodeURIComponent('😂')}/${member.id}`],
    ]);
    const own = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: BOT_ID, emoji: { id: null, name: '🚀' } }));
    assert.equal(own.action, 'ignored');
  });

  test('a role deleted while the bot was away is cleaned on the next reaction', async () => {
    const { client, guild, member, messageId } = await postedBoard();
    guild.roles.cache.delete('700000000000000003');
    const result = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: member.id, emoji: { id: null, name: '⚔️' } }));
    assert.equal(result.action, 'pruned');
    assert.equal(member.roles.cache.size, 0);
    assert.deepEqual(client.db.store.get(getRoleBoardsKey(ZENITH)).boards.games.entries.map((entry) => entry.roleId), ['700000000000000001']);
    const reactionDelete = client.rest.calls.find((call) => call.method === 'delete');
    assert.equal(reactionDelete.route, `/channels/${BOARD_CHANNEL}/messages/${messageId}/reactions/${encodeURIComponent('⚔️')}`);
    const edit = client.rest.calls.find((call) => call.method === 'patch');
    assert.doesNotMatch(edit.options.body.embeds[0].description, /700000000000000003/);
    assert.deepEqual(edit.options.body.allowed_mentions, { parse: [] });
  });

  test('a role that became unsafe is not handed out, and a failed add takes the reaction back', async () => {
    const { client, guild, member, messageId } = await postedBoard();
    guild.roles.cache.get('700000000000000001').position = 80;
    const blocked = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: member.id, emoji: { id: null, name: '🚀' } }));
    assert.deepEqual(blocked, { action: 'blocked', reason: 'above_bot' });
    assert.equal(member.roles.cache.size, 0);

    const failing = makeMember('600000000000000002', { failAdd: true });
    guild.members.cache.set(failing.id, failing);
    const failed = await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: failing.id, emoji: { id: null, name: '⚔️' } }));
    assert.equal(failed.action, 'failed');
    assert.ok(client.rest.calls.some((call) => call.method === 'delete' && call.route.endsWith(`/${failing.id}`)));
  });

  test('cleared reactions are put back, and a deleted board message is forgotten', async () => {
    const { client, messageId } = await postedBoard();
    const reseed = await handleRoleBoardPacket(client, { t: 'MESSAGE_REACTION_REMOVE_ALL', d: { guild_id: ZENITH, channel_id: BOARD_CHANNEL, message_id: messageId } });
    assert.deepEqual(reseed, { action: 'reseeded', count: 2 });
    assert.deepEqual(client.rest.calls.map((call) => call.route), [
      `/channels/${BOARD_CHANNEL}/messages/${messageId}/reactions/${encodeURIComponent('🚀')}/@me`,
      `/channels/${BOARD_CHANNEL}/messages/${messageId}/reactions/${encodeURIComponent('⚔️')}/@me`,
    ]);

    const forgotten = await handleRoleBoardPacket(client, { t: 'MESSAGE_DELETE', d: { guild_id: ZENITH, channel_id: BOARD_CHANNEL, id: messageId } });
    assert.deepEqual(forgotten, { action: 'forgotten', count: 1 });
    assert.deepEqual(client.db.store.get(getRoleBoardsKey(ZENITH)).boards, {});
    assert.equal(await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId, userId: '600000000000000001', emoji: { id: null, name: '🚀' } })), null);
  });

  test('unrelated packets are ignored and only one database read is made per server', async () => {
    const guild = makeGuild(ZENITH);
    const client = makeClient([guild]);
    let reads = 0;
    const get = client.db.get;
    client.db.get = async (...args) => { reads += 1; return get(...args); };
    assert.equal(await handleRoleBoardPacket(client, { t: 'TYPING_START', d: { guild_id: ZENITH } }), null);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId: snowflake(), userId: '600000000000000001', emoji: { id: null, name: '🚀' } })), null);
    }
    assert.equal(reads, 1);
  });

  test('the ready event only starts listening (nothing is posted on deploy)', async () => {
    const client = makeClient();
    await roleBoardReady.execute(client, client);
    await roleBoardReady.execute(client, client);
    assert.deepEqual(client.listeners.map((listener) => listener.event), ['raw']);
    assert.equal(registerRoleBoardReactions(client), false);
    assert.deepEqual(client.rest.calls, []);
  });
});

describe('role boards: deleted roles', () => {
  test('deleting a role removes it from emoji boards and from select-menu panels', async () => {
    const { client, guild, channel } = setup();
    const result = await publishRoleBoard(client, { channel, board: gamesBoard([{ emoji: '🚀', name: 'Rocket League' }, { emoji: '🎯', name: 'Valorant' }]) });

    const panel = channel.post({ embeds: [{ title: 'Games', fields: [{ name: 'Available Roles', value: '• <@&700000000000000001>\n• <@&700000000000000003>' }] }] });
    const panelKey = getReactionRoleKey(ZENITH, panel.id);
    await client.db.set(panelKey, { guildId: ZENITH, channelId: BOARD_CHANNEL, messageId: panel.id, roles: ['700000000000000001', '700000000000000003'] });

    const deleted = guild.roles.cache.get('700000000000000003');
    guild.roles.cache.delete(deleted.id); // discord.js removes it from the cache before the event
    await roleDeleteCleanup.execute(Object.assign(deleted, { guild }), client);

    assert.deepEqual(client.db.store.get(getRoleBoardsKey(ZENITH)).boards.games.entries.map((entry) => entry.roleId), ['700000000000000001']);
    assert.ok(client.rest.calls.some((call) => call.method === 'delete' && call.route.includes(`/messages/${result.messageId}/reactions/`)));
    assert.deepEqual(client.db.store.get(panelKey).roles, ['700000000000000001']);
    const panelEdit = panel.edits.at(-1);
    assert.doesNotMatch(JSON.stringify(panelEdit), /700000000000000003/);
    assert.equal(panelEdit.components[0].toJSON().components[0].options.length, 1);
  });

  test('select-menu panels are not pruned while the server roles are not loaded', async () => {
    const guild = makeGuild(OTHER, { roles: gameRoles() });
    const client = makeClient([guild]);
    const panel = { messageId: '1569949365072600002', channelId: BOARD_CHANNEL, roles: ['700000000000000001', '799999999999999999'] };
    guild.roles.cache.clear();
    assert.deepEqual(await pruneMissingPanelRoles(client, guild, { ...panel, roles: [...panel.roles] }), []);
    const loaded = makeGuild(OTHER, { roles: gameRoles() });
    const copy = { ...panel, roles: [...panel.roles] };
    assert.deepEqual(await pruneMissingPanelRoles(client, loaded, copy), ['799999999999999999']);
    assert.deepEqual(copy.roles, ['700000000000000001']);
  });
});

describe('role boards: copying the current board', () => {
  test('reads emoji and role pairs from another bot\'s board', () => {
    const entries = parseBoardMessageEntries({
      content: '',
      embeds: [{
        description: '**games**\n🚀 : <@&700000000000000001>\n<:rb:123456789012345678> Roblox — <@&700000000000000002>\njust text <@&700000000000000009>',
        fields: [{ name: '⚔️ Valorant', value: '<@&700000000000000003>' }],
      }],
    });
    assert.deepEqual(entries, [
      { emoji: '🚀', roleId: '700000000000000001' },
      { emoji: '<:rb:123456789012345678>', roleId: '700000000000000002' },
      { emoji: '⚔️', roleId: '700000000000000003' },
    ]);
  });
});

describe('/publish-board role-boards', () => {
  function interactionFor({ guild, client, channel, userId = SERVER_OWNER_IDS[0], strings = {} }) {
    const replies = [];
    const interaction = {
      user: { id: userId }, guild, client,
      inGuild: () => true,
      memberPermissions: new PermissionsBitField(0n),
      options: {
        getSubcommand: () => 'role-boards',
        getChannel: () => channel,
        getString: (name) => strings[name] ?? null,
      },
      reply: async (payload) => { replies.push({ reply: true, ...payload }); },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async (payload) => { replies.push(payload); },
    };
    return { interaction, replies };
  }

  // Roles named like the configured games, so the test follows the config when the owner edits it.
  function configuredServer(guildId) {
    const games = getRoleBoardConfig('games');
    const roles = games.roles.map((line, index) => makeRole(line.roleId || String(720000000000000000n + BigInt(index)), line.name || `Game ${index}`, 10));
    const guild = makeGuild(guildId, { roles });
    const client = makeClient([guild]);
    for (const line of games.roles) {
      const emoji = parseEmoji(line.emoji);
      if (emoji?.id) client.emojis.cache.set(emoji.id, {}); // server emojis the bot can use
    }
    const channel = makeChannel(guild, BOARD_CHANNEL);
    return { guild, client, channel, games };
  }

  async function withFriends(roles, run) {
    const friends = getRoleBoardConfig('friends');
    const saved = friends.roles;
    friends.roles = roles;
    try { return await run(); } finally { friends.roles = saved; }
  }

  test('only an owner can run it, and nothing is posted for anyone else', async () => {
    const { guild, client, channel } = configuredServer(ZENITH);
    const { interaction, replies } = interactionFor({ guild, client, channel, userId: '600000000000000009' });
    await publishBoardCommand.execute(interaction);
    assert.match(replies[0].content, /للأونر بس/);
    assert.equal(channel.sent.length, 0);
  });

  test('posts the games board and waits for the friends role ids (in a second server too)', async () => {
    for (const guildId of [ZENITH, OTHER]) {
      const { guild, client, channel, games } = configuredServer(guildId);
      const { interaction, replies } = interactionFor({ guild, client, channel });
      await withFriends([], () => publishBoardCommand.execute(interaction));
      assert.equal(channel.sent.length, 1);
      const reply = replies.at(-1).content;
      assert.match(reply, /✅ \*\*🎮 ┃ Games\*\*: اتبعتت/);
      assert.match(reply, /الحبايب.*لسه مفيش رولات/);
      assert.equal(client.db.store.get(getRoleBoardsKey(guildId)).boards.games.entries.length, games.roles.length);
    }
  });

  test('posts both boards as two messages once the friends roles are set', async () => {
    const { guild, client, channel } = configuredServer(ZENITH);
    const friendRoles = [makeRole('730000000000000001', 'Bestie', 5), makeRole('730000000000000002', 'Habibi', 5)];
    for (const role of friendRoles) guild.roles.cache.set(role.id, role);
    const { interaction, replies } = interactionFor({ guild, client, channel });
    await withFriends([{ emoji: '💜', roleId: friendRoles[0].id }, { emoji: '💛', roleId: friendRoles[1].id }], () => publishBoardCommand.execute(interaction));

    assert.equal(channel.sent.length, 2);
    const boards = client.db.store.get(getRoleBoardsKey(ZENITH)).boards;
    assert.notEqual(boards.games.messageId, boards.friends.messageId);
    assert.deepEqual(boards.friends.entries, [{ emoji: '💜', roleId: friendRoles[0].id }, { emoji: '💛', roleId: friendRoles[1].id }]);
    assert.match(replies.at(-1).content, /الحبايب\*\*: اتبعتت/);

    const member = makeMember('600000000000000003');
    guild.members.cache.set(member.id, member);
    await handleRoleBoardPacket(client, reactionPacket('MESSAGE_REACTION_ADD', { messageId: boards.friends.messageId, userId: member.id, emoji: { id: null, name: '💛' } }));
    assert.deepEqual([...member.roles.cache.keys()], [friendRoles[1].id]);
  });

  test('a board that fails does not hide the result of the other one', async () => {
    const { guild, client, channel } = configuredServer(ZENITH);
    const friend = makeRole('730000000000000003', 'Bestie', 5);
    guild.roles.cache.set(friend.id, friend);
    const send = channel.send;
    let calls = 0;
    channel.send = async (payload) => { calls += 1; if (calls === 2) throw new Error('Discord is down'); return send(payload); };
    const { interaction, replies } = interactionFor({ guild, client, channel });
    await withFriends([{ emoji: '💜', roleId: friend.id }], () => publishBoardCommand.execute(interaction));
    const reply = replies.at(-1).content;
    assert.match(reply, /Games\*\*: اتبعتت/);
    assert.match(reply, /الحبايب\*\*: فشل: Discord is down/);
    assert.equal(client.db.store.get(getRoleBoardsKey(ZENITH)).boards.friends, undefined);
  });

  test('games_from keeps the roles and icons of the current board, without the deleted ones', async () => {
    const { guild, client, channel } = configuredServer(OTHER);
    const kept = [...guild.roles.cache.values()].find((role) => role.id !== OTHER);
    const oldChannel = makeChannel(guild, '1569949365072611111');
    const old = oldChannel.post({ embeds: [{ description: `<:rl:123456789012345678> : <@&${kept.id}>\n🧱 : <@&799999999999999999>` }] }, { author: { id: '235148962103951360' } });
    client.emojis.cache.set('123456789012345678', {});
    const link = `https://discord.com/channels/${OTHER}/${oldChannel.id}/${old.id}`;
    const { interaction, replies } = interactionFor({ guild, client, channel, strings: { board: 'games', games_from: link } });
    await publishBoardCommand.execute(interaction);

    assert.deepEqual(client.db.store.get(getRoleBoardsKey(OTHER)).boards.games.entries, [{ emoji: '<:rl:123456789012345678>', roleId: kept.id }]);
    assert.match(replies.at(-1).content, /799999999999999999: الرول مش موجود/);
    assert.equal(old.deleted, false, 'the other bot\'s message is left alone');
  });

  test('a channel from another server is refused', async () => {
    const { guild, client } = configuredServer(ZENITH);
    const foreign = makeChannel(makeGuild(OTHER), BOARD_CHANNEL);
    const { interaction, replies } = interactionFor({ guild, client, channel: foreign });
    await publishBoardCommand.execute(interaction);
    assert.match(replies.at(-1).content, /الروم لازم تكون في السيرفر ده/);
    assert.equal(foreign.sent.length, 0);
  });
});

describe('role boards config', () => {
  test('every configured line is valid, and no role id is made up', () => {
    for (const board of ROLE_BOARDS) {
      assert.ok(board.key && board.title, 'board needs a key and a title');
      assert.ok(board.roles.length <= ROLE_BOARD_MAX_ROLES, board.key);
      for (const line of board.roles) {
        assert.ok(parseEmoji(line.emoji), `${board.key}: bad emoji ${line.emoji}`);
        assert.ok(line.roleId ? /^\d{17,20}$/.test(line.roleId) : Boolean(line.name), `${board.key}: needs a role id or a name`);
      }
    }
    assert.ok(getRoleBoardConfig('games').roles.length > 0);
    assert.ok(getRoleBoardConfig('friends'), 'the friends board slot exists');
  });

  test('loading boards for a server with none returns an empty set', async () => {
    assert.deepEqual(await loadGuildBoards(makeClient(), OTHER), {});
  });
});

describe('GH #326: a copied board with emojis the bot cannot see', () => {
  test('swaps them for usable emojis (same-named default first), keeps visible ones', async () => {
    const { withUsableEmojis } = await import('../src/commands/Core/modules/roleBoardsCommand.js');
    for (const guildId of ['1569932761471524874', '1155236281706627173']) {
      const roles = new Map([
        ['r1', { id: 'r1', name: '^ Rocket League ,' }],
        ['r2', { id: 'r2', name: 'Some New Game' }],
        ['r3', { id: 'r3', name: 'Roblox' }],
      ]);
      const guild = { id: guildId, roles: { cache: roles } };
      const client = { emojis: { cache: new Map([['111', {}]]) } };
      const out = withUsableEmojis(client, guild, [
        { emoji: '<:rl:999>', roleId: 'r1' },
        { emoji: '<:new:998>', roleId: 'r2' },
        { emoji: '<:rb:111>', roleId: 'r3' },
      ]);
      assert.equal(out[0].emoji, '🚀');
      assert.ok(out[1].emoji && !out[1].emoji.startsWith('<'));
      assert.notEqual(out[1].emoji, out[0].emoji);
      assert.equal(out[2].emoji, '<:rb:111>');
    }
  });
});
