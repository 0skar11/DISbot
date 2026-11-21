// ticketStaffAccess.js — the staff and admins see and answer every ticket, in every server (GH #316).
//
// The roles that get access to a ticket room:
//   • the staff roles (staffRoleHierarchyService.js: saved IDs or the staff role names);
//   • every role (not a bot's own role) with Administrator or Manage Channels;
//   • the roles set in the guild's config: the ticket staff role, the mod and admin roles, the trusted roles.
// Members with Administrator see every room anyway; members with Manage Channels get in through their role.

import { PermissionFlagsBits } from 'discord.js';
import { filterStaffRoles } from '../../services/staffRoleHierarchyService.js';

export const TICKET_STAFF_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

const STAFF_PERMISSIONS = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageChannels];

const roleIdOf = (value) => (value && typeof value === 'object' ? value.id : value) || null;

/** The role IDs set for staff in the guild's config (`ticketStaffRoleId`, `modRole`, `adminRole`, trusted roles). */
export function configStaffRoleIds(config) {
  if (!config) return [];
  return [config.ticketStaffRoleId, config.modRole, config.adminRole, ...(config.antiNukeTrustedRoles || [])]
    .map(roleIdOf)
    .filter(Boolean)
    .map(String);
}

/** Every role ID that sees and answers the tickets of `guild` (only roles that exist; never @everyone). */
export async function ticketStaffRoleIds(guild, config = null, extraRoleIds = []) {
  const cache = guild?.roles?.cache;
  const roles = [...(cache?.values?.() || [])];
  const staff = await filterStaffRoles(guild, roles).catch(() => []);
  const byPermission = roles.filter((role) => !role.managed
    && STAFF_PERMISSIONS.some((permission) => role.permissions?.has?.(permission)));
  const ids = new Set([
    ...staff.map((role) => role.id),
    ...byPermission.map((role) => role.id),
    ...configStaffRoleIds(config),
    ...extraRoleIds.filter(Boolean).map(String),
  ]);
  ids.delete(String(guild?.id));
  return [...ids].filter((id) => cache?.has?.(id));
}

/** Whether a member is ticket staff: Administrator or Manage Channels, or one of the ticket staff roles. */
export function isTicketStaffMember(member, roleIds = []) {
  if (!member) return false;
  if (STAFF_PERMISSIONS.some((permission) => member.permissions?.has?.(permission))) return true;
  return roleIds.some((id) => member.roles?.cache?.has?.(id));
}

/**
 * Gives each of `roleIds` the staff access in an existing ticket room when it is missing (a role added
 * after the ticket opened). Returns how many overwrites were written.
 */
export async function grantTicketStaffAccess(channel, roleIds) {
  if (!channel?.permissionOverwrites) return 0;
  let granted = 0;
  for (const id of roleIds) {
    const current = channel.permissionOverwrites.cache?.get?.(id);
    if (current && TICKET_STAFF_ALLOW.every((permission) => current.allow?.has?.(permission))) continue;
    const ok = await channel.permissionOverwrites.edit(id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true,
    }, { reason: 'Tickets: staff access' }).then(() => true).catch(() => false);
    if (ok) granted += 1;
  }
  return granted;
}
