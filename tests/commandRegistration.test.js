import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerCommands } from '../src/handlers/loaders/commandLoader.js';
import addcc from '../src/commands/Games/addcc.js';
import { mapArgumentsToOptions } from '../src/utils/prefixParser.js';
import { createMockInteraction } from '../src/utils/messageAdapter.js';
import { getProfile } from '../src/services/cc/ccService.js';
import { SERVER_OWNER_IDS } from '../src/config/serverOwners.js';

async function captureRegistration(commands) {
    const requests = [];
    await registerCommands({
        commands: new Map(commands.map((command) => [command.data.name, command])),
        rest: { put: async (route, payload) => requests.push({ route, ...payload }) },
    }, { clientId: '100000000000000001' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].route, '/applications/100000000000000001/commands');
    return requests[0].body;
}

function assertRequiredOrder(command, location = command.name) {
    let optionalSeen = false;
    for (const option of command.options || []) {
        if (option.type !== 1 && option.type !== 2) {
            assert.ok(!optionalSeen || !option.required, `${location}.${option.name} is required after an optional option`);
            if (!option.required) optionalSeen = true;
        }
        assertRequiredOrder(option, `${location}.${option.name}`);
    }
}

test('registration fixes addcc without changing typed-command and reply-target order', async () => {
    const original = addcc.data.toJSON();
    assert.equal(original.options[0].type, 6, 'reply-target shortcuts need the user option first');
    const [payload] = await captureRegistration([addcc]);
    assert.deepEqual(payload.options.map((option) => option.name), ['amount', 'user']);
    assert.equal(payload.options[0].required, true);
    assert.equal(payload.options[1].required, false);
    assert.deepEqual(addcc.data.toJSON(), original);
    assertRequiredOrder(payload);
});

test('nested registration options are ordered without mutating their source payload', async () => {
    const original = {
        name: 'nested', description: 'Test nested registration', type: 1,
        options: [{ name: 'group', description: 'Group', type: 2, options: [{
            name: 'set', description: 'Set', type: 1, options: [
                { name: 'optional', description: 'Optional', type: 3, required: false },
                { name: 'required', description: 'Required', type: 3, required: true },
                { name: 'optional2', description: 'Optional 2', type: 3, required: false },
            ],
        }] }],
    };
    const saved = structuredClone(original);
    const [payload] = await captureRegistration([{ data: { name: original.name, toJSON: () => original } }]);
    assert.deepEqual(payload.options[0].options[0].options.map((option) => option.name), ['required', 'optional', 'optional2']);
    assertRequiredOrder(payload);
    assert.deepEqual(original, saved);
});

test('every real command has a valid required-option order in the outgoing registration batch', async () => {
    const commands = [];
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.name === 'modules') continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(file);
            else if (entry.name.endsWith('.js')) {
                const module = await import(pathToFileURL(file).href);
                const command = module.default || module;
                if (command.data && command.execute) commands.push(command);
            }
        }
    }
    await visit(fileURLToPath(new URL('../src/commands', import.meta.url)));
    const payload = await captureRegistration(commands);
    assert.ok(payload.length > 90, 'audit the full real command set');
    assert.equal(payload.length, new Set(commands.map((command) => command.data.name)).size);
    payload.forEach((command) => assertRequiredOrder(command));
});

test('addcc still credits self, a mention, or a reply target with the typed grammar', async () => {
    const owner = { id: SERVER_OWNER_IDS[0], bot: false, toString: () => `<@${SERVER_OWNER_IDS[0]}>` };
    const target = { id: '200000000000000001', bot: false, toString: () => '<@200000000000000001>' };
    const store = new Map();
    const client = { db: {
        get: async (key, fallback = null) => store.has(key) ? structuredClone(store.get(key)) : fallback,
        set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    } };
    const replies = [];
    const guild = {
        id: '100000000000000001',
        members: { cache: new Map([[owner.id, { user: owner }], [target.id, { user: target }]]) },
    };
    const message = {
        id: '300000000000000001', author: owner, guild, client,
        channel: { send: async (payload) => { replies.push(payload); return { id: '400000000000000001' }; } },
        reply: async (payload) => { replies.push(payload); return { id: '400000000000000001' }; },
    };
    for (const args of [['500'], [`<@${target.id}>`, '20'], [target.id, '30']]) {
        const normalized = addcc.normalizePrefixArgs(args);
        const options = mapArgumentsToOptions(normalized, addcc.data);
        assert.equal(options.validateRequired().valid, true);
        await addcc.execute(createMockInteraction(message, addcc.data, normalized), null, client);
    }
    assert.equal((await getProfile(client, guild.id, owner.id)).cc, 500);
    assert.equal((await getProfile(client, guild.id, target.id)).cc, 50);
    assert.equal(replies.length, 3);
    assert.ok(replies.every((payload) => payload.embeds?.length === 1));
});
