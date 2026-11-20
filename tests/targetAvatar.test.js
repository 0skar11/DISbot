import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetAvatarUrl } from '../src/utils/moderation.js';

test('the moderation log shows the target\'s real picture: cached, fetched, or null when it cannot be read', async () => {
    const user = { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png' };
    assert.equal(await targetAvatarUrl({ users: { cache: new Map([['1', user]]), fetch: async () => { throw new Error('no'); } } }, '1'), user.displayAvatarURL());
    assert.equal(await targetAvatarUrl({ users: { cache: new Map(), fetch: async () => user } }, '1'), user.displayAvatarURL());
    assert.equal(await targetAvatarUrl({ users: { cache: new Map(), fetch: async () => { throw new Error('Unknown User'); } } }, '2'), null);
    assert.equal(await targetAvatarUrl(null, '1'), null);
    assert.equal(await targetAvatarUrl({ users: {} }, undefined), null);
});
