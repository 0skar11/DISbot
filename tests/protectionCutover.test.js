import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import publishBoard from '../src/commands/Core/publish-board.js';
import interactionCreate from '../src/events/interactionCreate.js';
import messageCreate from '../src/events/messageCreate.js';
import { loadCommands, registerCommands } from '../src/handlers/loaders/commandLoader.js';
import loadEvents from '../src/handlers/loaders/events.js';
import loadInteractions from '../src/handlers/loaders/interactions.js';
import { TRUSTED_BOARD_CHANNEL_ID } from '../src/services/trustedBoardService.js';

async function withProtection(value, run) {
    const before = process.env.CHAOS_PROTECTION_ENABLED;
    if (value === undefined) delete process.env.CHAOS_PROTECTION_ENABLED;
    else process.env.CHAOS_PROTECTION_ENABLED = value;
    try {
        await run();
    } finally {
        if (before === undefined) delete process.env.CHAOS_PROTECTION_ENABLED;
        else process.env.CHAOS_PROTECTION_ENABLED = before;
    }
}

function registryClient() {
    const requests = [];
    const client = new EventEmitter();
    Object.assign(client, {
        buttons: new Map(), selectMenus: new Map(), modals: new Map(),
        rest: { put: async (_route, { body }) => requests.push(body) },
    });
    return { client, requests };
}

test('cutover removes protection registrations and preserves unrelated commands and events', async () => {
    let baseline;
    await withProtection(undefined, async () => {
        const { client, requests } = registryClient();
        await loadCommands(client);
        await loadEvents(client);
        await loadInteractions(client);
        await registerCommands(client, { clientId: '100000000000000001' });
        baseline = { client, requests };
        assert.ok(client.commands.has('ban'));
        assert.ok(client.buttons.has('verify_user'));
        assert.ok(client.listenerCount('guildBanAdd') > 0);
    });
    await withProtection('false', async () => {
        const { client, requests } = registryClient();
        await loadCommands(client);
        await loadEvents(client);
        await loadInteractions(client);
        await registerCommands(client, { clientId: '100000000000000001' });
        const transferred = new Set([...baseline.client.commands].filter(([, command]) =>
            ['Moderation', 'Verification'].includes(command.category)).map(([name]) => name));
        assert.equal(transferred.size, 20);
        const expected = [...baseline.client.commands.keys()].filter((name) => !transferred.has(name));
        assert.deepEqual([...client.commands.keys()], expected);
        const expectedRegistration = baseline.requests[0].filter(({ name }) => !transferred.has(name));
        const board = expectedRegistration.find(({ name }) => name === 'publish-board');
        board.options = board.options.filter(({ name }) => name === 'rules');
        assert.deepEqual(requests[0], expectedRegistration);
        assert.equal(publishBoard.data.options.length, 4);
        assert.equal(client.listenerCount('guildBanAdd'), 0);
        assert.ok(client.listenerCount('messageCreate') > 0);
        assert.ok(client.listenerCount('messageCreate') < baseline.client.listenerCount('messageCreate'));
        assert.ok(client.listenerCount('guildMemberAdd') > 0);
        assert.equal(client.buttons.has('verify_user'), false);
        assert.equal(client.buttons.has('rejoinroles'), false);
        assert.equal(client.modals.has('warning_delete_modal'), false);
        assert.ok(client.buttons.has('storepanel'));
    });
});

test('stale protection slash and component interactions are silent before touching the registry', async () => {
    await withProtection('false', async () => {
        const client = {};
        for (const interaction of [
            { commandName: 'ban' },
            { commandName: 'verification' },
            { commandName: 'publish-board', options: { getSubcommand: () => 'trusted' } },
            { customId: 'purge_confirm:channel:owner' },
            { customId: 'warning_clear_confirm_modal:member' },
            { customId: 'rejoinroles:approve:member' },
            { customId: 'verify_user' },
        ]) {
            await interactionCreate.execute(Object.freeze(interaction), client);
        }
    });
});

test('typed moderation and trust commands produce no response after cutover', async () => {
    await withProtection('false', async () => {
        const sent = [];
        const lookups = [];
        const guild = { id: '100000000000000001' };
        const channel = { id: '100000000000000002', send: async (payload) => sent.push(payload) };
        const client = {
            db: { get: async (_key, fallback) => ({ ...fallback, prefix: '!!' }) },
            commands: { get: (name) => lookups.push(name) },
        };
        const commands = ['بان 200000000000000003', 'تايم', 'طرد', 'وارن', 'هارد بان 200000000000000003',
            '!!ban', '!!verification', '!!publish-board TRUSTED', 'trusted', 'purge', 'خطر', 'مسح تحذيرات'];
        for (const [index, content] of commands.entries()) {
            await messageCreate.execute({
                id: String(300000000000000001n + BigInt(index)), content, guild, channel, channelId: channel.id, client,
                author: { id: String(200000000000000001n + BigInt(index)), bot: false },
                reply: async (payload) => sent.push(payload),
            }, client);
        }
        assert.deepEqual(sent, []);
        assert.deepEqual(lookups, []);
    });
});

test('the mixed message event stops protecting the trusted board after cutover', async () => {
    let deleted = 0;
    const client = { user: { id: '200000000000000001' } };
    const message = {
        guild: { id: '100000000000000001' },
        channelId: TRUSTED_BOARD_CHANNEL_ID,
        client,
        author: { id: '200000000000000002', bot: true },
        delete: async () => { deleted++; },
    };
    await withProtection(undefined, () => messageCreate.execute(message, client));
    assert.equal(deleted, 1);
    await withProtection('false', () => messageCreate.execute(message, client));
    assert.equal(deleted, 1);
});
