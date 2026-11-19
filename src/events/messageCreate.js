import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleArabicUtilityShortcuts } from '../utils/arabicUtilityShortcuts.js';
import { handleMessageDeleteShortcut } from '../utils/messageDeleteShortcut.js';
import { parseTypedCommand, mapArgumentsToOptions } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias, applyWordAliases } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { isSilentCommand } from '../config/commands/commandAvailability.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { getCountingGameConfig, saveCountingGameConfig, isValidCountingMessage, recordCorrectCount } from '../services/countingGameService.js';
import { handleTrustedListCommand } from '../utils/trustedCommand.js';
import { handleGifCommand, isGifCommand } from '../services/gifConverterService.js';
import { handleRemoveBgCommand, isRemoveBgCommand, removeBgArgs } from '../services/backgroundRemoval/removeBgService.js';
import { handleCaptionCommand, isCaptionCommand } from '../services/caption/captionService.js';
import { handleVerifyCommand, isVerifyCommand } from '../services/verification/directVerifyService.js';
import { buildAwamerMainPayload } from '../services/help/awamerService.js';
import { handleArabicRoleShortcut, handleClearWarningsShortcut, handlePullShortcut } from '../utils/arabicModerationShortcuts.js';
import { handlePurgeMessage } from '../services/moderation/channelPurgeService.js';
import { handleReportChannelMessage } from '../services/reportChannelService.js';
import { handleBugsReportsMessage } from '../services/bugsReportsInbox.js';
import { handleProtectedChannelMessage } from '../services/protectedChannelsService.js';
import { handleEveryoneMention } from '../services/everyoneMentionGuardService.js';
import { handleProofMessage, handleProofPinNotice } from '../services/moderation/proofMergeService.js';
import { handleChatFilter } from '../services/moderation/chatFilterService.js';
import { handleSpam, handleOwnerMentionSpam } from '../services/moderation/antiSpamService.js';
import { handleForeignInviteLink } from '../services/inviteLinkGuardService.js';
import { handleMediaMessage } from '../services/mediaRoleService.js';
import { handleImageOnlyChannelMessage } from '../services/imageOnlyChannelService.js';
import { handleGamesChannelMessage, isGamesOnlyFor, isGameCommandMessage } from '../services/games/gamesChannel.js';
import { handleGamesBotWin } from '../services/cc/gamesBotWins.js';
import { handleGamesBotOutsideChannel } from '../services/cc/gamesBotChannel.js';
import { handleStoreChannelMessage } from '../services/cc/storeChannel.js';
import { handleMessageXp } from '../services/leveling/messageXp.js';
import { countMessage } from '../services/leveling/chatCounter.js';
import { handleAfkMessage } from '../services/afkService.js';
import { handleSalam } from '../services/chat/salamReply.js';
import { handleQr } from '../services/chat/qrReply.js';
import { handleMentionGroupCommand } from '../services/mentionGroup.js';
import { handleStreakCommand, handleStreakMessage, isStreakChannel } from '../services/cc/streakService.js';
import { handleDangerCommand, handleDangerMessage, punishDanger, blockDangerCommand, DANGER_COMMAND_WORD } from '../services/moderation/dangerList.js';
import { isHomeGuild } from '../config/homeGuild.js';
import { handleAutomodMessage, isAutomodCommand } from '../services/moderation/automodCommand.js';
import { getCommandDefaultPermissions, memberMeetsCommandPermissions } from '../utils/permissionGuard.js';
import { assertCanActOn } from '../services/moderation/memberHierarchy.js';
import { resolveMemberByName, remainingText } from '../utils/memberNameResolver.js';
import {
  askNameConfirmation, candidatesOf, FULL_NAME_COMMAND_WORDS, handleUnresolvedName, nameTargetsEnabled, pressMessage,
  replyCandidates, replyRefusal,
} from '../services/moderation/nameConfirmation.js';

const AFK_COMMAND = /^\s*[^\p{L}\p{N}\s]{0,3}(?:afk|افك|أفك)(?:\s|$)/iu;
const CC_BOT_ID = '1567561044472103103';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      // Runs before the bot check so other bots cannot post in the protected board channels either.
      if (await handleProtectedChannelMessage(message)) return;
      if (await handleGamesChannelMessage(message, client)) return;
      // The store room only keeps store commands (and reposts its panel every few messages).
      if (await handleStoreChannelMessage(message, client)) return;
      // Games bots (Clover) only play in their channel; elsewhere their messages are deleted.
      if (await handleGamesBotOutsideChannel(message)) return;
      if (await handleProofPinNotice(message)) return;
      // Wins announced by the games bot (Clover) pay CC here.
      if (await handleGamesBotWin(message, client)) return;
      if (message.author.bot || !message.guild) return;
      logger.debug(`Message received from ${message.author.tag}: ${message.content}`);

      // Danger list (`خطر @member`): @everyone/@here or an invite link from a listed member = a week of timeout.
      if (await handleDangerMessage(message)) return;
      if (await handleEveryoneMention(message)) return;
      // A moderator's proof in the moderation log channel is merged into their log message.
      if (await handleProofMessage(message)) return;
      // Insults and banned words (chatFilterService), then spam and repeated owner mentions (antiSpamService).
      if (await handleChatFilter(message)) {
        await punishDanger(message.guild, message.author.id, 'شتيمة أو كلام ممنوع');
        return;
      }
      if (await handleSpam(message)) {
        await punishDanger(message.guild, message.author.id, 'سبام');
        return;
      }
      if (await handleOwnerMentionSpam(message)) return;
      if (await handleForeignInviteLink(message)) return;
      // #bugs-reports (staff): every message becomes a numbered report with a GitHub issue.
      if (await handleBugsReportsMessage(message, client)) return;
      if (await handleImageOnlyChannelMessage(message)) return;
      // The streak room takes everyone's daily picture, so the media role guard skips it.
      if (!isStreakChannel(message.channelId) && await handleMediaMessage(message)) return;
      if (await handleReportChannelMessage(message, { isCommand: (msg) => isBotCommand(msg, client) })) return;
      // Chat XP (runs in the background; the cooldown keeps it from being farmed with commands or spam).
      handleMessageXp(message, client);
      countMessage(client, message.guild.id, message.author.id);
      // Daily streak (our server only): a picture or GIF in the streak room pays the day's bonus.
      handleStreakMessage(message);
      // Clears the author's AFK (unless this is the afk command itself) and announces AFK members they mention.
      await handleAfkMessage(message, client, { isAfkCommand: AFK_COMMAND.test(message.content || '') });
      // In the games channel only game commands run (the rest there is game answers).
      const gamesOnly = isGamesOnlyFor(message);
      // "السلام عليكم" gets "عليكم السلام" (our server only); the message still goes on to the commands.
      if (!gamesOnly) await handleSalam(message);
      // "qr" gets the QR code of our guns.lol page (our server only).
      if (!gamesOnly && await handleQr(message)) return;
      if (!gamesOnly && await handleArabicUtilityShortcuts(message)) return;
      if (!gamesOnly && await handleMessageDeleteShortcut(message)) return;
      if (await handleCountingGame(message, client)) return;
      await handlePrefixCommand(message, client, gamesOnly);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  },
};

// Commands also work without the prefix, but only as the first word of the message
// (`تايم @member 5m`). A command word in the middle of a sentence is ignored.
const USER_ARG = /^(?:<@!?\d{17,20}>|\d{17,20})$/u;

// Replying to someone's message makes them the target: (reply) `تايم 5m سبام` = `تايم @member 5m سبام`.
async function applyReplyTarget(message, commandData, args) {
  if (!message.reference?.messageId || USER_ARG.test(args[0] || '')) return args;
  const firstOption = (commandData?.toJSON ? commandData.toJSON() : commandData)?.options?.[0];
  if (firstOption?.type !== 6) return args;
  const referenced = await message.fetchReference().catch(() => null);
  if (!referenced?.author || referenced.author.bot) return args;
  return [referenced.author.id, ...args];
}

/**
 * Whether typed arguments look like a real use of the command: a member (mention or ID, or the replied-to
 * author added by applyReplyTarget) where the first option is a member, no extra words for a command that takes
 * none, and every required option given.
 */
export function isWrittenAsCommand(commandData, args) {
  const options = (commandData?.toJSON ? commandData.toJSON() : commandData)?.options || [];
  if (!options.length) return args.length === 0;
  if (options[0]?.type === 6 && args.length && !USER_ARG.test(args[0] || '')) return false;
  return mapArgumentsToOptions(args, commandData).validateRequired().valid;
}

/** Whether the message would run one of the bot's commands (same parsing as handlePrefixCommand). */
async function isBotCommand(message, client) {
  const guildConfig = await getGuildConfig(client, message.guild.id);
  const parsed = parseTypedCommand(message.content, guildConfig?.prefix || getCommandPrefix());
  if (!parsed) return false;
  const typedCommand = parsed.commandName.toLowerCase();
  if (['trusted', 'purge', DANGER_COMMAND_WORD, 'منشن'].includes(typedCommand)) return true;
  if (isAutomodCommand(message, guildConfig?.prefix || getCommandPrefix())) return true;
  const aliased = applyWordAliases(typedCommand, parsed.args, parsed.prefixed);
  if (!aliased) return false;
  const name = resolveCommandAlias(aliased.commandName);
  return isSilentCommand(name) || Boolean(client.commands.get(name));
}

/** The typed-command part of a message (also driven directly by tests). */
export async function handlePrefixCommand(message, client, gamesOnly = false) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || getCommandPrefix();
    if (gamesOnly && !isGameCommandMessage(message.content, [prefix])) return;
    const parsed = parseTypedCommand(message.content, prefix);
    // `automod` (every server, the server owners only): the insult filter's lists, sent privately. Anyone else: plain chat.
    if (await handleAutomodMessage(message, { prefix })) return;
    // `منشن` group (our server): runs before the role shortcuts so `شيل منشن @x` isn't "remove role منشن".
    if (parsed && await handleMentionGroupCommand(message, parsed.commandName, parsed.args)) return;
    if (parsed && await handleStreakCommand(message, parsed.commandName, parsed.args)) return;
    // `.شيل الخلفية` / `.removebg` (everyone, report #286): before the role shortcuts, where `شيل` is "remove role".
    if (isRemoveBgCommand(parsed) && await handleRemoveBgCommand(message, removeBgArgs(parsed))) return;
    // `.caption` / `.كابشن` (everyone, report #297): writes text above the picture on a white background.
    if (isCaptionCommand(parsed) && await handleCaptionCommand(message, parsed.args)) return;
    // `.توثيق` / `!توثيق` / `.verify` (female verifiers, report #307): grants the female verified role directly.
    if (isVerifyCommand(parsed) && await handleVerifyCommand(message, parsed.args)) return;
    // `اوامر` / `.اوامر` / `/awamer` (everyone, report #306): interactive GUI command menu.
    if (parsed && (parsed.commandName === 'اوامر' || parsed.commandName === 'أوامر' || parsed.commandName?.toLowerCase() === 'awamer')) {
      const payload = buildAwamerMainPayload(client);
      await message.reply(payload).catch(() => message.channel.send(payload)).catch(() => {});
      return;
    }
    if (await handleArabicRoleShortcut(message, [prefix, getCommandPrefix()])) return;
    if (!parsed) return;

    let { commandName, args } = parsed;
    if (commandName.toLowerCase() === 'trusted') {
      if (args.length) {
        await message.channel.send(`⚠️ ${prefix}trusted`).catch(() => {});
      } else {
        await handleTrustedListCommand(message, client);
      }
      return;
    }

    const typedCommand = commandName.toLowerCase();
    // `purge` wipes the whole channel: owner only, confirmed with a button (in our server `purge 50 تأكيد` skips the button). `clear`/`مسح`/`م` delete N messages.
    if (typedCommand === 'purge') {
      await handlePurgeMessage(message, args);
      return;
    }
    if (typedCommand === DANGER_COMMAND_WORD && await handleDangerCommand(message, args, { prefixed: parsed.prefixed })) return;
    if ((typedCommand === 'سحب' || typedCommand === 'pull') && await handlePullShortcut(message, args, { prefixed: parsed.prefixed })) return;
    // `.gif` / `جيف` (everyone): a picture becomes a GIF. Needs the prefix or a `.`/`!` in front (`.gif` works whatever
    // PREFIX is), so the plain word in a chat is left alone.
    if (isGifCommand(parsed) && await handleGifCommand(message, args)) return;
    if (typedCommand === 'مسح' && args[0] === 'تحذيرات') {
      await handleClearWarningsShortcut(message, args.slice(1), { prefixed: parsed.prefixed });
      return;
    }
    const aliased = applyWordAliases(typedCommand, args, parsed.prefixed);
    if (!aliased) return;
    ({ commandName, args } = aliased);

    const musicPrefixShortcut = commandName.toLowerCase();
    if (new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']).has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    const resolvedCommandName = homeOnlyCommandAlias(message.guild.id, commandName) || resolveCommandAlias(commandName);
    if (isSilentCommand(resolvedCommandName)) return;
    if (resolvedCommandName === 'cc' && message.guild?.members?.cache?.has(CC_BOT_ID)) {
      // CC-bot is in this server and handles `cc` directly; don't send a duplicate response (Report #294)
      return;
    }
    const command = client.commands.get(resolvedCommandName);
    if (!command) return;
    await runTypedCommand(message, client, {
      command, resolvedCommandName, typedCommand, args, prefix, guildConfig, prefixed: parsed.prefixed,
    });
  } catch (error) {
    logger.error('Error handling prefix command:', error);
    await message.channel.send({ content: `❌ ${error.userMessage || error.message || 'Something went wrong'}`, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

// Our server only: `كيك` is the kick command too (other servers keep their words).
const HOME_ONLY_COMMAND_ALIASES = { كيك: 'kick' };

function homeOnlyCommandAlias(guildId, commandName) {
  return isHomeGuild(guildId) ? HOME_ONLY_COMMAND_ALIASES[String(commandName || '').toLowerCase()] || null : null;
}

/**
 * Typed commands whose member may be written by name in our server (memberNameResolver.js): the ones that
 * punish never act at once (`confirm`: a ✅ / ❌ question, nameConfirmation.js); viewing warnings acts directly.
 */
const NAME_TARGET_COMMANDS = new Map([
  ['ban', { confirm: true }],
  ['kick', { confirm: true }],
  ['timeout', { confirm: true }],
  ['untimeout', { confirm: true }],
  ['warn', { confirm: true }],
  ['warnings', { confirm: false }],
]);

/** Whether the member who typed `message` may run `command` at all (Discord permission or the moderator role). */
function mayRunCommand(message, command, guildConfig) {
  if (isBotOwner(message.author?.id)) return true;
  return memberMeetsCommandPermissions(message.member, getCommandDefaultPermissions(command.data), {
    guildConfig, commandCategory: command.category ?? null,
  });
}

const wordsOfText = (text) => (text ? text.split(' ') : []);

/**
 * Our server: `بان محمد سبام`, `تايم احمد 10m`, `وارنات محمد`: the member by name (memberNameResolver.js) when
 * no mention, ID or reply names one. Only for a member who may run the command (anyone else: no answer and no
 * lookup), and without the prefix only for the full command words (FULL_NAME_COMMAND_WORDS). Resolves to
 * `{ args }` for the command to go on with (the member's ID first, the name's words taken out like a mention),
 * or `{ handled: true }` when it stops here: asked to confirm, several members listed, a refusal, or a name
 * nobody has (`❌ Member Not Found` with the prefix, nothing without it).
 */
async function nameTargetForCommand(message, client, context) {
  const { command, resolvedCommandName, typedCommand, args, prefixed, guildConfig } = context;
  const rule = NAME_TARGET_COMMANDS.get(resolvedCommandName);
  if (!rule || !nameTargetsEnabled(message.guild) || !args.length) return { args };
  const firstOption = (command.data?.toJSON ? command.data.toJSON() : command.data)?.options?.[0];
  if (firstOption?.type !== 6) return { args };
  // A mention or an ID anywhere wins over a name (a reply target is already the first argument then).
  if (args.some((arg) => USER_ARG.test(arg))) return { args };
  if (!prefixed && !FULL_NAME_COMMAND_WORDS.has(typedCommand)) return { args };
  if (!mayRunCommand(message, command, guildConfig)) return { args };

  const text = args.join(' ');
  const found = await resolveMemberByName(message.guild, text);
  // A name nobody has (or a failed search): answered with the prefix only (`بان عليه التعب` is chat).
  if (await handleUnresolvedName(message, found, typedCommand, prefixed)) return { handled: true };
  if (found.status === 'none') return { args };
  const argsFor = (candidate) => [candidate.member.id, ...wordsOfText(remainingText(text, candidate.usedWords))];
  if (!rule.confirm) {
    if (found.status === 'many') {
      await replyCandidates(message, found.candidates, { truncated: found.truncated });
      return { handled: true };
    }
    return { args: argsFor(found) };
  }

  // Punishing commands never act on a name at once. One member you may not act on is refused right away.
  if (found.status === 'one') {
    const allowed = await assertCanActOn(message.guild, message.member, found.member);
    if (!allowed.ok) {
      await replyRefusal(message, allowed.message);
      return { handled: true };
    }
  }
  await askNameConfirmation(message, {
    candidates: candidatesOf(found),
    truncated: found.truncated,
    // A press runs the same command with the same words through the whole normal path, as the presser now.
    run: async ({ candidate, member, user }) => {
      const pressed = pressMessage(message, member, user);
      const freshConfig = await getGuildConfig(client, message.guild.id).catch(() => guildConfig);
      await runTypedCommand(pressed, client, { ...context, args: argsFor(candidate), guildConfig: freshConfig, resolveNames: false });
    },
  });
  return { handled: true };
}

/**
 * Runs a typed command found in `client.commands`: maintenance, the danger list, the reply target, the
 * member by name (our server), the prefix rules, the usage check, the cooldown, then the command itself
 * (which checks the permission and the role hierarchy). A confirmed name runs this again with the member's ID.
 */
async function runTypedCommand(message, client, context) {
  const { command, resolvedCommandName, prefix, guildConfig, prefixed, resolveNames = true } = context;
  let { args } = context;
  if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
    await message.channel.send('🛠️ Maintenance Mode').catch(() => {});
    return;
  }
  if (!isCommandCategoryEnabled(command.category)) return;
  if (await blockDangerCommand(message.guild, message.author.id, resolvedCommandName)) {
    await message.channel.send({ content: `🚫 <@${message.author.id}> انت في قائمة الخطر.`, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }

  args = await applyReplyTarget(message, command.data, args);
  if (typeof command.normalizePrefixArgs === 'function') args = command.normalizePrefixArgs(args);

  const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
  if (restriction.blocked || !supportsPrefixExecution(command)) return;
  if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) return;
  if (resolveNames) {
    const named = await nameTargetForCommand(message, client, { ...context, args });
    if (named.handled) return;
    if (named.args !== args) {
      args = named.args;
      if (typeof command.normalizePrefixArgs === 'function') args = command.normalizePrefixArgs(args);
    }
  }
  // Without the prefix the command words are ordinary chat too (`بان عليه`, `مسح الرسالة`, `قفل الباب`), so
  // (owner's request) they only run when written as a command; anything else is left alone, unanswered.
  if (!prefixed && !isWrittenAsCommand(command.data, args)) return;

  // Wrong usage (e.g. `.تايم الغداء`) only shows the permission/usage reply and must not start a cooldown.
  if (!mapArgumentsToOptions(args, command.data).validateRequired().valid) {
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
    return;
  }

  const abuseProtection = await enforceAbuseProtection({ guildId: message.guild.id, user: message.author }, command, resolvedCommandName);
  if (!abuseProtection.allowed) {
    await message.channel.send(`⏱️ Wait ${formatCooldownDuration(abuseProtection.remainingMs)}`).catch(() => {});
    return;
  }
  await executePrefixCommand(command, message, args, client, prefix, guildConfig);
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) return false;
    const validCount = isValidCountingMessage(message.content.trim(), config);
    if (!validCount || message.author.id === config.lastUserId) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, { ...config, nextNumber: 1, lastUserId: null, currentStreak: 0 });
      await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      return true;
    }
    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}
