import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isServerOwner, isTrustManager, TRUST_MANAGER_IDS } from '../src/config/serverOwners.js';
import { handleProtectedChannelMessage } from '../src/services/protectedChannelsService.js';
import { TRUSTED_BOARD_CHANNEL_ID } from '../src/services/trustedBoardService.js';

const MANAGER = '626263734704275487';

test('a trust manager can give and take back trust but is not a server owner', () => {
    assert.deepEqual(TRUST_MANAGER_IDS, [MANAGER]);
    assert.equal(isTrustManager(MANAGER), true);
    assert.equal(isServerOwner(MANAGER), false);
    assert.equal(isTrustManager('1159601661392715906'), true, 'the owner still can');
    assert.equal(isTrustManager('111111111111111111'), false);
});

test('a trust manager may write in the trusted board only', async () => {
    const make = (channelId, authorId) => {
        const deleted = [];
        return {
            deleted,
            message: {
                channelId, guild: {}, author: { id: authorId, bot: false }, client: { user: { id: 'bot' } }, embeds: [],
                delete: async () => { deleted.push(channelId); },
                channel: { send: async () => ({ delete: async () => {} }) },
            },
        };
    };
    const board = make(TRUSTED_BOARD_CHANNEL_ID, MANAGER);
    assert.equal(await handleProtectedChannelMessage(board.message), false);
    assert.equal(board.deleted.length, 0);
    const stranger = make(TRUSTED_BOARD_CHANNEL_ID, '111111111111111111');
    assert.equal(await handleProtectedChannelMessage(stranger.message), true);
    assert.equal(stranger.deleted.length, 1);
});
