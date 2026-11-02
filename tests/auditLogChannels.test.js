import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { ensureAuditLogChannels, getAuditLogChannelId, AUDIT_LOG_CATEGORY_ID } from '../src/services/auditLogChannelsService.js';
import { logger } from '../src/utils/logger.js';

function setup(t, config = {}, rooms = [], fetched = null) {
  const original = structuredClone(config);
  const mutations = t.mock.fn();
  const fetch = t.mock.fn(async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched;
  });
  const guild = {
    id: '1155236281706627173',
    name: 'Test guild',
    channels: {
      cache: new Collection(rooms.map(room => [room.id, room])),
      fetch,
      create: mutations,
      edit: mutations,
    },
  };
  const client = {
    guilds: { cache: new Collection([[guild.id, guild]]) },
    db: { get: async () => config, set: mutations, delete: mutations },
  };
  const warnings = t.mock.method(logger, 'warn', () => {});
  const errors = t.mock.method(logger, 'error', () => {});
  t.after(() => {
    assert.equal(mutations.mock.callCount(), 0, 'startup must not create/edit rooms or write/delete configuration');
    assert.equal(errors.mock.callCount(), 0);
    assert.deepEqual(config, original, 'saved mappings and unrelated data must stay intact');
  });
  return { client, fetch, warnings, mutations };
}

test('startup with no configured rooms never creates rooms or discovers replacements by name', async t => {
  const { client, fetch, warnings } = setup(t, {}, [
    { id: AUDIT_LOG_CATEGORY_ID, type: ChannelType.GuildCategory },
    { id: 'public', name: 'roles', parentId: AUDIT_LOG_CATEGORY_ID, type: ChannelType.GuildText },
  ]);
  await ensureAuditLogChannels(client);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
});

test('startup preserves configured renamed/moved rooms without requiring the old category', async t => {
  const config = { auditChannels: { roles: 'saved' }, unrelated: { enabled: true } };
  const { client, fetch, warnings, mutations } = setup(t, config);
  client.guilds.cache.first().channels.cache.set('saved', {
    id: 'saved', name: '📘log-roles', parentId: 'different-category', type: ChannelType.GuildText,
    edit: mutations, setName: mutations, permissionOverwrites: { edit: mutations }, send: mutations,
  });
  await ensureAuditLogChannels(client);
  assert.equal(getAuditLogChannelId(config, 'roles'), 'saved');
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
});

test('startup fetches an existing configured room missing from cache by its saved ID', async t => {
  const { client, fetch, warnings } = setup(t, { auditChannels: { voice: 'saved' } }, [],
    { id: 'saved', name: '📘log-voice', type: ChannelType.GuildText });
  await ensureAuditLogChannels(client);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments), [['saved']]);
  assert.equal(warnings.mock.callCount(), 0);
});

test('deleted or inaccessible configured rooms stay deleted without replacing/clearing their mappings', async t => {
  const { client, fetch, warnings } = setup(t, { auditChannels: { voice: 'deleted' } }, [
    { id: 'public', name: 'voice', parentId: AUDIT_LOG_CATEGORY_ID, type: ChannelType.GuildText },
  ], new Error('Missing access'));
  await ensureAuditLogChannels(client);
  await ensureAuditLogChannels(client);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments), [['deleted'], ['deleted']]);
  assert.equal(warnings.mock.callCount(), 2);
});

test('a configured category is reported unavailable and is never converted into a log room', async t => {
  const { client, warnings } = setup(t, { auditChannels: { roles: 'category' } }, [
    { id: 'category', type: ChannelType.GuildCategory },
  ]);
  await ensureAuditLogChannels(client);
  assert.equal(warnings.mock.callCount(), 1);
});
