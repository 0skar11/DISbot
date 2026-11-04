import { test, describe } from 'node:test';
import './helpers/enableBourse.js';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { adjustCC, getProfile } from '../src/services/cc/ccService.js';
import { invest } from '../src/services/cc/bourseService.js';
import { resetAllCC, handleResetCcCommand } from '../src/services/cc/ccResetService.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';
import buttons from '../src/interactions/buttons/ccreset/resetcc.js';

const A = '200000000000000001';
const B = '200000000000000002';

function fakeClient() {
  const store = new Map();
  return { store, db: {
    get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    list: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)),
  } };
}

describe('resetcc: everyone back to 0', () => {
  test('balances and bourse holdings are cleared for every member, in every server', async () => {
    const client = fakeClient();
    await adjustCC(client, HOME_GUILD_ID, A, 50_000, 'staff');
    await adjustCC(client, HOME_GUILD_ID, B, 700, 'staff');
    assert.equal((await invest(client, '100000000000000099', A, 'car', 1, { now: Date.UTC(2026, 8, 25, 17, 20), rng: () => 0.5 })).ok, true);
    const result = await resetAllCC(client);
    assert.equal(result.members, 2);
    assert.equal(result.holdings, 1);
    for (const guild of [HOME_GUILD_ID, '100000000000000099']) {
      for (const user of [A, B]) assert.equal((await getProfile(client, guild, user)).cc, 0);
    }
    assert.deepEqual(client.store.get(`guild:${HOME_GUILD_ID}:economy:${A}`).ccBourse, {});
  });

  test('only the owner, only in our server, and only after Confirm', async () => {
    const sent = [];
    const message = (guildId, authorId) => ({ guild: { id: guildId }, author: { id: authorId }, channel: { send: async (payload) => { sent.push(payload); } } });
    const [owner] = SERVER_OWNER_IDS;
    if (owner) {
      assert.equal(await handleResetCcCommand(message('100000000000000099', owner)), false);
      assert.equal(await handleResetCcCommand(message(HOME_GUILD_ID, A)), false);
      assert.equal(await handleResetCcCommand(message(HOME_GUILD_ID, owner)), true);
      assert.equal(sent.length, 1);
      assert.match(sent[0].components[0].toJSON().components[0].custom_id, /^resetcc_confirm:/);
    }
    const replies = [];
    const confirm = buttons.find((button) => button.name === 'resetcc_confirm');
    await confirm.execute({
      inGuild: () => true, guildId: HOME_GUILD_ID, user: { id: A }, reply: async (payload) => { replies.push(payload); },
    }, fakeClient(), [A, String(Date.now() + 60_000)]);
    assert.match(replies[0].content, /للأونر/u);
  });
});
