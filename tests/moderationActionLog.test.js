import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildModerationActionLogEmbed, fetchRepliedMessage, sendModerationActionLog, MODERATION_ACTION_LOG_CHANNEL_ID } from '../src/services/moderation/moderationActionLogService.js';
import { NO_REASON } from '../src/utils/moderationCard.js';
import { HOME_GUILD_ID } from '../src/config/homeGuild.js';

const target = { id: '111111111111111111', tag: 'target', displayAvatarURL: () => 'https://cdn/avatar.png' };
const moderator = { id: '222222222222222222', tag: 'mod' };
const bot = { id: '999999999999999999', tag: 'Aether', bot: true };
const EXECUTOR = /\*\*🧑‍💻 اللي نفّذ الأمر:\*\* <@222222222222222222> \(mod - 222222222222222222\)/u;

describe('moderation action log', () => {
  test('shows the member, moderator, who ran the command, reason and duration', () => {
    const embed = buildModerationActionLogEmbed({ action: 'timeout', targetUser: target, moderatorUser: moderator, executorUser: moderator, reason: 'سبام', durationMs: 15 * 60_000 });
    assert.equal(embed.title, '⏳ تايم أوت');
    assert.match(embed.description, /\*\*العضو:\*\* <@111111111111111111> \(target - 111111111111111111\)/);
    assert.match(embed.description, /\*\*الإداري:\*\* <@222222222222222222> \(mod - 222222222222222222\)/);
    // GH #317: the moderator ran it themselves, so they are named once (no executor line).
    assert.doesNotMatch(embed.description, /اللي نفّذ الأمر/u);
    assert.equal(embed.description.match(/<@222222222222222222>/gu).length, 1);
    assert.match(embed.description, /\*\*السبب:\*\* سبام/);
    assert.match(embed.description, /\*\*المدة:\*\* 15m/);
    assert.doesNotMatch(embed.description, /ريبلاي/);
    assert.equal(embed.thumbnail.url, 'https://cdn/avatar.png');
  });

  test('falls back to the no-reason text', () => {
    const embed = buildModerationActionLogEmbed({ action: 'ban', targetUser: target, moderatorUser: moderator, reason: 'No reason provided' });
    assert.match(embed.description, new RegExp(`\\*\\*السبب:\\*\\* ${NO_REASON}`));
  });

  test('includes the replied message', () => {
    const repliedMessage = {
      author: target,
      content: 'line one\nline two',
      attachments: new Map([['1', { url: 'https://cdn/file.png' }]]),
      url: 'https://discord.com/channels/1/2/3',
    };
    const embed = buildModerationActionLogEmbed({ action: 'warn', targetUser: target, moderatorUser: moderator, reason: 'x', warnings: 2, repliedMessage });
    assert.match(embed.description, /الرسالة اللي اتعمل عليها ريبلاي/);
    assert.match(embed.description, /> line one\n> line two/);
    assert.match(embed.description, /https:\/\/cdn\/file\.png/);
    assert.match(embed.description, /\(https:\/\/discord\.com\/channels\/1\/2\/3\)/);
    assert.match(embed.description, /\*\*عدد التحذيرات:\*\* 2/);
  });

  test('every command family (ban, hard ban, timeout, warn) names the member who ran it, even when the bot is the moderator', () => {
    for (const action of ['ban', 'hardban', 'timeout', 'warn']) {
      const embed = buildModerationActionLogEmbed({ action, targetUser: target, moderatorUser: bot, executorUser: moderator, botId: bot.id, reason: 'x' });
      assert.match(embed.description, EXECUTOR, action);
    }
  });

  test('the bot acting on its own (anti-spam, filters, staff role guard) shows 🤖 تلقائي', () => {
    for (const botId of [bot.id, null]) {
      const embed = buildModerationActionLogEmbed({ action: 'timeout', targetUser: target, moderatorUser: bot, botId, reason: 'سبام' });
      assert.match(embed.description, /\*\*🧑‍💻 اللي نفّذ الأمر:\*\* 🤖 تلقائي \(حماية البوت\)/u);
    }
  });

  test('sendModerationActionLog posts the executor line only for someone other than the moderator', async () => {
    const sent = [];
    const channel = { isTextBased: () => true, send: async (payload) => { sent.push(payload); return { id: 'm1' }; } };
    const guild = { id: HOME_GUILD_ID, client: { user: bot }, channels: { cache: new Map([[MODERATION_ACTION_LOG_CHANNEL_ID, channel]]) } };
    assert.equal(await sendModerationActionLog(guild, { action: 'ban', targetUser: target, moderatorUser: moderator, executorUser: moderator, reason: 'x' }), true);
    assert.doesNotMatch(sent[0].embeds[0].description, /اللي نفّذ الأمر/u);
    assert.equal(await sendModerationActionLog(guild, { action: 'ban', targetUser: target, moderatorUser: bot, executorUser: moderator, reason: 'x' }), true);
    assert.match(sent[1].embeds[0].description, EXECUTOR);
  });

  test('replied message is only read from prefix commands that reply', async () => {
    assert.equal(await fetchRepliedMessage({}), null);
    assert.equal(await fetchRepliedMessage({ _sourceMessage: { reference: null } }), null);
    const referenced = { content: 'hi' };
    assert.equal(await fetchRepliedMessage({ _sourceMessage: { reference: { messageId: '3' }, fetchReference: async () => referenced } }), referenced);
  });
});
