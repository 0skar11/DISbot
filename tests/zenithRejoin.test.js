import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { saveLeavingMember, restoreRejoiningMember } from '../src/services/moderation/rejoinRestore.js';

const ZENITH = '1569932761471524874';
const TRUSTED_ROOM = '1571076213705809941';
const role = (id, name, permissions = 0n) => ({ id, name, managed: false, editable: true, permissions: new PermissionsBitField(permissions) });
const NORMAL = role('600000000000000001', 'Valorant');
const ADMIN = role('600000000000000002', 'Moderators', PermissionsBitField.Flags.Administrator);

test('Zenith: a returning member gets normal roles back, the Administrator role waits in the permissions room', async () => {
    const store = new Map();
    const asked = [];
    const added = [];
    const guild = {
        id: ZENITH, ownerId: '1',
        roles: { cache: new Map([[NORMAL.id, NORMAL], [ADMIN.id, ADMIN]]) },
        channels: { cache: new Map([[TRUSTED_ROOM, { send: async (payload) => { asked.push(payload); } }]]), fetch: async () => null },
        client: { db: { get: async (k, f) => (store.has(k) ? structuredClone(store.get(k)) : f), set: async (k, v) => { store.set(k, structuredClone(v)); }, delete: async (k) => store.delete(k) } },
    };
    const leaving = { id: '700000000000000001', guild, user: { bot: false }, nickname: null, roles: { cache: new Map([[NORMAL.id, NORMAL], [ADMIN.id, ADMIN]]) } };
    await saveLeavingMember(leaving);
    const back = { id: leaving.id, guild, user: { bot: false }, manageable: true, roles: { cache: new Map(), add: async (ids) => { added.push(...ids); } }, setNickname: async () => {} };
    const result = await restoreRejoiningMember(back);
    assert.deepEqual(added, [NORMAL.id]);
    assert.deepEqual(result.pending, [ADMIN.id]);
    assert.equal(asked.length, 1);
    assert.match(asked[0].embeds[0].description, new RegExp(ADMIN.id, 'u'));
});
