import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import '../src/utils/embeds.js';
import { publishStaffPermissionBoard, buildGenericBoardEmbeds, ROLE_DEFINITIONS } from '../src/services/staffRoleHierarchyService.js';

const FOOTER = 'Staff permissions • Anti-Raid / Anti-Nuke administration';
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const bot = { id: 'bot' };
  const messages = new Map();
  const edits = [];
  let seq = 0;
  const post = ({ author = bot, embeds = [], createdTimestamp = Date.now() }) => {
    const id = String(++seq);
    const message = {
      id, author, createdTimestamp, embeds,
      edit: async (payload) => { edits.push(payload); message.embeds = payload.embeds; },
      delete: async () => messages.delete(id),
    };
    messages.set(id, message);
    return message;
  };
  const snapshot = () => {
    const copy = new Map([...messages].slice(0, 100));
    copy.filter = (fn) => { const result = new Map([...copy].filter(([, value]) => fn(value))); result.filter = copy.filter; return result; };
    return copy;
  };

  const client = { user: bot };
  const channel = {
    client, guild: { id: 'g' }, isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    messages: { fetch: async (arg) => (typeof arg === 'string' ? messages.get(arg) || null : snapshot()) },
    send: async ({ embeds }) => post({ embeds }),
    bulkDelete: async (ids) => {
      const removed = new Map(ids.filter((id) => messages.has(id)).map((id) => [id, messages.get(id)]));
      for (const id of removed.keys()) messages.delete(id);
      return removed;
    },
  };
  const roles = new Map(ROLE_DEFINITIONS.map((definition, index) => [String(index), {
    name: definition.name, managed: false, permissions: new PermissionsBitField(definition.permissions), toString: () => `<@&${index}>`,
  }]));
  roles.find = (fn) => [...roles.values()].find(fn);
  const guild = { id: '1155236281706627173', client, channels: { fetch: async () => channel }, members: { me: {} }, roles: { fetch: async () => roles } };
  return { guild, messages, post, edits, bot };
}

describe('staff permission board', () => {
  test('reset clears every message (old, members and the bot) and posts one board message', async () => {
    const { guild, messages, post, bot } = setup();
    post({ author: { id: 'member' } });
    post({ author: bot, createdTimestamp: Date.now() - 30 * DAY, embeds: [{ title: 'Admin — الصلاحيات', footer: { text: FOOTER } }] });
    for (let i = 0; i < 120; i += 1) post({ author: bot });

    const result = await publishStaffPermissionBoard(guild, { reset: true });
    assert.equal(result.status, 'sent');
    assert.equal(result.deleted, 122);
    assert.equal(messages.size, 1);
    const [board] = messages.values();
    assert.equal(board.embeds.length, ROLE_DEFINITIONS.length);
    // The footer identifies the board for later edits, so it must survive src/utils/embeds.js.
    assert.ok(board.embeds.every((embed) => embed.footer?.text === FOOTER));
    assert.ok(board.embeds[0].title.startsWith('👑'));
    const size = board.embeds.reduce((total, embed) => total + embed.title.length + embed.description.length + embed.footer.text.length, 0);
    assert.ok(size < 6000, `board is ${size} characters, Discord allows 6000 per message`);
  });

  test('without reset the board is edited and nothing is ever posted', async () => {
    const { guild, messages, edits } = setup();
    await publishStaffPermissionBoard(guild, { reset: true });
    const result = await publishStaffPermissionBoard(guild);
    assert.equal(result.status, 'updated');
    assert.equal(edits.length, 1);
    assert.equal(messages.size, 1);
  });

  test('a missing board is not re-posted in the home server', async () => {
    const { guild, messages, post } = setup();
    guild.id = '1155236281706627173';
    post({ author: { id: 'member' } });
    assert.equal((await publishStaffPermissionBoard(guild)).status, 'missing');
    assert.equal(messages.size, 1);
  });

  test('another server gets its board posted once, in its own room', async () => {
    const { guild, messages, post } = setup();
    guild.id = '1569932761471524874';
    let fetched = null;
    const channel = await guild.channels.fetch();
    guild.channels.fetch = async (id) => { fetched = id; return channel; };
    post({ author: { id: 'member' } });
    assert.equal((await publishStaffPermissionBoard(guild)).status, 'sent');
    assert.equal(fetched, '1571076213705809941');
    assert.equal(messages.size, 2);
    assert.equal((await publishStaffPermissionBoard(guild)).status, 'updated');
    assert.equal(messages.size, 2);
  });

  test('other servers get a board of their own powerful roles, top first, without bots or plain roles', () => {
    const perms = (...flags) => new PermissionsBitField(flags);
    const roles = new Map([
      ['1', { name: 'plain', position: 1, managed: false, permissions: perms('SendMessages') }],
      ['2', { name: 'mod', position: 5, managed: false, color: 0x2ecc71, permissions: perms('BanMembers', 'ModerateMembers') }],
      ['3', { name: 'boss', position: 9, managed: false, permissions: perms('Administrator') }],
      ['4', { name: 'robot', position: 8, managed: true, permissions: perms('Administrator') }],
    ]);
    const embeds = buildGenericBoardEmbeds(roles);
    assert.deepEqual(embeds.map((embed) => embed.title), ['boss', 'mod']);
    assert.match(embeds[0].description, /Administrator/);
    assert.match(embeds[1].description, /Ban Members/);
  });
});
