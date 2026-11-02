import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceEmbed, formatDuration } from '../src/events/dedicatedVoiceAuditLog.js';

const member = { id: '10', user: { username: 'duck' }, guild: { id: '1155236281706627173' }, toString: () => '<@10>', displayAvatarURL: () => 'x' };
const room = (id, size = 1) => ({ id, members: { size }, toString: () => `<#${id}>` });
const state = (channel) => ({ member, channel, channelId: channel?.id ?? null });

describe('voice log cards', () => {
  test('formats durations like 4m 36s', () => {
    assert.equal(formatDuration(276000), '4m 36s');
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(3723000), '1h 2m 3s');
  });

  test('join, switch with duration, then leave', () => {
    const a = room('a', 3);
    const b = room('b');
    const join = buildVoiceEmbed(state(null), state(a), 0);
    assert.equal(join.title, '🎙️ Joined Voice Channel');
    assert.equal(join.fields[2].value, '3');
    const sw = buildVoiceEmbed(state(a), state(b), 276000);
    assert.equal(sw.title, '🔀 Switched Voice Channels');
    assert.equal(sw.fields.find((f) => f.name === 'Duration in Previous Channel').value, '`4m 36s`');
    const left = buildVoiceEmbed(state(b), state(null), 280000);
    assert.equal(left.title, '🚪 Left Voice Channel');
    assert.match(left.fields.at(-1).value, /4s/);
  });

  test('a mute change is not a card', () => {
    const a = room('a');
    assert.equal(buildVoiceEmbed(state(a), state(a), 0), null);
  });
});
