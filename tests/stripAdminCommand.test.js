import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import stripAdminCommand from '../src/commands/Utility/stripadmin.js';
import publishBoardCommand from '../src/commands/Core/publish-board.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

describe('stripadmin command (Report #302)', () => {
  const makeRole = (id, name, position, permissions, managed = false) => {
    const role = {
      id, name, position, managed,
      permissions: new PermissionsBitField(permissions),
      setPermissions: async (bits) => { role.permissions = new PermissionsBitField(bits); return role; },
    };
    return role;
  };

  test('only server owners or guild owner can run stripadmin', async () => {
    let replyPayload = null;
    const interaction = {
      id: 'int-1',
      user: { id: 'random-user' },
      guild: { id: 'g1', ownerId: 'guild-owner' },
      inGuild: () => true,
      deferReply: async () => {},
      reply: async (payload) => { replyPayload = payload; },
    };

    await stripAdminCommand.execute(interaction);
    assert.match(replyPayload.content, /للأونر بس/);
  });

  test('server owner execution strips administrator and replies with changed roles', async () => {
    const roles = [
      makeRole('0', '👑 Owner', 10, PermissionFlagsBits.Administrator),
      makeRole('1', 'Co-Admin', 8, PermissionFlagsBits.Administrator),
      makeRole('2', 'Moderator', 7, PermissionFlagsBits.Administrator),
    ];
    let editReplyPayload = null;
    let deferred = false;
    const store = new Map();
    const interaction = {
      id: 'int-2',
      user: { id: SERVER_OWNER_IDS[0] },
      guild: {
        id: '1569932761471524874', // Zenith
        ownerId: 'guild-owner',
        client: { db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, val) => { store.set(key, val); return true; } } },
        members: { me: { roles: { highest: { position: 9 } } } },
        roles: { fetch: async () => Object.assign(new Map(roles.map((r) => [r.id, r])), { find: (fn) => roles.find(fn) }) },
      },
      inGuild: () => true,
      deferReply: async () => { interaction.deferred = true; deferred = true; },
      editReply: async (payload) => { editReplyPayload = payload; },
      reply: async (payload) => { editReplyPayload = payload; },
    };

    await stripAdminCommand.execute(interaction);
    assert.ok(deferred);
    assert.match(editReplyPayload.content, /Co-Admin/);
    assert.match(editReplyPayload.content, /Moderator/);
    // 👑 Owner kept Administrator
    assert.ok(roles[0].permissions.has(PermissionFlagsBits.Administrator, false));
    // Others stripped
    assert.equal(roles[1].permissions.has(PermissionFlagsBits.Administrator, false), false);
    assert.equal(roles[2].permissions.has(PermissionFlagsBits.Administrator, false), false);
  });

  test('publish-board strip-admin subcommand executes demotion', async () => {
    const roles = [
      makeRole('1', 'Manager', 5, PermissionFlagsBits.Administrator),
    ];
    let deferred = false;
    let editReplyPayload = null;
    const store = new Map();
    const interaction = {
      id: 'int-3',
      user: { id: SERVER_OWNER_IDS[0] },
      inGuild: () => true,
      memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
      options: { getSubcommand: () => 'strip-admin' },
      guild: {
        id: '1569932761471524874',
        ownerId: 'guild-owner',
        client: { db: { get: async (k, fb) => (store.has(k) ? store.get(k) : fb), set: async (k, v) => { store.set(k, v); return true; } } },
        members: { me: { roles: { highest: { position: 8 } } } },
        roles: { fetch: async () => Object.assign(new Map(roles.map((r) => [r.id, r])), { find: (fn) => roles.find(fn) }) },
      },
      deferReply: async () => { interaction.deferred = true; deferred = true; },
      editReply: async (payload) => { editReplyPayload = payload; },
    };

    await publishBoardCommand.execute(interaction);
    assert.ok(deferred);
    assert.match(editReplyPayload.content, /Manager/);
    assert.equal(roles[0].permissions.has(PermissionFlagsBits.Administrator, false), false);
  });
});
