// memberHierarchy.js — who may act on whom (owner's request), in our server and in Zenith.
//
// The bot bans, kicks, times out, warns, gives and takes roles, renames and moves members for the staff
// member who typed or ran the command, so Discord's own role check only ever sees the bot. This is the
// check on the member who asked:
//   • nobody acts on themselves (unless the command is meant for that, `allowSelf`: `نك` renaming yourself);
//   • nobody acts on the guild owner or on an owner from serverOwners.js;
//   • the guild owner and the owners from serverOwners.js may act on anyone else;
//   • anyone else needs their highest role strictly above the target's highest role.
// A target who isn't in the server (ban or unban by ID) has no roles to compare, so it is allowed unless
// it is an owner. What the bot does on its own (anti-spam, anti-nuke, filters) is not checked here.
// Every moderation command and typed shortcut asks `assertCanActOn`; other servers keep their old checks.

import { isProtectedGuild } from '../../config/homeGuild.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';

export const HIERARCHY_REFUSAL = '🚫 مينفعش تنفذ الأمر ده على عضو رتبته زي رتبتك أو أعلى منك.';

const idOf = (target) => (typeof target === 'string' ? target : target?.id || target?.user?.id || null);

/** Whether `executorMember` is our bot (its own actions are not a member's command). */
function isOurBot(guild, executorMember) {
  const id = executorMember?.id;
  return Boolean(id) && (id === guild?.members?.me?.id || id === guild?.client?.user?.id || executorMember?.user?.bot === true);
}

/** Whether the rule covers this command: our server and Zenith, run by a member (not the bot itself). */
export function hierarchyRuleApplies(guild, executorMember = null) {
  return isProtectedGuild(guild?.id) && !isOurBot(guild, executorMember);
}

export function isOwnerId(guild, userId) {
  return Boolean(userId) && (String(userId) === String(guild?.ownerId) || isServerOwner(userId));
}

// A GuildMember knows its highest role; a User or an ID is looked up in the member cache.
function memberOf(guild, target) {
  if (target?.roles?.highest) return target;
  const id = idOf(target);
  return (id && guild?.members?.cache?.get?.(id)) || null;
}

const positionOf = (member) => Number(member?.roles?.highest?.position ?? 0);

/**
 * Whether `executorMember` (the member who typed or ran the command) may act on `target` (a GuildMember,
 * a User or an ID). Returns `{ ok: true }`, or `{ ok: false, reason, message }` with reason one of
 * `no_executor`, `self`, `owner`, `hierarchy`; `message` is the refusal to show them.
 * Other servers, and the bot acting on its own, always get `{ ok: true }`.
 */
export function assertCanActOn(guild, executorMember, target, { allowSelf = false } = {}) {
  if (!hierarchyRuleApplies(guild, executorMember)) return { ok: true };
  const refuse = (reason) => ({ ok: false, reason, message: HIERARCHY_REFUSAL });
  const executorId = executorMember?.id;
  const targetId = idOf(target);
  if (!executorId) return refuse('no_executor');
  if (!targetId) return { ok: true };
  if (String(targetId) === String(executorId)) return allowSelf ? { ok: true } : refuse('self');
  if (isOwnerId(guild, targetId)) return refuse('owner');
  if (isOwnerId(guild, executorId)) return { ok: true };
  const targetMember = memberOf(guild, target);
  if (!targetMember) return { ok: true };
  const executor = memberOf(guild, executorMember) || executorMember;
  return positionOf(executor) > positionOf(targetMember) ? { ok: true } : refuse('hierarchy');
}

/**
 * The refusal as an error for the command pipeline: the member sees `HIERARCHY_REFUSAL` on its own line,
 * a typed command too (it deletes itself after a few seconds), a slash command ephemerally.
 */
export function hierarchyError(check) {
  return new TitanBotError(`Role hierarchy: ${check.reason}`, ErrorTypes.PERMISSION, check.message || HIERARCHY_REFUSAL, {
    expected: true,
    alwaysReply: true,
    hierarchyReason: check.reason,
  });
}

/** `assertCanActOn` for commands: throws `hierarchyError` when the member may not act on `target`. */
export function ensureCanActOn(guild, executorMember, target, options) {
  const check = assertCanActOn(guild, executorMember, target, options);
  if (!check.ok) throw hierarchyError(check);
  return check;
}
