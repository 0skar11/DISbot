import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLevelingEnabled, ZENITH_GUILD_ID, HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { handleMessageXp } from '../src/services/leveling/messageXp.js';

test('own XP is off in Zenith only', () => {
  assert.equal(ownLevelingEnabled(ZENITH_GUILD_ID), false);
  assert.equal(ownLevelingEnabled(HOME_GUILD_ID), true);
  assert.equal(ownLevelingEnabled('999'), true);
});

test('a chat message in Zenith never reaches the XP config', async () => {
  let touched = false;
  const client = { get db() { touched = true; return {}; } };
  await handleMessageXp({ member: {}, guild: { id: ZENITH_GUILD_ID }, author: { id: '1' }, channel: { id: '2' } }, client);
  assert.equal(touched, false);
});
