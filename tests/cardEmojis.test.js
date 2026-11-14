import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { CARD_EMOJI, removeCardEmojis } from '../src/services/serverEmojiService.js';

const emoji = (name, log) => ({ name, delete: async () => { log.push(name); } });
const guild = (id, names, log) => ({ id, members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All) } }, emojis: { fetch: async () => new Map(names.map((n, i) => [String(i), emoji(n, log)])) } });

describe('card emojis', () => {
  test('only the 53 card names match', () => {
    for (const name of ['cc_2S', 'cc_10H', 'cc_AC', 'cc_back']) assert.ok(CARD_EMOJI.test(name), name);
    for (const name of ['cc_1S', 'cc_11H', 'cc_chicken_car', 'smile', 'cc_AX']) assert.ok(!CARD_EMOJI.test(name), name);
  });

  test('other servers lose their card emojis and nothing else; the home server keeps them', async () => {
    const log = [];
    const zenith = guild('1569932761471524874', ['cc_AH', 'cc_back', 'peepo', 'cc_10S'], log);
    assert.deepEqual(await removeCardEmojis(zenith), { skipped: false, removed: 3 });
    assert.deepEqual(log, ['cc_AH', 'cc_back', 'cc_10S']);
    const homeLog = [];
    assert.deepEqual(await removeCardEmojis(guild('1155236281706627173', ['cc_AH'], homeLog)), { skipped: true, removed: 0 });
    assert.deepEqual(homeLog, []);
  });
});
