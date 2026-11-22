import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { HOME_GUILD_ID, ZENITH_GUILD_ID } from '../src/config/homeGuild.js';
import { ROLE_DEFINITIONS } from '../src/services/staffRoleHierarchyService.js';
import {
  setupHomeTickets, openTicket, claimTicket, verifyTicket, closeTicket, SECTION_ROLE_IDS, TICKET_NAMES, VERIFIED_ROLE_ID,
  getVerifiedRoleId,
} from '../src/services/tickets/homeTickets.js';
import { generateTranscript } from '../src/services/ticket.js';
import { utf8TextFile, UTF8_BOM } from '../src/utils/textAttachment.js';

const MEMBER = '200000000000000001';
const GIRL = '200000000000000002';
const STAFF_ROLE = { id: '400000000000000001', name: ROLE_DEFINITIONS.find((definition) => definition.name.includes('Support')).name, managed: false };

function setup(guildId = HOME_GUILD_ID) {
  const store = new Map();
  const roles = new Map([
    [SECTION_ROLE_IDS.problem, { id: SECTION_ROLE_IDS.problem, name: 'Support team', managed: false }],
    [SECTION_ROLE_IDS.verify, { id: SECTION_ROLE_IDS.verify, name: 'Girls team', managed: false }],
    [STAFF_ROLE.id, STAFF_ROLE],
    [VERIFIED_ROLE_ID, { id: VERIFIED_ROLE_ID, name: 'Verified girl', managed: false }],
  ]);
  const channels = new Map();
  const created = [];
  let nextId = 1;
  const client = { user: { id: 'bot' }, db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, structuredClone(value)); return true; } } };
  const members = new Map();
  const guild = {
    id: guildId, client,
    members: { me: { id: 'bot' }, fetch: async (id) => members.get(id) || null },
    roles: {
      cache: Object.assign(roles, { find: (fn) => [...roles.values()].find(fn) }),
      create: async (options) => { const role = { id: `41000000000000000${nextId++}`, name: options.name, managed: false }; roles.set(role.id, role); return role; },
    },
    channels: {
      cache: Object.assign(channels, { find: (fn) => [...channels.values()].find(fn) }),
      create: async (options) => {
        const id = `60000000000000${String(nextId++).padStart(4, '0')}`;
        const sent = [];
        const channel = {
          id, client, guild, name: options.name, type: options.type, parentId: options.parent || null, options, sent, deleted: false,
          send: async (payload) => { sent.push(payload); return { id: `m${sent.length}`, edit: async () => {} }; },
          messages: { fetch: async () => new Map([['1', { createdTimestamp: 1, author: { tag: 'x' }, content: 'مرحبا', attachments: new Map(), embeds: [] }]]) },
          delete: async () => { channel.deleted = true; channels.delete(id); },
        };
        channels.set(id, channel);
        created.push(channel);
        return channel;
      },
    },
  };
  const member = (id, roleIds = []) => {
    const m = { id, guild, user: { id, tag: `u${id.slice(-2)}` }, permissions: { has: () => false }, roles: { cache: new Map(roleIds.map((r) => [r, {}])), add: async (role) => { m.roles.cache.set(role.id, role); } } };
    members.set(id, m);
    return m;
  };
  return { guild, created, member, roles, store };
}

describe('our server\'s tickets (owner\'s request)', () => {
  test('makes the category, the panel and log rooms once, with a two-button panel, and no new role', async () => {
    const { guild, created, roles } = setup();
    const result = await setupHomeTickets(guild);
    assert.deepEqual(created.map((channel) => channel.name), [TICKET_NAMES.category, TICKET_NAMES.panel, TICKET_NAMES.log]);
    const panel = created[1];
    const buttons = panel.sent[0].components[0].toJSON().components;
    assert.deepEqual(buttons.map((button) => button.custom_id), ['hticket:open:problem', 'hticket:open:verify']);
    assert.equal(roles.size, 4);
    assert.match(panel.sent[0].embeds[0].description, new RegExp(`<@&${VERIFIED_ROLE_ID}>`));
    // Everyone reads the panel, nobody writes.
    const everyone = panel.options.permissionOverwrites.find((overwrite) => overwrite.id === HOME_GUILD_ID);
    assert.ok(everyone.deny.includes(PermissionFlagsBits.SendMessages));
    assert.equal(result.panelChannelId, panel.id);
    await setupHomeTickets(guild);
    assert.equal(created.length, 3);
  });

  test('a problem ticket pings only the opener, the staff can see it, and one per member', async () => {
    const { guild, created, member } = setup();
    await setupHomeTickets(guild);
    const result = await openTicket(member(MEMBER), 'problem', { now: 1_000_000 });
    assert.equal(result.ok, true);
    const ticket = created[3];
    assert.match(ticket.name, /مشكلة-0001/u);
    const allowed = ticket.options.permissionOverwrites.filter((overwrite) => overwrite.allow).map((overwrite) => overwrite.id);
    assert.ok(allowed.includes(MEMBER) && allowed.includes(SECTION_ROLE_IDS.problem) && allowed.includes(STAFF_ROLE.id));
    assert.equal(ticket.sent[0].content, `<@${MEMBER}>`);
    assert.deepEqual(ticket.sent[0].allowedMentions.roles, []);
    assert.equal((await openTicket(member(MEMBER), 'problem', { now: 2_000_000 })).reason, 'has_open');

    const staff = member('200000000000000009', [SECTION_ROLE_IDS.problem]);
    assert.equal((await claimTicket(ticket, member('200000000000000008'))).reason, 'not_team');
    assert.equal((await claimTicket(ticket, staff)).ok, true);
    assert.equal((await closeTicket(ticket, member('200000000000000008'))).reason, 'not_team');
    assert.equal((await closeTicket(ticket, member(MEMBER), { deleteAfterMs: 0 })).ok, true);
    const log = created[2];
    assert.equal(log.sent[0].files[0].name, 'ticket-0001.txt');
    assert.match(log.sent[0].embeds[0].description, new RegExp(`استلمه: <@200000000000000009>`));
    assertUtf8Transcript(log.sent[0].files[0].attachment);
  });

  test('a verification ticket is seen only by its role (GH #322), pings only the opener, and ✅ gives the verified girl role', async () => {
    const { guild, created, member } = setup();
    await setupHomeTickets(guild);
    const girl = member(GIRL);
    assert.equal((await openTicket(girl, 'verify', { now: 5_000_000 })).ok, true);
    const ticket = created[3];
    const allowed = ticket.options.permissionOverwrites.filter((overwrite) => overwrite.allow).map((overwrite) => overwrite.id);
    assert.ok(allowed.includes(SECTION_ROLE_IDS.verify));
    assert.ok(!allowed.includes(STAFF_ROLE.id) && !allowed.includes(SECTION_ROLE_IDS.problem));
    const denied = ticket.options.permissionOverwrites.filter((overwrite) => overwrite.deny).map((overwrite) => overwrite.id);
    assert.ok(denied.includes(STAFF_ROLE.id));
    assert.equal(ticket.sent[0].content, `<@${GIRL}>`);

    assert.equal((await verifyTicket(ticket, member('200000000000000011'))).reason, 'not_team');
    const verifier = member('200000000000000010', [SECTION_ROLE_IDS.verify]);
    const verified = await verifyTicket(ticket, verifier);
    assert.equal(verified.ok, true);
    assert.equal(verified.roleId, VERIFIED_ROLE_ID);
    assert.ok(girl.roles.cache.has(VERIFIED_ROLE_ID));
  });

  test('another server: nothing is made and no ticket opens', async () => {
    const { guild, created, member } = setup('100000000000000099');
    assert.equal(await setupHomeTickets(guild), null);
    assert.equal((await openTicket(member(MEMBER), 'problem')).reason, 'not_home');
    assert.equal(created.length, 0);
  });

  test('Zenith server: tickets set up once, preserved if moved, and verify role restricts access and gives Zenith role', async () => {
    const zenithRoleId = '1570728144086765640';
    const zenithVerifierRoleId = '1572977938092134410';
    const { guild, created, member, roles } = setup(ZENITH_GUILD_ID);
    roles.set(zenithRoleId, { id: zenithRoleId, name: 'Zenith girl', managed: false });
    roles.set(zenithVerifierRoleId, { id: zenithVerifierRoleId, name: 'Zenith female verifiers', managed: false });

    // 1. Initial setup creates category, panel, and log rooms
    const result = await setupHomeTickets(guild);
    assert.ok(result);
    assert.equal(created.length, 3);
    const [category, panel, log] = created;

    // 2. If channels are moved (e.g. panel parent changed or category moved), setup does NOT move them back or recreate them
    panel.parentId = 'other_cat';
    log.parentId = 'other_cat';
    const secondSetup = await setupHomeTickets(guild);
    assert.equal(created.length, 3); // No new channels created
    assert.equal(panel.parentId, 'other_cat'); // Not moved back
    assert.equal(log.parentId, 'other_cat');

    // 3. Problem ticket works in Zenith
    const probResult = await openTicket(member(MEMBER), 'problem', { now: 1_000_000 });
    assert.equal(probResult.ok, true);

    // 4. Verify ticket is seen only by Zenith verifiers role (1572977938092134410) and gives Zenith role (1570728144086765640)
    const girl = member(GIRL);
    const verResult = await openTicket(girl, 'verify', { now: 2_000_000 });
    assert.equal(verResult.ok, true);
    const ticketChannel = created[created.length - 1];
    const allowed = ticketChannel.options.permissionOverwrites.filter((overwrite) => overwrite.allow).map((overwrite) => overwrite.id);
    assert.ok(allowed.includes(zenithVerifierRoleId));
    // GH #322: Other staff role is NOT allowed and is explicitly denied
    assert.equal(allowed.includes(STAFF_ROLE.id), false);
    const denied = ticketChannel.options.permissionOverwrites.filter((overwrite) => overwrite.deny).map((overwrite) => overwrite.id);
    assert.ok(denied.includes(STAFF_ROLE.id));

    // Staff without verifier role cannot verify, claim, or close
    const regularStaff = member('200000000000000010', [STAFF_ROLE.id]);
    assert.equal((await verifyTicket(ticketChannel, regularStaff)).reason, 'not_team');
    assert.equal((await claimTicket(ticketChannel, regularStaff)).reason, 'not_team');
    assert.equal((await closeTicket(ticketChannel, regularStaff)).reason, 'not_team');

    // Verifier with 1572977938092134410 can verify
    const verifierMember = member('200000000000000011', [zenithVerifierRoleId]);
    const verified = await verifyTicket(ticketChannel, verifierMember);
    assert.equal(verified.ok, true);
    assert.equal(verified.roleId, zenithRoleId);
    assert.ok(girl.roles.cache.has(zenithRoleId));

    // GH #324: the closing transcript is UTF-8 with a byte order mark here too.
    assert.equal((await closeTicket(ticketChannel, girl, { deleteAfterMs: 0 })).ok, true);
    const transcriptFile = log.sent.at(-1).files[0];
    assert.match(transcriptFile.name, /^ticket-\d{4}\.txt$/u);
    assertUtf8Transcript(transcriptFile.attachment);
  });
});

/** GH #324: starts with the UTF-8 BOM (EF BB BF) and decodes back to the Arabic messages, unchanged. */
function assertUtf8Transcript(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  assert.deepEqual([...buffer.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  const text = buffer.toString('utf8');
  assert.equal(text.charCodeAt(0), 0xFEFF);
  assert.match(text.slice(1), /^\[1970-01-01 00:00\] x: مرحبا$/u);
  assert.equal(text.indexOf(UTF8_BOM, 1), -1, 'only one BOM');
}

describe('GH #324: text attachments are UTF-8 with a BOM', () => {
  test('utf8TextFile adds one BOM and keeps the text', () => {
    const buffer = utf8TextFile('سلام عليكم\nhello');
    assert.deepEqual([...buffer.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.equal(buffer.toString('utf8'), `${UTF8_BOM}سلام عليكم\nhello`);
    assert.deepEqual(utf8TextFile(buffer.toString('utf8')), buffer, 'no second BOM');
    assert.deepEqual([...utf8TextFile('')], [0xEF, 0xBB, 0xBF]);
  });

  test('the HTML transcript of the other ticket system starts with the BOM too', async () => {
    const messages = new Map([['1', { createdTimestamp: 0, author: { tag: 'x' }, content: 'مرحبا يا جماعة', embeds: [] }]]);
    const channel = { id: 'c1', name: 'ticket-1', messages: { fetch: async () => Object.assign(messages, { last: () => [...messages.values()].at(-1) }) } };
    const attachment = await generateTranscript(channel);
    const buffer = attachment.attachment;
    assert.deepEqual([...buffer.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.equal(buffer.toString('utf8').charCodeAt(0), 0xFEFF);
    assert.ok(buffer.toString('utf8').slice(1).startsWith('<!DOCTYPE html>'), 'the HTML itself is unchanged');
    assert.match(buffer.toString('utf8'), /مرحبا يا جماعة/u);
  });
});
