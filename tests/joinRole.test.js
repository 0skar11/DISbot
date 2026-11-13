import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { giveJoinRole, runJoinRoleBackfill, BACKFILL_DELAY_MS, JOIN_ROLES } from '../src/services/joinRoleService.js';

const GUILD = '1569932761471524874';
const ROLE = JOIN_ROLES[GUILD];
BACKFILL_DELAY_MS.value = 0;

function makeMember(id, { bot = false, has = false } = {}) {
    const added = [];
    return { id, user: { id, bot }, roles: { cache: { has: () => has }, add: async (r) => added.push(r) }, added };
}

describe('join role', () => {
    test('new member gets the role; bots, others servers and holders do not', async () => {
        const m = makeMember('1');
        assert.equal(await giveJoinRole({ ...m, guild: { id: GUILD } }), true);
        assert.deepEqual(m.added, [ROLE]);
        assert.equal(await giveJoinRole({ ...makeMember('2', { bot: true }), guild: { id: GUILD } }), false);
        assert.equal(await giveJoinRole({ ...makeMember('3'), guild: { id: 'other' } }), false);
        assert.equal(await giveJoinRole({ ...makeMember('4', { has: true }), guild: { id: GUILD } }), false);
    });

    test('backfill gives everyone the role and the reaction permission once, then never again', async () => {
        const store = {};
        const client = { db: { get: async (k, f) => store[k] ?? f, set: async (k, v) => { store[k] = v; return true; } } };
        const humans = [makeMember('1'), makeMember('2'), makeMember('3', { bot: true }), makeMember('4', { has: true })];
        let perms = new PermissionsBitField(0n);
        const everyone = { get permissions() { return perms; }, setPermissions: async (p) => { perms = new PermissionsBitField(p); } };
        const guild = { id: GUILD, name: 'Zenith', roles: { everyone }, members: { fetch: async () => new Map(humans.map((m) => [m.id, m])) } };
        const first = await runJoinRoleBackfill(client, guild);
        assert.deepEqual(first, { skipped: false, given: 2 });
        assert.ok(perms.has(PermissionFlagsBits.AddReactions));
        assert.deepEqual(humans.map((m) => m.added.length), [1, 1, 0, 0]);
        assert.deepEqual(await runJoinRoleBackfill(client, guild), { skipped: true });
        assert.deepEqual(humans.map((m) => m.added.length), [1, 1, 0, 0]);
    });
});
