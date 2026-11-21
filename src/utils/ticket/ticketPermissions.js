// ticketPermissions.js

import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { getTicketData } from '../database.js';
import { ticketStaffRoleIds } from './ticketStaffAccess.js';

export async function getTicketPermissionContext({ client, interaction }) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const [config, ticketData] = await Promise.all([
    getGuildConfig(client, guildId),
    getTicketData(guildId, channelId)
  ]);

  const hasManageChannels = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
  // Every role that sees the tickets may also handle them (GH #316, ticketStaffAccess.js).
  const staffRoleIds = interaction.guild ? await ticketStaffRoleIds(interaction.guild, config).catch(() => []) : [];
  if (config.ticketStaffRoleId) staffRoleIds.push(String(config.ticketStaffRoleId));
  const hasTicketStaffRole = staffRoleIds.some((id) => interaction.member.roles?.cache?.has(id));
  const isTicketCreator = Boolean(
    ticketData?.userId && String(ticketData.userId) === String(interaction.user.id),
  );

  return {
    config,
    ticketData,
    hasManageChannels,
    hasTicketStaffRole,
    isTicketCreator,
    canManageTicket: hasManageChannels || hasTicketStaffRole,
    canCloseTicket: hasManageChannels || hasTicketStaffRole || isTicketCreator,
  };
}