import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import {
  configStaffRoleIds, grantTicketStaffAccess, isTicketStaffMember, ticketStaffRoleIds,
} from '../src/utils/ticket/ticketStaffAccess.js';
import { ticketStaffOverwrites } from '../src/services/ticket.js';
import { setupHomeTickets, openTicket, claimTicket } from '../src/services/tickets/homeTickets.js';

// GH #316 "حط الاداره تشوف التكتات": the staff and admins see and answer every ticket, in every server.

const perms = (...flags) => ({ has: (flag) => flags.includes(flag) });
const role = (id, name, flags = [], extra = {}) => ({ id, name, managed: false, permissions: perms(...flags), ...extra });

const ADMIN_ROLE = role('300000000000000001', 'Owners', [PermissionFlagsBits.Administrator]);
const MANAGER_ROLE = role('300000000000000002', 'Managers', [PermissionFlagsBits.ManageChannels]);
const MOD_ROLE = role('300000000000000003', 'Mods');
const TICKET_ROLE = role('300000000000000004', 'Ticket team');
const MEMBER_ROLE = role('300000000000000005', 'Members', [PermissionFlagsBits.SendMessages]);
const BOT_ROLE = role('300000000000000006', 'SomeBot', [PermissionFlagsBits.Administrator], { managed: true });

function guildWith(guildId, { config = null } = {}) {
  const store = new Map();
  if (config) store.set(`guild:${guildId}:config`, config);
  const roles = new Map([[guildId, role(guildId, '@everyone')], ...[ADMIN_ROLE, MANAGER_ROLE, MOD_ROLE, TICKET_ROLE, MEMBER_ROLE, BOT_ROLE].map((r) => [r.id, r])]);
  const channels = new Map();
  const created = [];
  let nextId = 1;
  const client = { user: { id: 'bot' }, db: { get: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback), set: async (key, value) => { store.set(key, structuredClone(value)); return true; } } };
  const guild = {
    id: guildId, client,
    members: { me: { id: 'bot' }, fetch: async () => null },
    roles: { cache: Object.assign(roles, { find: (fn) => [...roles.values()].find(fn) }) },
    channels: {
      cache: Object.assign(channels, { find: (fn) => [...channels.values()].find(fn) }),
      create: async (options) => {
        const id = `61000000000000${String(nextId++).padStart(4, '0')}`;
        const channel = fakeChannel(id, options, guild);
        channels.set(id, channel);
        created.push(channel);
        return channel;
      },
    },
  };
  return { guild, created, store };
}

function fakeChannel(id, options = {}, guild = null) {
  const edits = [];
  const cache = new Map();
  return {
    id, guild, client: guild?.client, name: options.name, options, edits,
    send: async () => ({ id: 'm', edit: async () => {} }),
    permissionOverwrites: {
      cache,
      edit: async (targetId, values) => { edits.push([targetId, values]); cache.set(targetId, { allow: { has: () => true } }); },
    },
  };
}

describe('GH #316: ticket staff access', () => {
  test('the staff roles are Administrator / Manage Channels roles and the config staff roles; never bots or @everyone', async () => {
    const config = { ticketStaffRoleId: TICKET_ROLE.id, modRole: MOD_ROLE.id, adminRole: { id: 'gone' } };
    for (const guildId of [HOME_GUILD_ID, '900000000000000001']) {
      const { guild } = guildWith(guildId);
      const ids = await ticketStaffRoleIds(guild, config);
      assert.ok(ids.includes(ADMIN_ROLE.id) && ids.includes(MANAGER_ROLE.id), guildId);
      assert.ok(ids.includes(MOD_ROLE.id) && ids.includes(TICKET_ROLE.id), guildId);
      assert.ok(!ids.includes(MEMBER_ROLE.id) && !ids.includes(BOT_ROLE.id) && !ids.includes(guildId), guildId);
      assert.ok(!ids.includes('gone'), 'a deleted role is skipped');
    }
    assert.deepEqual(configStaffRoleIds({ modRole: { id: '1' }, antiNukeTrustedRoles: ['2'] }), ['1', '2']);
    assert.deepEqual(configStaffRoleIds(null), []);
  });

  test('isTicketStaffMember: Administrator or Manage Channels members, or a staff role', () => {
    const member = (flags = [], roleIds = []) => ({ permissions: perms(...flags), roles: { cache: new Map(roleIds.map((id) => [id, {}])) } });
    assert.equal(isTicketStaffMember(member([PermissionFlagsBits.Administrator])), true);
    assert.equal(isTicketStaffMember(member([PermissionFlagsBits.ManageChannels])), true);
    assert.equal(isTicketStaffMember(member([], [MOD_ROLE.id]), [MOD_ROLE.id]), true);
    assert.equal(isTicketStaffMember(member([], [MEMBER_ROLE.id]), [MOD_ROLE.id]), false);
    assert.equal(isTicketStaffMember(null), false);
  });

  test('the ticket system (/ticket) lets the staff see and answer, in a second server too', async () => {
    const config = { ticketStaffRoleId: TICKET_ROLE.id, modRole: MOD_ROLE.id };
    for (const guildId of [HOME_GUILD_ID, '900000000000000001']) {
      const { guild } = guildWith(guildId);
      const overwrites = await ticketStaffOverwrites(guild, config.ticketStaffRoleId, config);
      const byId = new Map(overwrites.map((overwrite) => [overwrite.id, overwrite]));
      for (const id of [ADMIN_ROLE.id, MANAGER_ROLE.id, MOD_ROLE.id, TICKET_ROLE.id]) {
        assert.ok(byId.get(id)?.allow.includes(PermissionFlagsBits.ViewChannel), `${guildId} ${id} sees`);
        assert.ok(byId.get(id)?.allow.includes(PermissionFlagsBits.SendMessages), `${guildId} ${id} replies`);
      }
      assert.ok(!byId.has(MEMBER_ROLE.id) && !byId.has(BOT_ROLE.id) && !byId.has(guildId));
    }
  });

  test('home tickets (our server and Zenith): Manage Channels and config staff roles see a new ticket and can claim it', async () => {
    for (const guildId of [HOME_GUILD_ID, ZENITH_GUILD_ID]) {
      const { guild, created } = guildWith(guildId, { config: { modRole: MOD_ROLE.id } });
      await setupHomeTickets(guild);
      const opener = { id: '200000000000000001', guild, user: { id: '200000000000000001', tag: 'u' }, permissions: perms(), roles: { cache: new Map() } };
      assert.equal((await openTicket(opener, 'problem', { now: 10_000_000 + Number(guildId.slice(-4)) })).ok, true);
      const ticket = created.at(-1);
      const allowed = ticket.options.permissionOverwrites.filter((overwrite) => overwrite.allow?.includes(PermissionFlagsBits.ViewChannel)).map((overwrite) => overwrite.id);
      for (const id of [ADMIN_ROLE.id, MANAGER_ROLE.id, MOD_ROLE.id]) assert.ok(allowed.includes(id), `${guildId} ${id}`);
      assert.ok(!allowed.includes(MEMBER_ROLE.id));

      const manager = { id: '200000000000000007', guild, permissions: perms(PermissionFlagsBits.ManageChannels), roles: { cache: new Map() } };
      assert.equal((await claimTicket(ticket, manager)).ok, true, 'a Manage Channels member handles it');
    }
  });

  test('tickets already open get the staff access on startup', async () => {
    const { guild, store } = guildWith(ZENITH_GUILD_ID, { config: { ticketStaffRoleId: TICKET_ROLE.id } });
    await setupHomeTickets(guild);
    const old = fakeChannel('620000000000000001', { name: 'old ticket' }, guild);
    guild.channels.cache.set(old.id, old);
    const key = `guild:${ZENITH_GUILD_ID}:hometickets`;
    store.set(key, { ...store.get(key), open: { [old.id]: { type: 'problem', ownerId: '1', number: '0001' } } });

    await setupHomeTickets(guild);
    const granted = old.edits.map(([id]) => id);
    for (const id of [ADMIN_ROLE.id, MANAGER_ROLE.id, TICKET_ROLE.id]) assert.ok(granted.includes(id), id);
    assert.equal(old.edits[0][1].ViewChannel, true);
    assert.equal(old.edits[0][1].SendMessages, true);

    await setupHomeTickets(guild);
    assert.equal(old.edits.length, granted.length, 'nothing is written again once the access is there');
  });

  test('grantTicketStaffAccess skips a channel without overwrites', async () => {
    assert.equal(await grantTicketStaffAccess({}, [MOD_ROLE.id]), 0);
  });
});
