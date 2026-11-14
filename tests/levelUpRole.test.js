import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLevelUpMessage, parseLevelUp, levelRuleFor } from '../src/services/levelUpRoleService.js';

const GUILD = '1569932761471524874';
const rule = levelRuleFor(GUILD);

function setup({ content, level, authorId = rule.botId, channelId = rule.channelId, hasRole = false, guildId = GUILD }) {
    const added = [];
    const role = { id: 'role1', name: '" pic perm ,', managed: false };
    const member = { user: { bot: false }, roles: { cache: { has: () => hasRole }, add: async (r) => { added.push(r.id); } } };
    const guild = { id: guildId, roles: { fetch: async () => ({ find: (fn) => [role].find(fn) }) }, members: { fetch: async () => member } };
    const message = { guild, channelId, author: { id: authorId }, content: content ?? `Congratulations <@111111111111111111>, you reached level ${level}!`, embeds: [], mentions: { users: { first: () => ({ id: '111111111111111111' }) } } };
    return { message, added };
}

test('level 5 and above gets the role', async () => {
    for (const level of [5, 10]) {
        const { message, added } = setup({ level });
        assert.equal(await handleLevelUpMessage(message), 'given');
        assert.deepEqual(added, ['role1']);
    }
});
test('level 4 does not', async () => {
    const { message, added } = setup({ level: 4 });
    assert.equal(await handleLevelUpMessage(message), 'low');
    assert.equal(added.length, 0);
});
test('already has the role: nothing added', async () => {
    const { message, added } = setup({ level: 6, hasRole: true });
    assert.equal(await handleLevelUpMessage(message), 'has');
    assert.equal(added.length, 0);
});
test('another bot, another channel or another server is ignored', async () => {
    assert.equal(await handleLevelUpMessage(setup({ level: 9, authorId: '222222222222222222' }).message), 'ignored');
    assert.equal(await handleLevelUpMessage(setup({ level: 9, channelId: '333333333333333333' }).message), 'ignored');
    assert.equal(await handleLevelUpMessage(setup({ level: 9, guildId: '1155236281706627173' }).message), 'ignored');
    assert.equal(parseLevelUp({ author: { id: rule.botId }, channelId: rule.channelId, content: 'hello', embeds: [] }, rule), null);
});

test('startup catch-up only reads announcements newer than the last handled one', async () => {
    const { runLevelUpBackfill } = await import('../src/services/levelUpRoleService.js');
    const store = new Map();
    const fetchedWith = [];
    const { message } = setup({ level: 7 });
    message.id = '500000000000000002';
    const guild = message.guild;
    guild.client = { db: { get: async (k, f) => (store.has(k) ? store.get(k) : f), set: async (k, v) => { store.set(k, v); } } };
    guild.channels = { cache: new Map([[rule.channelId, { isTextBased: () => true, messages: { fetch: async (opts) => { fetchedWith.push(opts); return new Map([[message.id, message]]); } } }]]) };
    assert.equal((await runLevelUpBackfill(guild)).given, 1);
    assert.equal(fetchedWith[0].after, undefined);
    await runLevelUpBackfill(guild);
    assert.equal(fetchedWith[1].after, '500000000000000002');
});
