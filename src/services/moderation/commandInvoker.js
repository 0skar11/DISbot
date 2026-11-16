// commandInvoker.js — who really ran a moderation command (owner's request).
//
// The bot bans, kicks, times out, gives roles, renames, moves and clears for the member who typed or ran the
// command, so Discord's audit log (and every log built from it) names the bot as the moderator. Right before
// it acts, the command remembers its invoker here, keyed by the kind of action and the target; the log of
// that action then shows them in the `🧑‍💻 اللي نفّذ الأمر` line. What the bot does on its own (anti-spam,
// anti-nuke, filters...) remembers nobody, and its logs show `🤖 تلقائي (حماية البوت)`.
//
// One remembered entry stands for one Discord action the bot is about to do:
//   • actor guard (`executorText`, `takeInvoker`): the invoker is only shown when the audit log says our bot
//     did it, or doesn't say who did. A change someone made by hand is always theirs, even right after a
//     command on the same target;
//   • the log that shows the invoker takes the entry (`takeInvoker`), so a later change on the same target
//     is never put on that command; a command that does several Discord actions remembers before each one;
//   • a Discord call that throws forgets it (`forgetInvoker`, or `withInvoker` around the call), so a failed
//     command leaves nothing behind for the next change;
//   • an entry no log took (the event never came) expires after INVOKER_TTL_MS, and at most MAX_INVOKERS are
//     kept (the oldest is dropped first).
//
// Kinds: ban, unban, kick, timeout (set), untimeout (lifted), roles, nickname, voice (targets are member IDs);
// channel (lock/unlock) and bulkDelete (clear) are keyed by the channel ID.

export const EXECUTOR_EMOJI = '🧑‍💻';
export const EXECUTOR_TITLE = 'اللي نفّذ الأمر';
export const EXECUTOR_LABEL = `${EXECUTOR_EMOJI} ${EXECUTOR_TITLE}`;
export const AUTOMATED_EXECUTOR = '🤖 تلقائي (حماية البوت)';
export const UNKNOWN_EXECUTOR = 'غير معروف';
// The gateway event and its audit log entry come within a couple of seconds of the command.
export const INVOKER_TTL_MS = 30_000;
export const MAX_INVOKERS = 500;

const invokers = new Map(); // `${guildId}:${kind}:${targetId}` -> { user, at }, oldest first
const keyOf = (guildId, kind, targetId) => `${guildId}:${kind}:${targetId}`;
const userOf = (memberOrUser) => memberOrUser?.user || memberOrUser || null;

/** Whether `actor` (a User or GuildMember from the audit log) is our bot: `botId` when known, else any bot user. */
export function isOurBotActor(actor, botId = null) {
  const user = userOf(actor);
  if (!user?.id) return false;
  return botId ? String(user.id) === String(botId) : user.bot === true;
}

/** The actor guard: a remembered invoker may only be shown when the actor is unknown or is our bot. */
export function invokerMayBeShown(actor, botId = null) {
  return !userOf(actor)?.id || isOurBotActor(actor, botId);
}

/** Remembers that `invoker` (a GuildMember or User, never a bot) is about to do `kind` to `targetId`. */
export function rememberInvoker(guildId, kind, targetId, invoker, now = Date.now()) {
  const user = userOf(invoker);
  if (!guildId || !kind || !targetId || !user?.id || user.bot) return false;
  for (const [key, entry] of invokers) {
    if (now - entry.at > INVOKER_TTL_MS) invokers.delete(key);
  }
  const key = keyOf(guildId, kind, targetId);
  invokers.delete(key); // re-inserted as the newest
  invokers.set(key, { user, at: now });
  while (invokers.size > MAX_INVOKERS) invokers.delete(invokers.keys().next().value);
  return true;
}

/** The member who just ran `kind` on `targetId` through the bot, or null. Looks without taking it. */
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

/**
 * For the log of the action: the remembered invoker, taken (it is used once), when the actor guard allows it
 * (`actor` from the audit log is missing or our bot, `botId`). With a person as the actor it returns null and
 * leaves the entry for the bot's own event.
 */
export function takeInvoker(guildId, kind, targetId, { actor = null, botId = null, now = Date.now() } = {}) {
  if (!invokerMayBeShown(actor, botId)) return null;
  const user = recentInvoker(guildId, kind, targetId, now);
  if (user) invokers.delete(keyOf(guildId, kind, targetId));
  return user;
}

/**
 * Forgets the invoker remembered for `kind` on `targetId` (the Discord call failed, or did nothing).
 * With `invoker`, only their own entry is forgotten. Returns whether one was.
 */
export function forgetInvoker(guildId, kind, targetId, invoker = null) {
  const key = keyOf(guildId, kind, targetId);
  const entry = invokers.get(key);
  if (!entry) return false;
  const user = userOf(invoker);
  if (user?.id && String(entry.user.id) !== String(user.id)) return false;
  invokers.delete(key);
  return true;
}

/** Remembers `invoker`, runs the Discord call `action`, and forgets them again when it throws (rethrown). */
export async function withInvoker(guildId, kind, targetId, invoker, action) {
  rememberInvoker(guildId, kind, targetId, invoker);
  try {
    return await action();
  } catch (error) {
    forgetInvoker(guildId, kind, targetId, invoker);
    throw error;
  }
}

/** Forgets every remembered invoker (tests). */
export function clearInvokers() {
  invokers.clear();
}

/** How many invokers are remembered (tests). */
export function invokerCount() {
  return invokers.size;
}

/** `<@id> (tag - id)`, or `<@id> (id)` when the tag is unknown. */
export function userMentionLine(user) {
  const id = user.id;
  const tag = user.tag || user.username;
  return tag ? `<@${id}> (${tag} - ${id})` : `<@${id}> (${id})`;
}

/**
 * The value of the `🧑‍💻 اللي نفّذ الأمر` line:
 *   • `invoker`, the member who typed or ran the command, when known and the actor guard allows it: `actor`
 *     is missing or is our bot (`botId`; without it, any bot user);
 *   • otherwise `actor`, who did it as the audit log or the log sees it, when that is a person (or another bot);
 *   • `🤖 تلقائي (حماية البوت)` when the actor is our bot acting on its own;
 *   • `غير معروف` when nobody is known.
 */
export function executorText({ invoker = null, actor = null, botId = null } = {}) {
  const invokerUser = userOf(invoker);
  const actorUser = userOf(actor);
  if (invokerUser?.id && !invokerUser.bot && invokerMayBeShown(actorUser, botId)) return userMentionLine(invokerUser);
  if (!actorUser?.id) return UNKNOWN_EXECUTOR;
  return isOurBotActor(actorUser, botId) ? AUTOMATED_EXECUTOR : userMentionLine(actorUser);
}
