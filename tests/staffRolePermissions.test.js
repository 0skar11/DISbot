import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import '../src/utils/embeds.js';
import { ROLE_DEFINITIONS, ALL_EXCEPT_ADMINISTRATOR, rememberStaffRoles, demoteAdministratorsBelowAdmin, removeMentionEveryoneFromStaffRoles, buildGenericBoardEmbeds } from '../src/services/staffRoleHierarchyService.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';
import { memberHasModerationCommandAccess } from '../src/utils/permissionGuard.js';

const permissionsOf = (name) => new PermissionsBitField(ROLE_DEFINITIONS.find((definition) => definition.name === name).permissions);
const VOICE = [PermissionFlagsBits.MoveMembers, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.ModerateMembers];

describe('staff role permissions', () => {
  test('hierarchy order, highest first', () => {
    assert.deepEqual(ROLE_DEFINITIONS.map((definition) => definition.name), [
      '👑 Owner', '⚡ Head Admin', '🛡️ Admin', '🎖️ Supervisor', '⚔️ Senior Moderator',
      '🔨 Moderator', '💬 Chat Moderator', '🎧 Voice Moderator', '🔰 Trial Moderator', '🎫 Support Staff',
    ]);
  });

  for (const name of ['👑 Owner', '⚡ Head Admin', '🛡️ Admin']) {
    test(`${name} is Administrator`, () => {
      assert.ok(permissionsOf(name).has(PermissionFlagsBits.Administrator, false));
    });
  }

  // Report #208: below 🛡️ Admin, every permission but Administrator; GH #320: and never Mention Everyone.
  for (const name of ['🎖️ Supervisor', '⚔️ Senior Moderator', '🔨 Moderator']) {
    test(`${name} has every permission except Administrator and Mention Everyone`, () => {
      const permissions = permissionsOf(name);
      assert.equal(permissions.has(PermissionFlagsBits.Administrator, false), false);
      assert.equal(permissions.has(PermissionFlagsBits.MentionEveryone, false), false);
      assert.equal(permissions.bitfield | PermissionFlagsBits.Administrator | PermissionFlagsBits.MentionEveryone, PermissionsBitField.All);
    });
  }

  test('GH #320: no staff role set holds Mention Everyone', () => {
    for (const definition of ROLE_DEFINITIONS.filter((role) => !new PermissionsBitField(role.permissions).has(PermissionFlagsBits.Administrator, false))) {
      assert.equal(new PermissionsBitField(definition.permissions).has(PermissionFlagsBits.MentionEveryone, false), false, definition.name);
    }
    assert.equal(new PermissionsBitField(ALL_EXCEPT_ADMINISTRATOR).has(PermissionFlagsBits.MentionEveryone, false), false);
  });

  test('Reports #208 & #302: all editable roles with Administrator (except 👑 Owner) get every permission but it', async () => {
    const make = (id, name, position, permissions, managed = false) => {
      const role = { id, name, position, managed, permissions: new PermissionsBitField(permissions), setPermissions: async (bits) => { role.permissions = new PermissionsBitField(bits); return role; } };
      return role;
    };
    const roles = [
      make('0', '👑 Owner', 10, PermissionFlagsBits.Administrator),
      make('1', '⚡ Head Admin', 9, PermissionFlagsBits.Administrator),
      make('2', '🛡️ Admin', 8, PermissionFlagsBits.Administrator),
      make('3', '🎖️ Supervisor', 7, PermissionFlagsBits.Administrator),
      make('4', 'Old helpers', 3, PermissionFlagsBits.Administrator),
      make('5', 'Members', 1, PermissionFlagsBits.SendMessages),
      make('6', 'SomeBot', 5, PermissionFlagsBits.Administrator, true),
      make('7', 'OverBotRole', 12, PermissionFlagsBits.Administrator),
    ];
    const store = new Map();
    const guild = (id) => ({
      id,
      client: { db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } } },
      members: { me: { roles: { highest: { position: 11 } } } },
      roles: { fetch: async () => Object.assign(new Map(roles.map((role) => [role.id, role])), { find: (fn) => roles.find(fn) }) },
    });
    // Works on all servers, keeping Administrator for the top 3 roles (Report #302)
    const result = await demoteAdministratorsBelowAdmin(guild('1569932761471524874'));
    assert.deepEqual(result.changed.sort(), ['Old helpers', '🎖️ Supervisor'].sort());
    // Top 3 roles keep Administrator
    assert.ok(roles[0].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[1].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[2].permissions.has(PermissionFlagsBits.Administrator, false));
    // Roles below top 3 have Administrator removed and all other permissions granted
    assert.equal(roles[3].permissions.has(PermissionFlagsBits.Administrator, false), false);
    assert.ok(roles[3].permissions.has(PermissionFlagsBits.BanMembers, false));
    assert.equal(roles[4].permissions.has(PermissionFlagsBits.Administrator, false), false);
    assert.ok(roles[4].permissions.has(PermissionFlagsBits.BanMembers, false));
    assert.equal(roles[4].permissions.has(PermissionFlagsBits.MentionEveryone, false), false);
    // SomeBot (managed) and OverBotRole (above bot) keep Administrator
    assert.ok(roles[6].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[7].permissions.has(PermissionFlagsBits.Administrator, false));

    // Done once: if the owner gives Administrator back to a lower role later, it stays done-before on normal startup
    roles[3].permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    assert.equal((await demoteAdministratorsBelowAdmin(guild('1569932761471524874'))).status, 'done-before');
    assert.ok(roles[3].permissions.has(PermissionFlagsBits.Administrator, false));

    // Force option re-runs it on demand
    const forced = await demoteAdministratorsBelowAdmin(guild('1569932761471524874'), { force: true });
    assert.equal(forced.status, 'done');
    assert.deepEqual(forced.changed, ['🎖️ Supervisor']);
    assert.equal(roles[3].permissions.has(PermissionFlagsBits.Administrator, false), false);
  });

  test('roles below psycho role lose Administrator and gain all other permissions', async () => {
    const make = (id, name, position, permissions) => {
      const role = { id, name, position, managed: false, permissions: new PermissionsBitField(permissions), setPermissions: async (bits) => { role.permissions = new PermissionsBitField(bits); return role; } };
      return role;
    };
    const roles = [
      make('0', 'Owner', 20, PermissionFlagsBits.Administrator),
      make('1', 'Co-Owner', 19, PermissionFlagsBits.Administrator),
      make('2', 'Head', 18, PermissionFlagsBits.Administrator),
      make('3', '💗 PSYCHO', 17, PermissionFlagsBits.Administrator),
      make('4', 'UnderPsycho1', 16, PermissionFlagsBits.Administrator),
      make('5', 'UnderPsycho2', 15, PermissionFlagsBits.Administrator),
    ];
    const store = new Map();
    const guild = {
      id: '1569932761471524874',
      client: { db: { get: async (k, fb) => (store.has(k) ? store.get(k) : fb), set: async (k, v) => { store.set(k, v); return true; } } },
      members: { me: { roles: { highest: { position: 21 } } } },
      roles: { fetch: async () => Object.assign(new Map(roles.map((r) => [r.id, r])), { find: (fn) => roles.find(fn) }) },
    };

    const result = await demoteAdministratorsBelowAdmin(guild, { force: true });
    assert.equal(result.status, 'done');
    assert.deepEqual(result.changed.sort(), ['UnderPsycho1', 'UnderPsycho2'].sort());
    // Roles at or above PSYCHO keep Administrator
    assert.ok(roles[0].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[1].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[2].permissions.has(PermissionFlagsBits.Administrator, false));
    assert.ok(roles[3].permissions.has(PermissionFlagsBits.Administrator, false)); // PSYCHO keeps Administrator
    // Roles below PSYCHO lose Administrator and gain ALL_EXCEPT_ADMINISTRATOR
    assert.equal(roles[4].permissions.has(PermissionFlagsBits.Administrator, false), false);
    assert.ok(roles[4].permissions.has(PermissionFlagsBits.BanMembers, false));
    assert.equal(roles[5].permissions.has(PermissionFlagsBits.Administrator, false), false);
    assert.ok(roles[5].permissions.has(PermissionFlagsBits.BanMembers, false));
  });

  test('Chat Moderator can timeout, warn and write notes but not kick or ban', () => {
    const permissions = permissionsOf('💬 Chat Moderator');
    assert.ok(permissions.has([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages], false));
    assert.equal(permissions.any([PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.Administrator], false), false);
  });

  test('Voice Moderator has every voice permission and no chat or member moderation', () => {
    const permissions = permissionsOf('🎧 Voice Moderator');
    assert.ok(permissions.has([...VOICE.filter((flag) => flag !== PermissionFlagsBits.ModerateMembers), PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.Stream], false));
    assert.equal(permissions.any([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.Administrator], false), false);
  });

  test('Trial Moderator can warn, kick, timeout and write notes but not ban', () => {
    const permissions = permissionsOf('🔰 Trial Moderator');
    assert.ok(permissions.has([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageMessages], false));
    assert.equal(permissions.any([PermissionFlagsBits.BanMembers, PermissionFlagsBits.Administrator], false), false);
  });

  test('Support Staff has no moderation permission', () => {
    const permissions = permissionsOf('🎫 Support Staff');
    assert.equal(permissions.any([...VOICE, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.Administrator], false), false);
  });
});

describe('the bot never touches staff roles', () => {
  test('existing staff roles are only found, even renamed ones, and missing ones are never created', async () => {
    const store = new Map();
    const client = { db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } } };
    const untouchable = (id, name, position) => ({
      id, name, position, managed: false, editable: true,
      edit: async () => { throw new Error('must not edit'); },
      delete: async () => { throw new Error('must not delete'); },
      setPermissions: async () => { throw new Error('must not edit'); },
      setPosition: async () => { throw new Error('must not move'); },
    });
    // The last staff role is missing: it must not be created.
    const roles = new Map(ROLE_DEFINITIONS.slice(0, -1).map((definition, index) => [String(index + 1), untouchable(String(index + 1), definition.name, 50 - index)]));
    roles.find = (fn) => [...roles.values()].find(fn);
    const guild = {
      id: 'g-staff', name: 'g', client,
      members: { me: { permissions: new PermissionsBitField(PermissionsBitField.All), roles: { highest: { position: 99 } } } },
      roles: { fetch: async () => roles, create: async () => { throw new Error('must not create'); } },
    };

    assert.deepEqual(await rememberStaffRoles(guild), { found: ROLE_DEFINITIONS.length - 1 });
    // The owner renames the first staff role: it is still recognised by its saved ID.
    roles.get('1').name = 'The Boss';
    assert.deepEqual(await rememberStaffRoles(guild), { found: ROLE_DEFINITIONS.length - 1 });
  });
});

describe('GH #320: Mention Everyone is taken off existing staff roles', () => {
  const ME = PermissionFlagsBits.MentionEveryone;
  const make = (id, name, position, bits, managed = false) => {
    const role = { id, name, position, managed, permissions: new PermissionsBitField(bits), setPermissions: async (next) => { role.permissions = new PermissionsBitField(next); return role; } };
    return role;
  };
  const guildWith = (id, roles, owners = []) => ({
    id,
    client: {},
    members: {
      me: { roles: { highest: { position: 50 } } },
      fetch: async () => new Map(owners.map((owner) => [owner.id, owner])),
    },
    roles: { fetch: async () => Object.assign(new Map(roles.map((role) => [role.id, role])), { find: (fn) => roles.find(fn) }) },
  });

  for (const guildId of [HOME_GUILD_ID, '1569932761471524874']) {
    test(`staff roles lose it, other roles are left alone (server ${guildId})`, async () => {
      const roles = [
        make(guildId, '@everyone', 0, PermissionFlagsBits.SendMessages),
        make('mod', '🔨 Moderator', 10, PermissionsBitField.All & ~PermissionFlagsBits.Administrator),
        make('support', '🎫 Support Staff', 5, PermissionFlagsBits.SendMessages | ME),
        make('helpers', 'Helpers', 8, PermissionFlagsBits.ManageMessages | ME),
        make('admin', '🛡️ Admin', 20, PermissionFlagsBits.Administrator | ME),
        make('owner', '👑 Owner', 30, PermissionFlagsBits.BanMembers | ME),
        make('vip', 'VIP', 3, PermissionFlagsBits.SendMessages | ME),
        make('integration', 'SomeBot', 9, PermissionFlagsBits.ManageMessages | ME, true),
        make('above', 'Above bot', 60, PermissionFlagsBits.ManageMessages | ME),
      ];
      const result = await removeMentionEveryoneFromStaffRoles(guildWith(guildId, roles));
      assert.deepEqual(result.changed.sort(), ['Helpers', '🎫 Support Staff', '🔨 Moderator'].sort());
      const byId = Object.fromEntries(roles.map((role) => [role.id, role]));
      for (const id of ['mod', 'support', 'helpers']) assert.equal(byId[id].permissions.has(ME, false), false, id);
      // Everything else on those roles stays.
      assert.ok(byId.mod.permissions.has(PermissionFlagsBits.BanMembers, false));
      assert.ok(byId.helpers.permissions.has(PermissionFlagsBits.ManageMessages, false));
      for (const id of ['admin', 'owner', 'vip', 'integration', 'above']) assert.ok(byId[id].permissions.has(ME, false), id);
      // A second run has nothing left to do.
      assert.deepEqual((await removeMentionEveryoneFromStaffRoles(guildWith(guildId, roles))).changed, []);
    });
  }

  test('a role an owner relies on keeps it', async () => {
    const roles = [make('mods', 'Mods', 10, PermissionFlagsBits.ManageMessages | ME)];
    const owner = { id: '1159601661392715906', permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages | ME), roles: { cache: new Map([['mods', roles[0]]]) } };
    const result = await removeMentionEveryoneFromStaffRoles(guildWith('1569932761471524874', roles, [owner]));
    assert.deepEqual(result.changed, []);
    assert.ok(roles[0].permissions.has(ME, false));
  });

  test('the permission board says @everyone is the owner\'s alone', () => {
    const roles = new Map([['r', make('r', 'Mods', 4, PermissionFlagsBits.ManageMessages)]]);
    assert.match(buildGenericBoardEmbeds(roles)[0].description, /@everyone/u);
  });
});

describe('configured modRole', () => {
  const member = { id: 'm', guild: { ownerId: 'o' }, permissions: new PermissionsBitField(), roles: { cache: new Map([['mod', {}]]) } };
  const config = { modRole: 'mod' };

  test('covers timeout', () => {
    assert.ok(memberHasModerationCommandAccess(member, config, PermissionFlagsBits.ModerateMembers));
  });

  test('never covers ban or kick', () => {
    assert.equal(memberHasModerationCommandAccess(member, config, PermissionFlagsBits.BanMembers), false);
    assert.equal(memberHasModerationCommandAccess(member, config, PermissionFlagsBits.KickMembers), false);
  });
});
