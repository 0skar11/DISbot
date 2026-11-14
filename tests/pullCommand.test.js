import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { pullToVoice } from '../src/utils/arabicModerationShortcuts.js';

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

  test('without the permission it stays silent and moves nobody', async () => {
    const { message, target, sent, moved } = setup({ staffPerms: [] });
    await pullToVoice(message, target);
    assert.equal(moved.length, 0);
    assert.equal(sent.length, 0);
  });

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

  test('a member of an equal or higher role, or the server owner, can not be pulled by a lower staff member', async () => {
    for (const options of [{ targetPos: 10 }, { targetPos: 20 }, { targetOwner: true }]) {
      const { message, target, sent, moved } = setup(options);
      await pullToVoice(message, target);
      assert.equal(moved.length, 0);
      assert.match(sent[0].content, /رتبته أعلى/u);
    }
  });

  test('the staff member needs their own rights on both rooms and the member must be allowed into the room', async () => {
    const deny = (...denied) => ({ permissionsFor: () => ({ has: (flag) => ![].concat(flag).some((f) => denied.includes(f)) }) });
    // No Move Members on the room the member is in: silent, nobody moved.
    let s = setup();
    s.target.voice.channel = { id: 'B', ...deny(PermissionFlagsBits.MoveMembers) };
    await pullToVoice(s.message, s.target);
    assert.equal(s.moved.length, 0);
    assert.equal(s.sent.length, 0);
    // The staff member can't connect to their own target room (e.g. a stale room): refused.
    s = setup({ staffRoom: { id: 'A', ...deny(PermissionFlagsBits.Connect) } });
    await pullToVoice(s.message, s.target);
    assert.equal(s.moved.length, 0);
    // The member is denied the room: refused with a message.
    const room = { id: 'A', permissionsFor: (who) => ({ has: () => who.id !== '222222222222222222' }) };
    s = setup({ staffRoom: room });
    await pullToVoice(s.message, s.target);
    assert.equal(s.moved.length, 0);
    assert.match(s.sent[0].content, /ممنوع/u);
  });
});
