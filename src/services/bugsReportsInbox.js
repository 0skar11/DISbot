// bugsReportsInbox.js — every staff message in #bugs-reports (bugsReportsRoom.js) becomes a tracked report.
//
// Each report gets its own number per guild (1, 2, 3...), kept in the guild config (`bugsReportsCounter`), so the
// numbering works even when GitHub is down. The bot posts an embed `🐞 بلاغ #N — مفتوح` in the room (not a reply),
// with the member's attachments uploaded again, then deletes the member's message. It also opens a GitHub issue
// titled `[bugs #N] ...` labelled `بلاغ` + `bugs-reports` (reportIssueService.js). When the issue is closed,
// checkClosedReports edits the embed and posts a notice that stays in the room. Replies to the bot's messages are chat.

import { isProtectedGuild } from '../config/homeGuild.js';
import { isBugsReportsRoom } from './bugsReportsRoom.js';
import { openReportIssue, BUGS_REPORTS_LABEL } from './reportIssueService.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const OPEN_COLOR = 0xe67e22;
const MIN_TEXT_LENGTH = 3;
const MAX_DESCRIPTION_LENGTH = 4000;
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
const NOTICE_DELETE_MS = 10_000;
export const COUNTER_KEY = 'bugsReportsCounter';
export const MAX_REUPLOAD_FILES = 5;
export const MAX_REUPLOAD_BYTES = 20 * 1024 * 1024;
const FOOTER = 'bugs-reports';
const NOT_ON_GITHUB = '⚠️ مش متسجل في GitHub';

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

// guildId → tail of the promise chain, so two reports at the same moment never read the same counter.
const counterQueues = new Map();

/**
 * Takes the next report number of the guild (1, 2, 3...) from the guild config. Returns null when it could not be
 * saved (the database is down): a number that is not saved could be handed out twice.
 */
export function nextBugReportNumber(client, guildId) {
  const previous = counterQueues.get(guildId) || Promise.resolve();
  const run = previous.then(async () => {
    if (!client?.db || client.db.isAvailable?.() === false) return null;
    const config = await getGuildConfig(client, guildId);
    const current = Number.parseInt(config?.[COUNTER_KEY], 10);
    const number = (Number.isFinite(current) && current > 0 ? current : 0) + 1;
    await updateGuildConfig(client, guildId, { [COUNTER_KEY]: number });
    return number;
  }).catch((error) => {
    logger.error(`Failed to take the next bug report number in guild ${guildId}:`, error);
    return null;
  });
  counterQueues.set(guildId, run);
  run.finally(() => { if (counterQueues.get(guildId) === run) counterQueues.delete(guildId); });
  return run;
}

/** The member's attachments to upload again with the report (at most 5 files, 20 MB together); the rest stay links. */
export function pickReuploads(attachments) {
  const uploads = [];
  const linksOnly = [];
  let total = 0;
  for (const attachment of attachments) {
    const size = Number(attachment.size) || 0;
    if (uploads.length < MAX_REUPLOAD_FILES && total + size <= MAX_REUPLOAD_BYTES) {
      uploads.push(attachment);
      total += size;
    } else {
      linksOnly.push(attachment);
    }
  }
  return { uploads, linksOnly };
}

export function buildBugReportEmbed({
  number, reporter, channel, content, attachmentUrls = [], uploadedNames = [], createdTimestamp, footerNote,
}) {
  const lines = [
    `**المُبلِّغ:** ${reporter} (${reporter.tag} - ${reporter.id})`,
    `**الروم:** ${channel}`,
    `**الوقت:** <t:${Math.floor((createdTimestamp || Date.now()) / 1000)}:F>`,
    '',
    '**المشكلة:**',
    content?.trim() || '*(بدون نص)*',
  ];
  if (uploadedNames.length || attachmentUrls.length) {
    lines.push('', '**المرفقات:**', ...uploadedNames.map((name) => `📎 ${name}`), ...attachmentUrls.map((url) => `• ${url}`));
  }
  return {
    color: OPEN_COLOR,
    title: `🐞 بلاغ #${number ?? '؟'} — مفتوح`,
    author: { name: reporter.tag, icon_url: reporter.displayAvatarURL?.() },
    description: lines.join('\n').slice(0, MAX_DESCRIPTION_LENGTH),
    footer: { text: [FOOTER, footerNote].filter(Boolean).join(' • ') },
  };
}

async function repliesToBot(message, botId) {
  if (!message.reference?.messageId) return false;
  if (message.mentions?.repliedUser) return message.mentions.repliedUser.id === botId;
  const referenced = await message.fetchReference?.().catch(() => null);
  return referenced?.author?.id === botId;
}

const attachmentCount = (message) => message?.attachments?.size ?? [...(message?.attachments?.values?.() || [])].length;

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
  const attachments = [...(message.attachments?.values?.() || [])];
  const text = (message.content || '').trim();
  if (!attachments.length && text.length < MIN_TEXT_LENGTH) return true;
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

  const number = await nextBugReportNumber(client, message.guild.id);
  const { uploads, linksOnly } = pickReuploads(attachments);
  const details = {
    number,
    reporter: message.author,
    channel: message.channel,
    content: message.content,
    createdTimestamp: message.createdTimestamp,
  };
  const withFiles = { ...details, uploadedNames: uploads.map((file) => file.name || 'file'), attachmentUrls: linksOnly.map((file) => file.url) };
  const send = (embedDetails, files) => message.channel.send({
    embeds: [buildBugReportEmbed(embedDetails)],
    ...(files.length ? { files: files.map((file) => ({ attachment: file.url, name: file.name })) } : {}),
    allowedMentions: { parse: [] },
  });

  let posted = null;
  let embedDetails = withFiles;
  try {
    posted = await send(withFiles, uploads);
  } catch (error) {
    logger.error(`Failed to post bug report #${number ?? '?'} from ${message.author.tag} in #bugs-reports:`, error);
  }
  // The files could not be uploaded (too big for the server, gone): post the report with links, keep the original.
  if (!posted && uploads.length) {
    embedDetails = { ...details, attachmentUrls: attachments.map((file) => file.url) };
    posted = await send(embedDetails, []).catch((error) => {
      logger.error(`Failed to post bug report #${number ?? '?'} from ${message.author.tag} without files:`, error);
      return null;
    });
  }
  if (!posted) return true;

  // The member's message is removed only when the report holds everything it had: every file was uploaded again.
  const filesKept = embedDetails === withFiles && !linksOnly.length && attachmentCount(posted) >= uploads.length;
  let originalDeleted = false;
  if (filesKept) {
    originalDeleted = await message.delete().then(() => true, (error) => {
      logger.warn(`Could not delete the original of bug report #${number ?? '?'}: ${error.message}`);
      return false;
    });
  }

  const postedUrls = [...(posted.attachments?.values?.() || [])].map((file) => file.url);
  const issueNumber = await openReportIssue({
    reportMessage: posted,
    reporter: message.author,
    content: message.content,
    sourceChannel: message.channel,
    attachmentUrls: filesKept ? [...postedUrls, ...linksOnly.map((file) => file.url)] : attachments.map((file) => file.url),
    extraLabels: [BUGS_REPORTS_LABEL],
    guildName: message.guild.name,
    originalUrl: originalDeleted ? undefined : message.url,
    reportNumber: number,
  });
  if (!issueNumber) logger.warn(`Bug report #${number ?? '?'} in ${message.guild.name} was not saved to GitHub (see the error above).`);
  const footerNote = issueNumber ? `GitHub #${issueNumber}` : NOT_ON_GITHUB;
  await posted.edit({ embeds: [buildBugReportEmbed({ ...embedDetails, footerNote })] })
    .catch((error) => logger.error(`Failed to show the GitHub state of bug report #${number ?? '?'}:`, error));
  logger.info(`Bug report #${number ?? '?'} (${issueNumber ? `GitHub #${issueNumber}` : 'no issue'}) from ${message.author.tag} in ${message.guild.name}.`);
  return true;
}
