// bugsReportsInbox.js — every staff message in #bugs-reports (bugsReportsRoom.js) becomes a tracked report.
//
// The bot answers the message with an embed `🐞 بلاغ #N — مفتوح` (the original stays) and opens a GitHub issue
// labelled `بلاغ` + `bugs-reports` (reportIssueService.js). When the issue is closed, checkClosedReports edits the
// embed and posts a reply that stays in the room. Replies to the bot's messages (a report, the guide) are chat.

import { isProtectedGuild } from '../config/homeGuild.js';
import { isBugsReportsRoom } from './bugsReportsRoom.js';
import { openReportIssue, BUGS_REPORTS_LABEL } from './reportIssueService.js';
import { logger } from '../utils/logger.js';

const OPEN_COLOR = 0xe67e22;
const MIN_TEXT_LENGTH = 3;
const MAX_DESCRIPTION_LENGTH = 4000;
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
const NOTICE_DELETE_MS = 10_000;

// guildId:userId → { times: [ms], noticed: bool }
const recentReports = new Map();

/** For tests. */
export function resetBugsReportsRateLimit() {
  recentReports.clear();
}

// Returns 'ok', 'notice' (first message over the limit) or 'silent'.
function takeSlot(key, now) {
  const entry = recentReports.get(key) || { times: [], noticed: false };
  entry.times = entry.times.filter((time) => now - time < RATE_WINDOW_MS);
  if (!entry.times.length) entry.noticed = false;
  recentReports.set(key, entry);
  if (entry.times.length < RATE_LIMIT) {
    entry.times.push(now);
    return 'ok';
  }
  if (entry.noticed) return 'silent';
  entry.noticed = true;
  return 'notice';
}

export function buildBugReportEmbed({ number, reporter, channel, content, attachmentUrls, createdTimestamp }) {
  const lines = [
    `**المُبلِّغ:** ${reporter} (${reporter.tag} - ${reporter.id})`,
    `**الروم:** ${channel}`,
    `**الوقت:** <t:${Math.floor((createdTimestamp || Date.now()) / 1000)}:F>`,
    '',
    '**المشكلة:**',
    content?.trim() || '*(بدون نص)*',
  ];
  if (attachmentUrls.length) lines.push('', '**المرفقات:**', ...attachmentUrls.map((url) => `• ${url}`));
  return {
    color: OPEN_COLOR,
    title: `🐞 بلاغ #${number ?? '؟'} — مفتوح`,
    author: { name: reporter.tag, icon_url: reporter.displayAvatarURL?.() },
    description: lines.join('\n').slice(0, MAX_DESCRIPTION_LENGTH),
    footer: { text: 'bugs-reports' },
  };
}

async function repliesToBot(message, botId) {
  if (!message.reference?.messageId) return false;
  if (message.mentions?.repliedUser) return message.mentions.repliedUser.id === botId;
  const referenced = await message.fetchReference?.().catch(() => null);
  return referenced?.author?.id === botId;
}

/**
 * Records a message posted in #bugs-reports as a report. Returns true when the message was in the room
 * (handled, even when ignored), false otherwise.
 */
export async function handleBugsReportsMessage(message, client = message.client) {
  if (!message.guild || !isProtectedGuild(message.guild.id)) return false;
  if (!(await isBugsReportsRoom(client, message.channel))) return false;

  const botId = client?.user?.id;
  // The bot's own messages (the pinned guide, the report embeds), other bots and system messages are never reports.
  if (message.author?.bot || message.author?.id === botId || message.system) return true;
  const attachmentUrls = [...(message.attachments?.values?.() || [])].map((attachment) => attachment.url);
  const text = (message.content || '').trim();
  if (!attachmentUrls.length && text.length < MIN_TEXT_LENGTH) return true;
  // A reply to a report (open or closed) or to the guide is just chat; nothing is opened or reopened.
  if (await repliesToBot(message, botId)) return true;

  const slot = takeSlot(`${message.guild.id}:${message.author.id}`, Date.now());
  if (slot !== 'ok') {
    if (slot === 'notice') {
      const notice = await message.reply({
        content: `⏱️ <@${message.author.id}> كفاية ${RATE_LIMIT} بلاغات في 10 دقايق، استنى شوية.`,
        allowedMentions: { users: [message.author.id] },
      }).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), NOTICE_DELETE_MS).unref?.();
    }
    return true;
  }

  const details = {
    reporter: message.author,
    channel: message.channel,
    content: message.content,
    attachmentUrls,
    createdTimestamp: message.createdTimestamp,
  };
  let posted;
  try {
    posted = await message.reply({ embeds: [buildBugReportEmbed(details)], allowedMentions: { parse: [], repliedUser: false } });
  } catch (error) {
    logger.error(`Failed to post the bug report from ${message.author.tag} in #bugs-reports:`, error);
    return true;
  }

  const number = await openReportIssue({
    reportMessage: posted,
    reporter: message.author,
    content: message.content,
    sourceChannel: message.channel,
    attachmentUrls,
    extraLabels: [BUGS_REPORTS_LABEL],
    guildName: message.guild.name,
    originalUrl: message.url,
  });
  if (number) {
    await posted.edit({ embeds: [buildBugReportEmbed({ ...details, number })] })
      .catch((error) => logger.error(`Failed to show bug report #${number} in Discord:`, error));
  }
  logger.info(`Bug report ${number ? `#${number}` : '(no issue)'} from ${message.author.tag} in ${message.guild.name}.`);
  return true;
}
