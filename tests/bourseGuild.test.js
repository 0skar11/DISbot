import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { BOURSE_GUILD_ID, isBourseGuild, isBourseGuildCommand, managedGuilds, BOURSE_GUILD_NOTICE } from '../src/config/bourseGuild.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import interactionCreate from '../src/events/interactionCreate.js';
import messageCreate from '../src/events/messageCreate.js';
import loadEvents from '../src/handlers/loaders/events.js';

// The bourse-only server: the bourse and its CC balance / board, nothing else.
function slash(guildId, commandName) {
  const replies = [];
  return {
    replies,
    guildId,
    commandName,
    user: { id: '200000000000000001', tag: 'u' },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isRepliable: () => true,
    reply: async (payload) => { replies.push(payload); },
  };
}

describe('bourse-only server', () => {
  test('only the bourse commands are allowed, and only that guild is recognised', () => {
    assert.equal(isBourseGuild(BOURSE_GUILD_ID), true);
    assert.equal(isBourseGuild(HOME_GUILD_ID), false);
    for (const name of ['bourse', 'cc', 'cctop']) assert.equal(isBourseGuildCommand(name), true, name);
    for (const name of ['ban', 'timeout', 'role', 'store', 'addcc', 'setup', 'purge']) assert.equal(isBourseGuildCommand(name), false, name);
  });

  test('startup jobs and timers skip it', () => {
    const client = { guilds: { cache: new Collection([[BOURSE_GUILD_ID, { id: BOURSE_GUILD_ID }], [HOME_GUILD_ID, { id: HOME_GUILD_ID }]]) } };
    assert.deepEqual(managedGuilds(client).map((guild) => guild.id), [HOME_GUILD_ID]);
  });

  test('an admin slash command there gets "not available" and never reaches the command', async () => {
    const interaction = slash(BOURSE_GUILD_ID, 'ban');
    const client = { commands: { get: () => assert.fail('the command must not be looked up') } };
    await interactionCreate.execute(interaction, client);
    assert.equal(interaction.replies.length, 1);
    assert.equal(interaction.replies[0].content, BOURSE_GUILD_NOTICE);
  });

  test('buttons other than the bourse ones and every select menu / modal are refused there', async () => {
    const button = { ...slash(BOURSE_GUILD_ID, null), isChatInputCommand: () => false, isButton: () => true, customId: 'store_panel:x' };
    await interactionCreate.execute(button, { buttons: { get: () => assert.fail('no handler lookup') } });
    assert.equal(button.replies[0].content, BOURSE_GUILD_NOTICE);
    const modal = { ...slash(BOURSE_GUILD_ID, null), isChatInputCommand: () => false, isModalSubmit: () => true, customId: 'x:1' };
    await interactionCreate.execute(modal, { modals: { get: () => assert.fail('no handler lookup') } });
    assert.equal(modal.replies[0].content, BOURSE_GUILD_NOTICE);
  });

  test('a typed admin command there does nothing (no reply, no moderation, no XP)', async () => {
    const sent = [];
    const message = {
      guild: { id: BOURSE_GUILD_ID },
      guildId: BOURSE_GUILD_ID,
      channelId: '1',
      content: 'ban @someone',
      author: { id: '200000000000000001', bot: false },
      channel: { id: '1', send: async (payload) => { sent.push(payload); } },
    };
    const client = { commands: new Collection([['ban', { data: { name: 'ban', toJSON: () => ({}) }, execute: async () => assert.fail('ran') }]]) };
    await messageCreate.execute(message, client);
    assert.deepEqual(sent, []);
  });

  test('other events (member joins, role changes, logging...) are dropped for it before they run', async () => {
    const handlers = new Map();
    await loadEvents({ on: (name, fn) => handlers.set(name, fn), once: (name, fn) => handlers.set(name, fn) });
    const touched = [];
    const member = new Proxy({ guild: { id: BOURSE_GUILD_ID } }, {
      get: (target, key) => { if (!(key in target)) touched.push(String(key)); return target[key]; },
    });
    await handlers.get('guildMemberAdd')(member);
    assert.deepEqual(touched, []);
  });
});
