import { SlashCommandBuilder } from 'discord.js';
import { handleCaptionInteraction } from '../../services/caption/captionService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('caption')
    .setDescription('Add a top meme caption on a white background above a picture (Report #297)')
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('text')
      .setDescription('The caption text to write above the image')
      .setRequired(true))
    .addAttachmentOption((option) => option
      .setName('image')
      .setDescription('The picture to caption (up to 10 MB)')
      .setRequired(false)),

  async execute(interaction) {
    await handleCaptionInteraction(interaction);
  },
};
