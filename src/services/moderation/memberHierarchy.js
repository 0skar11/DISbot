// memberHierarchy.js — who may act on whom (owner's request), in our server and in Zenith.
//
// The bot bans, kicks, times out, warns, gives and takes roles, renames and moves members for the staff
// member who typed or ran the command, so Discord's own role check only ever sees the bot. This is the
// check on the member who asked:
//   • nobody acts on themselves (unless the command is meant for that, `allowSelf`: `نك` renaming yourself);
//   • nobody acts on the guild owner or on an owner from serverOwners.js;
//   • the guild owner and the owners from serverOwners.js may act on anyone else;
//   • anyone else needs their highest role strictly above the target's highest role.
//
// The check is authoritative (fail-closed): a target that is not in the member cache is fetched from
// Discord. Only Discord's answer "Unknown Member" (error 10007) means they are not in the server (ban or
// unban by ID): they have no roles to compare, so it is allowed unless they are an owner. Any other failure
// (rate limit, 5xx, timeout, no way to fetch) or a target whose ID can't be read is refused with the same
// 🚫 refusal, so a member who couldn't be looked up is never treated as "not in the server".
// What the bot does on its own (anti-spam, anti-nuke, filters) is not checked here.
// Every moderation command and typed shortcut awaits `assertCanActOn` before it acts; other servers keep
// their old checks.

import { isProtectedGuild } from '../../config/homeGuild.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';

export const HIERARCHY_REFUSAL = '🚫 مينفعش تنفذ الأمر ده على عضو رتبته زي رتبتك أو أعلى منك.';
/** Discord's "Unknown Member": the only answer that means the user is not in the server. */
export const UNKNOWN_MEMBER_CODE = 10007;
/** Other servers (no role rule here): a target Discord could not look up is not acted on blind either. */
export const LOOKUP_FAILED_MESSAGE = '❌ Can\'t Check This Member, Try Again';

const idOf = (target) => {
  const id = typeof target === 'string' ? target : target?.id || target?.user?.id || null;
  return id ? String(id) : null;
};

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

/** Whether `error` is Discord's Unknown Member answer (10007). */
export function isUnknownMemberError(error) {
  return Number(error?.code) === UNKNOWN_MEMBER_CODE || Number(error?.rawError?.code) === UNKNOWN_MEMBER_CODE;
}

/**
 * Looks `target` (a GuildMember, a User or an ID) up in `guild`: the target itself when it is a member, else
 * the member cache, else Discord (`guild.members.fetch(id)`). Never throws. Resolves to `{ id, member, absent, error }`:
 *   • `member` set when they are in the server;
 *   • `absent: true` only when Discord answered Unknown Member (10007);
 *   • otherwise `error`: Discord could not tell (rate limit, 5xx, timeout), or there is no ID or no way to fetch.
 */
export async function lookupMember(guild, target) {
  const id = idOf(target);
  const result = (member, absent = false, error = null) => ({ id, member, absent, error });
  if (target?.roles?.highest) return result(target);
  if (!id) return result(null, false, new Error('Member ID could not be determined'));
  const cached = guild?.members?.cache?.get?.(id);
  if (cached) return result(cached);
  if (typeof guild?.members?.fetch !== 'function') return result(null, false, new Error('Members can not be fetched'));
  try {
    const member = await guild.members.fetch(id);
    return member ? result(member) : result(null, false, new Error('Member fetch returned nothing'));
  } catch (error) {
    return isUnknownMemberError(error) ? result(null, true) : result(null, false, error);
  }
}

const positionOf = (member) => Number(member?.roles?.highest?.position ?? 0);
const refuse = (reason, extra = {}) => ({ ok: false, reason, message: HIERARCHY_REFUSAL, ...extra });

/**
 * Whether `executorMember` (the member who typed or ran the command) may act on `target` (a GuildMember,
 * a User or an ID). Resolves to `{ ok: true }`, or `{ ok: false, reason, message }` with reason one of
 * `no_executor`, `no_target`, `self`, `owner`, `hierarchy` (also when the target could not be looked up:
 * then `lookupFailed: true`); `message` is the refusal to show them.
 * `lookup`, the result of `lookupMember` the caller already has for this same target ID, saves a second
 * request (one for another ID is ignored). Other servers, and the bot acting on its own, always get `{ ok: true }`.
 */
export async function assertCanActOn(guild, executorMember, target, { allowSelf = false, lookup = null } = {}) {
  if (!hierarchyRuleApplies(guild, executorMember)) return { ok: true };
  const executorId = idOf(executorMember);
  const targetId = idOf(target);
  if (!executorId) return refuse('no_executor');
  if (!targetId) return refuse('no_target');
  if (targetId === executorId) return allowSelf ? { ok: true } : refuse('self');
  if (isOwnerId(guild, targetId)) return refuse('owner');
  if (isOwnerId(guild, executorId)) return { ok: true };

  const found = lookup?.id === targetId && (lookup.absent || lookup.member) ? lookup : await lookupMember(guild, target);
  if (found.absent) return { ok: true };
  if (!found.member) return refuse('hierarchy', { lookupFailed: true });

  // The executor is the member who typed or ran the command; without their roles they are looked up too.
  const executor = executorMember?.roles?.highest ? executorMember : (await lookupMember(guild, executorId)).member;
  if (!executor) return refuse('hierarchy', { lookupFailed: true });
  return positionOf(executor) > positionOf(found.member) ? { ok: true } : refuse('hierarchy');
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
export async function ensureCanActOn(guild, executorMember, target, options) {
  const check = await assertCanActOn(guild, executorMember, target, options);
  if (!check.ok) throw hierarchyError(check);
  return check;
}
