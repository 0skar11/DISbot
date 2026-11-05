import { findBoardMessage } from '../utils/boardMessage.js';
import { isHomeGuild } from '../config/homeGuild.js';
import { TRUSTED_BOARD_CHANNEL_ID } from './trustedBoardService.js';

export async function removeRetiredBoards(client) {
    const channel = await client.channels.fetch(TRUSTED_BOARD_CHANNEL_ID);
    if (!channel?.guild || !isHomeGuild(channel.guild.id) || !channel.messages?.fetch) return;
    for (const [key, title] of [['savedIdeas', '📝 أفكار محفوظة لبعدين'], ['danger', '☢️ قائمة الخطر']]) {
        const board = await findBoardMessage(channel, key, (message) => message.embeds?.[0]?.title === title);
        if (board) await board.delete();
    }
}
