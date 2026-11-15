// commandInvoker.js — who really ran a moderation command (owner's request).
//
// The bot bans, kicks, times out, gives roles, renames, moves and clears for the member who typed or ran the
// command, so Discord's audit log (and every log built from it) names the bot as the moderator. Right before
// it acts, the command remembers its invoker here for a short while, keyed by the kind of action and the
// target; the logs then show them in the `🧑‍💻 اللي نفّذ الأمر` line. What the bot does on its own
// (anti-spam, anti-nuke, filters...) remembers nobody, and its logs show `🤖 تلقائي (حماية البوت)`.
//
// Kinds: ban, unban, kick, timeout (set or lifted), roles, nickname, voice (targets are member IDs);
// channel (lock/unlock) and bulkDelete (clear) are keyed by the channel ID.

export const EXECUTOR_EMOJI = '🧑‍💻';
export const EXECUTOR_TITLE = 'اللي نفّذ الأمر';
export const EXECUTOR_LABEL = `${EXECUTOR_EMOJI} ${EXECUTOR_TITLE}`;
export const AUTOMATED_EXECUTOR = '🤖 تلقائي (حماية البوت)';
export const UNKNOWN_EXECUTOR = 'غير معروف';
// The gateway event and its audit log entry come within a couple of seconds of the command.
export const INVOKER_TTL_MS = 30_000;

const invokers = new Map(); // `${guildId}:${kind}:${targetId}` -> { user, at }
const keyOf = (guildId, kind, targetId) => `${guildId}:${kind}:${targetId}`;
const userOf = (memberOrUser) => memberOrUser?.user || memberOrUser || null;

/** Remembers that `invoker` (a GuildMember or User, never a bot) is about to do `kind` to `targetId`. */
export function rememberInvoker(guildId, kind, targetId, invoker, now = Date.now()) {
  const user = userOf(invoker);
  if (!guildId || !kind || !targetId || !user?.id || user.bot) return false;
  for (const [key, entry] of invokers) {
    if (now - entry.at > INVOKER_TTL_MS) invokers.delete(key);
  }
  invokers.set(keyOf(guildId, kind, targetId), { user, at: now });
  return true;
}

/** The member who just ran `kind` on `targetId` through the bot, or null. */
export function recentInvoker(guildId, kind, targetId, now = Date.now()) {
  if (!guildId || !kind || !targetId) return null;
  const key = keyOf(guildId, kind, targetId);
  const entry = invokers.get(key);
  if (!entry) return null;
  if (now - entry.at > INVOKER_TTL_MS) {
    invokers.delete(key);
    return null;
  }
  return entry.user;
}

/** Forgets every remembered invoker (tests). */
export function clearInvokers() {
  invokers.clear();
}

/** `<@id> (tag - id)`, or `<@id> (id)` when the tag is unknown. */
export function userMentionLine(user) {
  const id = user.id;
  const tag = user.tag || user.username;
  return tag ? `<@${id}> (${tag} - ${id})` : `<@${id}> (${id})`;
}

/**
 * The value of the `🧑‍💻 اللي نفّذ الأمر` line:
 *   • `invoker`, the member who typed or ran the command, when known;
 *   • otherwise `actor`, who did it as the audit log or the log sees it, when that is a person (or another bot);
 *   • `🤖 تلقائي (حماية البوت)` when the actor is our bot acting on its own (`botId`; without it, any bot user);
 *   • `غير معروف` when nobody is known.
 */
export function executorText({ invoker = null, actor = null, botId = null } = {}) {
  const invokerUser = userOf(invoker);
  if (invokerUser?.id && !invokerUser.bot) return userMentionLine(invokerUser);
  const actorUser = userOf(actor);
  if (!actorUser?.id) return UNKNOWN_EXECUTOR;
  const isOurBot = botId ? actorUser.id === botId : actorUser.bot === true;
  return isOurBot ? AUTOMATED_EXECUTOR : userMentionLine(actorUser);
}
