import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { handlePullMeShortcut, pullToVoice } from '../src/utils/arabicModerationShortcuts.js';

const perms = (...flags) => new PermissionsBitField(flags);
function setup({ staffPerms = [PermissionFlagsBits.MoveMembers], staffRoom = { id: 'A', toString: () => '<#A>' }, targetRoomId = 'B', staffPos = 10, targetPos = 3, targetOwner = false } = {}) {
  const sent = [];
  const moved = [];
  const target = {
    id: '222222222222222222',
    voice: { channel: targetRoomId ? { id: targetRoomId } : null, channelId: targetRoomId, setChannel: async (room, reason) => moved.push([room.id, reason]) },
    roles: { highest: { position: targetPos } },
  };
  const guild = { id: 'g', ownerId: targetOwner ? target.id : '999999999999999999' };
  const staff = { id: '111111111111111111', guild, permissions: perms(...staffPerms), voice: { channel: staffRoom }, roles: { highest: { position: staffPos } } };
  const message = { member: staff, author: { id: staff.id, tag: 'staff#0001' }, guild, channel: { send: async (payload) => { sent.push(payload); return { delete: async () => {} }; } } };
  return { message, target, sent, moved };
}

describe('سحب (pull to your voice room)', () => {
  test('staff with Move Members pulls a lower member into their room', async () => {
    const { message, target, sent, moved } = setup();
    await pullToVoice(message, target);
    assert.deepEqual(moved.map(([room]) => room), ['A']);
    assert.match(sent[0].content, /تم سحب <@222222222222222222>/u);
  });

  test('only the target can accept a one-use pull request', async () => {
    const s = setup({ staffPerms: [], staffRoom: { id: 'A', permissionsFor: () => perms(PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel) } });
    let resolveDecision;
    let filter;
    const edited = [];
    s.message.guild.members = { fetch: async ({ user }) => user === s.target.id ? s.target : s.message.member };
    s.message.channel.send = async (payload) => {
      s.sent.push(payload);
      return {
        awaitMessageComponent: (options) => {
          filter = options.filter;
          return new Promise(resolve => { resolveDecision = resolve; });
        },
        edit: async (payload) => edited.push(payload),
      };
    };
    assert.equal(await pullToVoice(s.message, s.target), true);
    assert.deepEqual(s.sent[0].allowedMentions.users, [s.target.id]);
    assert.equal(filter({ customId: 'voice-pull:accept', user: s.message.author }), false);
    assert.equal(filter({ customId: 'voice-pull:accept', user: s.target }), true);
    assert.deepEqual(s.moved, []);
    resolveDecision({ customId: 'voice-pull:accept', deferUpdate: async () => {} });
    await new Promise(setImmediate);
    assert.deepEqual(s.moved.map(([room]) => room), ['A']);
    assert.deepEqual(edited[0].components, []);
  });

  for (const outcome of ['decline', 'timeout', 'room changed', 'access revoked']) {
    test(`a pull request never moves anyone after ${outcome}`, async () => {
      let canConnect = true;
      const room = { id: 'A', permissionsFor: () => ({ has: () => canConnect }) };
      const s = setup({ staffPerms: [], staffRoom: room });
      const edited = [];
      s.message.guild.members = { fetch: async ({ user }) => user === s.target.id ? s.target : s.message.member };
      s.message.channel.send = async () => ({
        awaitMessageComponent: async () => {
          if (outcome === 'timeout') throw new Error('Collector ended');
          if (outcome === 'room changed') s.message.member.voice.channel = { ...room, id: 'C' };
          if (outcome === 'access revoked') canConnect = false;
          return { customId: outcome === 'decline' ? 'voice-pull:decline' : 'voice-pull:accept', deferUpdate: async () => {} };
        },
        edit: async (payload) => edited.push(payload),
      });
      await pullToVoice(s.message, s.target);
      await new Promise(setImmediate);
      assert.deepEqual(s.moved, []);
      assert.deepEqual(edited[0].components, []);
    });
  }

  test('the staff member must be in a voice room and the target too, and not already together', async () => {
    let s = setup({ staffRoom: null });
    await pullToVoice(s.message, s.target);
    assert.match(s.sent[0].content, /ادخل روم صوتي/u);
    s = setup({ targetRoomId: null });
    await pullToVoice(s.message, s.target);
    assert.match(s.sent[0].content, /مش في روم صوتي/u);
    s = setup({ targetRoomId: 'A' });
    await pullToVoice(s.message, s.target);
    assert.match(s.sent[0].content, /نفس الروم/u);
    for (const x of [s]) assert.equal(x.moved.length, 0);
  });

  test('a member of an equal or higher role, or the server owner, can be pulled by any staff member with Move Members (GH-311)', async () => {
    for (const options of [{ targetPos: 10 }, { targetPos: 20 }, { targetOwner: true }]) {
      const { message, target, sent, moved } = setup(options);
      await pullToVoice(message, target);
      assert.equal(moved.length, 1);
      assert.match(sent[0].content, /تم سحب/u);
    }
  });

  test('staff can pull from any voice room, even if locked / denied MoveMembers (GH-304)', async () => {
    const deny = (...denied) => ({ permissionsFor: () => ({ has: (flag) => ![].concat(flag).some((f) => denied.includes(f)) }) });
    // Locked room: member is in room B where Move Members / ViewChannel is denied. Staff pulls them to A anyway!
    let s = setup();
    s.target.voice.channel = { id: 'B', ...deny(PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ViewChannel) };
    await pullToVoice(s.message, s.target);
    assert.deepEqual(s.moved.map(([room]) => room), ['A']);
    assert.match(s.sent[0].content, /تم سحب <@222222222222222222>/u);

    // The staff member can't connect to their own target room (e.g. a stale room): refused.
    s = setup({ staffRoom: { id: 'A', ...deny(PermissionFlagsBits.Connect) } });
    await pullToVoice(s.message, s.target);
    assert.equal(s.moved.length, 0);

    // The pulled member being denied the room does not matter: staff may bring anyone anywhere.
    const room = { id: 'A', permissionsFor: (who) => ({ has: () => who.id !== '222222222222222222' }) };
    s = setup({ staffRoom: room });
    await pullToVoice(s.message, s.target);
    assert.deepEqual(s.moved.map(([id]) => id), ['A']);
  });
});

describe('typed `سحب` / `pull` reaches the command', () => {
  test('with a mention it pulls; without a target the word stays ordinary chat', async () => {
    const { handlePullShortcut } = await import('../src/utils/arabicModerationShortcuts.js');
    const s = setup();
    s.message.guild.members = { fetch: async (id) => (id === '222222222222222222' ? s.target : null) };
    assert.equal(await handlePullShortcut(s.message, ['<@222222222222222222>']), true);
    assert.deepEqual(s.moved.map(([room]) => room), ['A']);
    const chat = setup();
    chat.message.guild.members = { fetch: async () => null };
    assert.equal(await handlePullShortcut(chat.message, ['اللعبة', 'دي']), false);
    assert.equal(chat.moved.length, 0);
    // The id of a member who is not in the server: handled (an error line), nobody moved.
    assert.equal(await handlePullShortcut(chat.message, ['333333333333333333']), true);
    assert.equal(chat.moved.length, 0);
  });

  test('messageCreate sends `سحب` and `pull` to it', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/events/messageCreate.js', import.meta.url), 'utf8');
    assert.match(source, /typedCommand === 'سحب' \|\| typedCommand === 'pull'\) && await handlePullShortcut/u);
  });
});

describe('اسحبني requires consent from the mentioned member', () => {
  async function run({ allowed = true, full = false, sameRoom = false, connected = true, staffPerms = [], args = ['<@222222222222222222>'] } = {}) {
    const s = setup({ staffPerms, staffRoom: connected ? { id: sameRoom ? 'B' : 'A' } : null });
    const moved = [];
    const edits = [];
    let finish;
    let reject;
    let filter;
    s.message.member.voice.setChannel = async room => { moved.push(room.id); };
    s.message.guild.members = { fetch: async id => (id?.user ?? id) === s.message.author.id ? s.message.member : s.target };
    s.message.channel.send = async payload => {
      s.sent.push(payload);
      return {
        awaitMessageComponent: options => {
          filter = options.filter;
          return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
        },
        edit: async payload => { edits.push(payload); },
      };
    };
    const room = s.target.voice.channel;
    room.permissionsFor = member => {
      assert.equal(member.id, s.message.author.id);
      return { has: flags => allowed && flags.includes(PermissionFlagsBits.ViewChannel) && flags.includes(PermissionFlagsBits.Connect) };
    };
    if (full) Object.assign(room, { userLimit: 1, members: new Map([[s.target.id, s.target]]) });
    const handled = await handlePullMeShortcut(s.message, args);
    return { ...s, handled, requesterMoves: moved, room, edits, finish, reject, filter };
  }

  for (const staffPerms of [[], [PermissionFlagsBits.Administrator]]) {
    test(`waits for the target's approval with permissions ${staffPerms}`, async () => {
      const s = await run({ staffPerms });
      assert.equal(s.handled, true);
      assert.deepEqual(s.requesterMoves, []);
      assert.equal(s.filter({ customId: 'voice-pull:accept', user: s.message.author }), false);
      assert.equal(s.filter({ customId: 'voice-pull:accept', user: s.target }), true);
      s.finish({ customId: 'voice-pull:accept', deferUpdate: async () => {} });
      await new Promise(setImmediate);
      assert.deepEqual(s.requesterMoves, ['B']);
      assert.deepEqual(s.moved, [], 'the mentioned member never moves');
      assert.deepEqual(s.edits[0].components, []);
    });
  }

  test('a full room does not stop the pull: the request is sent and the requester moves after acceptance (GH-319)', async () => {
    const s = await run({ full: true });
    assert.equal(s.handled, true);
    assert.equal(s.sent.length, 1, 'the approval request is sent');
    s.finish({ customId: 'voice-pull:accept', deferUpdate: async () => {} });
    await new Promise(setImmediate);
    assert.deepEqual(s.requesterMoves, ['B']);
    assert.match(s.edits[0].content, /✅/u);
  });

  test('a room that fills up while waiting still lets the accepted pull through (GH-319)', async () => {
    const s = await run();
    Object.assign(s.room, { userLimit: 1, members: new Map([[s.target.id, s.target]]) });
    s.finish({ customId: 'voice-pull:accept', deferUpdate: async () => {} });
    await new Promise(setImmediate);
    assert.deepEqual(s.requesterMoves, ['B']);
  });

  for (const outcome of ['decline', 'timeout', 'target leaves']) {
    test(`does not move the requester after ${outcome}`, async () => {
      const s = await run();
      if (outcome === 'target leaves') s.target.voice.channel = null;
      if (outcome === 'timeout') s.reject(new Error('Collector ended'));
      else s.finish({ customId: outcome === 'decline' ? 'voice-pull:decline' : 'voice-pull:accept', deferUpdate: async () => {} });
      await new Promise(setImmediate);
      assert.deepEqual(s.requesterMoves, []);
      assert.deepEqual(s.moved, []);
      assert.deepEqual(s.edits[0].components, []);
    });
  }

  test('respects locked rooms and requires a distinct active voice room', async () => {
    for (const options of [{ allowed: false }, { sameRoom: true }, { connected: false }]) {
      const s = await run(options);
      assert.equal(s.finish, undefined);
      assert.deepEqual(s.requesterMoves, []);
    }
  });

  test('leaves normal chat alone', async () => {
    const result = await run({ args: ['معاك'] });
    assert.equal(result.handled, false);
    assert.deepEqual(result.sent, []);
  });
});
