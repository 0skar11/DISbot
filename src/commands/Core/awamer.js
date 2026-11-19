import { SlashCommandBuilder } from 'discord.js';
import { buildAwamerMainPayload } from '../../services/help/awamerService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('awamer')
    .setDescription('عرض دليل أوامر البوت التفاعلي (GUI) مقسمة لأقسام للإدارة والأعضاء')
    .setDMPermission(false),

  async execute(interaction) {
    const payload = buildAwamerMainPayload(interaction.client);
    await interaction.reply(payload).catch(() => {});
  },
};
