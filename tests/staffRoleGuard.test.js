import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { guardStaffRoleRemoval } from '../src/services/moderation/staffRoleGuard.js';
import { ROLE_DEFINITIONS } from '../src/services/staffRoleHierarchyService.js';

const TARGET = '200000000000000001';
const REMOVER = '200000000000000002';
const TRUSTED = '200000000000000003';
const STAFF_ROLE = { id: '400000000000000001', name: ROLE_DEFINITIONS.find((definition) => definition.name.includes('Chat Moderator')).name, managed: false };
const OTHER_ROLE = { id: '400000000000000002', name: 'Level 10', managed: false };

function setup({ guildId = HOME_GUILD_ID, executorId = REMOVER, removed = [STAFF_ROLE] } = {}) {
  const added = [];
  const warnings = [];
  const members = new Map([[REMOVER, { id: REMOVER, user: { id: REMOVER } }], [TRUSTED, { id: TRUSTED, user: { id: TRUSTED }, roles: { cache: new Map() } }]]);
  const guild = {
    id: guildId, ownerId: '1',
    client: { user: { id: 'bot' }, db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: [TRUSTED] } : fallback), set: async () => true } },
    members: { me: { id: 'bot' }, fetch: async (id) => members.get(id) || null },
    channels: { cache: new Map(), fetch: async () => null },
    fetchAuditLogs: async () => ({
      entries: [{
        id: '1', executor: { id: executorId, tag: 'x' }, target: { id: TARGET }, createdTimestamp: Date.now(),
        changes: [{ key: '$remove', new: removed.map(({ id, name }) => ({ id, name })) }],
      }],
    }),
  };
  const oldMember = { id: TARGET, guild, roles: { cache: new Map([[STAFF_ROLE.id, STAFF_ROLE], [OTHER_ROLE.id, OTHER_ROLE]]) } };
  const kept = [STAFF_ROLE, OTHER_ROLE].filter((role) => !removed.includes(role));
  const newMember = { id: TARGET, guild, roles: { cache: new Map(kept.map((role) => [role.id, role])), add: async (ids) => { added.push(...ids); } } };
  const warn = async ({ member, reason }) => { warnings.push([member.id, reason]); return { totalCount: 1 }; };
  return { oldMember, newMember, added, warnings, options: { auditRetryMs: 0, warn } };
}

describe('staff roles taken off by the untrusted come back (owner\'s request)', () => {
  test('an untrusted member removes a staff role: it is given back and they are warned', async () => {
    const { oldMember, newMember, added, warnings, options } = setup();
    const result = await guardStaffRoleRemoval(oldMember, newMember, options);
    assert.deepEqual(result, { restored: true, warned: true, executorId: REMOVER });
    assert.deepEqual(added, [STAFF_ROLE.id]);
    assert.equal(warnings[0][0], REMOVER);
    assert.match(warnings[0][1], /رول إدارة/u);
  });

  test('a trusted member, the owner, or the member themselves may remove it; other roles are not watched', async () => {
    for (const executorId of [TRUSTED, '1159601661392715906', TARGET]) {
      const { oldMember, newMember, added, warnings, options } = setup({ executorId });
      assert.equal(await guardStaffRoleRemoval(oldMember, newMember, options), null, executorId);
      assert.deepEqual([added, warnings], [[], []]);
    }
    const other = setup({ removed: [OTHER_ROLE] });
    assert.equal(await guardStaffRoleRemoval(other.oldMember, other.newMember, other.options), null);
  });

  test('another server is left alone', async () => {
    const { oldMember, newMember, added, options } = setup({ guildId: '100000000000000099' });
    assert.equal(await guardStaffRoleRemoval(oldMember, newMember, options), null);
    assert.deepEqual(added, []);
  });
});

describe('admin roles in Zenith and edits (owner request)', () => {
  test('mayChangeRole: only the trusted may change an admin role, anyone an ordinary one', async () => {
    const { mayChangeRole } = await import('../src/services/moderation/staffRoleGuard.js');
    const { PermissionsBitField } = await import('discord.js');
    const ZENITH = '1569932761471524874';
    const guild = { id: ZENITH, ownerId: '1', client: { user: { id: 'bot' }, db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: [TRUSTED] } : fallback) } }, members: { fetch: async () => null } };
    const adminRole = { id: '500000000000000001', name: 'Mods', managed: false, permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator) };
    const plain = { id: '500000000000000002', name: 'Valorant', managed: false, permissions: new PermissionsBitField(0n) };
    assert.equal(await mayChangeRole(guild, REMOVER, adminRole), false);
    assert.equal(await mayChangeRole(guild, TRUSTED, adminRole), true);
    assert.equal(await mayChangeRole(guild, REMOVER, plain), true);
    assert.equal(await mayChangeRole({ ...guild, id: '999999999999999999' }, REMOVER, adminRole), true);
  });

  test('an admin role edited by an untrusted member is put back and the editor warned', async () => {
    const { guardAdminRoleEdit } = await import('../src/services/moderation/staffRoleGuard.js');
    const { PermissionsBitField } = await import('discord.js');
    const ZENITH = '1569932761471524874';
    const edits = [];
    const warned = [];
    const oldRole = { id: '500000000000000003', name: 'Mods', color: 1, hoist: true, mentionable: false, managed: false, permissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator) };
    const newRole = { ...oldRole, name: 'Mods2', permissions: new PermissionsBitField(0n), edit: async (data) => { edits.push(data); } };
    const members = new Map([[REMOVER, { id: REMOVER, user: { id: REMOVER } }]]);
    const guild = {
      id: ZENITH, ownerId: '1',
      client: { user: { id: 'bot' }, db: { get: async (key, fallback) => (key.includes('config') ? { antiNukeTrustedUsers: [TRUSTED] } : fallback), set: async () => true } },
      members: { me: { id: 'bot' }, fetch: async (id) => members.get(id) || null },
      channels: { cache: new Map(), fetch: async () => null },
      fetchAuditLogs: async () => ({ entries: [{ id: '1', executor: { id: REMOVER, tag: 'x' }, target: { id: oldRole.id }, createdTimestamp: Date.now(), changes: [] }] }),
    };
    newRole.guild = guild;
    const result = await guardAdminRoleEdit(oldRole, newRole, { auditRetryMs: 1, warn: async (args) => { warned.push(args.member.id); return { totalCount: 1 }; } });
    assert.equal(result.reverted, true);
    assert.equal(edits[0].name, 'Mods');
    assert.equal(edits[0].permissions, oldRole.permissions);
    assert.deepEqual(warned, [REMOVER]);
  });
});
