import { Events, PermissionFlagsBits } from 'discord.js';
import { inspectAuditAction, findRecentAuditEntry, sendAntiNukeLog, isTrusted, removeDangerousRoles, AuditLogEvent } from './antiNukeLogging.js';
import { getGuildConfig } from '../services/config/guildConfig.js';

export async function inspectChannelDelete(channel) {
  return inspectAuditAction(channel?.guild, 'channelDelete', channel?.id);
}

export async function inspectRoleDelete(role) {
  return inspectAuditAction(role?.guild, 'roleDelete', role?.id);
}

/** An untrusted member who gives a role the Administrator permission gets it reverted at once, with a warning. */
async function revertAdminGrantOnRole(oldRole, role) {
  const guild = role?.guild;
  if (!guild || !oldRole?.permissions || role.managed) return false;
  if (oldRole.permissions.has(PermissionFlagsBits.Administrator) || !role.permissions.has(PermissionFlagsBits.Administrator)) return false;
  const entry = await findRecentAuditEntry(guild, AuditLogEvent.RoleUpdate, role.id);
  const executorId = entry?.executor?.id;
  if (!executorId || executorId === guild.client.user?.id) return false;
  const config = await getGuildConfig(guild.client, guild.id).catch(() => null);
  if (await isTrusted(guild, config, executorId)) return false;
  const reverted = await role.setPermissions(oldRole.permissions, 'Anti-Nuke: Administrator added to a role by an untrusted member').then(() => true).catch(() => false);
  await sendAntiNukeLog(guild, {
    action: 'Administrator added to role',
    target: `${role.name} (${role.id})`,
    executor: entry.executor,
    punishment: reverted ? 'تم إرجاع صلاحيات الرتبة زي ما كانت' : 'فشل إرجاع الصلاحيات — يحتاج تدخل يدوي',
    reason: `ضاف صلاحية Administrator على رتبة <@&${role.id}>`,
  });
  return reverted;
}

export async function inspectRoleUpdate(role, oldRole = null) {
  if (oldRole && await revertAdminGrantOnRole(oldRole, role)) return true;
  return inspectAuditAction(role?.guild, 'permissionUpdate', role?.id);
}

export async function inspectMessageDelete(channel) {
  return inspectAuditAction(channel?.guild, 'bulkDelete', channel?.id);
}

export async function inspectRoleCreate(role) {
  return inspectAuditAction(role?.guild, 'roleCreate', role?.id);
}

/** Anyone who gives a member an Administrator role is kicked together with that member, unless trusted. */
export async function inspectAdminRoleGrant(oldMember, newMember) {
  const guild = newMember?.guild;
  if (!guild || newMember.id === guild.client.user?.id) return false;
  const adminRoles = newMember.roles.cache.filter((role) => (
    !oldMember.roles?.cache?.has(role.id) && !role.managed && role.permissions.has(PermissionFlagsBits.Administrator)
  ));
  if (!adminRoles.size) return false;

  const grantsAdmin = (item) => item.changes?.some((change) => (
    change.key === '$add' && change.new?.some((role) => adminRoles.has(role.id))
  ));
  // The audit entry can lag behind the gateway event, so look once more before giving up.
  const entry = await findRecentAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, newMember.id, grantsAdmin)
    || await new Promise((resolve) => setTimeout(resolve, 1500))
      .then(() => findRecentAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, newMember.id, grantsAdmin));
  const executorId = entry?.executor?.id;
  if (!executorId) return false;
  const config = await getGuildConfig(guild.client, guild.id).catch(() => null);
  if (await isTrusted(guild, config, executorId)) return false;

  const reason = 'Anti-Nuke: Administrator role given by an untrusted member';
  const executor = await guild.members.fetch(executorId).catch(() => null);
  // The roles are taken off both of them; nobody is kicked.
  const receiverStripped = await newMember.roles.remove([...adminRoles.keys()], reason).then(() => true).catch(() => false);
  const executorStripped = executor ? await removeDangerousRoles(executor, reason) : false;

  await sendAntiNukeLog(guild, {
    action: 'Administrator role given',
    target: `${newMember.user.tag} (${newMember.id})`,
    executor: entry.executor,
    punishment: executorStripped ? 'تم سحب رتبه الخطيرة' : 'فشل سحب الرتب — يحتاج تدخل يدوي',
    reason: `أعطى رتبة Administrator (${adminRoles.map((role) => role.name).join(', ')}) لـ <@${newMember.id}>${receiverStripped ? ' وتم سحبها منه' : ''}`,
    pingEveryone: true,
  });
  return receiverStripped || executorStripped;
}

export async function inspectMemberRemoval(member, event = Events.GuildMemberRemove) {
  const action = event === Events.GuildBanAdd ? 'memberBan' : 'memberKick';
  return inspectAuditAction(member?.guild, action, member?.id);
}

export async function handleAntiRaidCommand(message) {
  if (!message?.guild || message.author?.bot) return false;
  return false;
}

export { findRecentAuditEntry, sendAntiNukeLog, AuditLogEvent };

export default { name: Events.MessageCreate, async execute() {} };
