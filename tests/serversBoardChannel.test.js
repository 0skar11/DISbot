import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleProtectedChannelMessage } from '../src/services/protectedChannelsService.js';

test('the trusted room allows only recognized bot server boards through the exemption', async () => {
    let deleted = 0;
    const board = {
        channelId: '1155236383464628325',
        guild: {},
        client: { user: { id: '1550544520423415928' } },
        author: { id: '1567561044472103103', bot: true },
        embeds: [{ title: '🌐 البوت في 2 سيرفر', footer: { text: '🔄 بيتحدث تلقائي كل 5 دقايق • آخر تحديث' } }],
        delete: async () => { deleted += 1; },
    };
    assert.equal(await handleProtectedChannelMessage(board), false);
    assert.equal(await handleProtectedChannelMessage({ ...board, author: { id: '1567865213540241519', bot: true } }), false);
    assert.equal(await handleProtectedChannelMessage({ ...board, content: 'extra text' }), true);
    assert.equal(await handleProtectedChannelMessage({ ...board, webhookId: '123' }), true);
    assert.equal(await handleProtectedChannelMessage({ ...board, author: { id: '123', bot: true } }), true);
    assert.equal(deleted, 3);
});
