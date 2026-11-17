import { SlashCommandBuilder } from 'discord.js';
import { handleRemoveBgInteraction } from '../../services/backgroundRemoval/removeBgService.js';

// `/removebg image:<picture>` (report #286): the picture back as a PNG with a transparent background.
// Typed: `.شيل الخلفية` / `.removebg` (events/messageCreate.js, removeBgService.js); the plain word stays chat.
export default {
    data: new SlashCommandBuilder()
        .setName('removebg')
        .setDescription('Remove the background from a picture (PNG with a transparent background)')
        .setDMPermission(false)
        .addAttachmentOption((option) => option
            .setName('image')
            .setDescription('The picture (up to 8 MB)')
            .setRequired(true)),
    slashOnly: true,

    async execute(interaction) {
        await handleRemoveBgInteraction(interaction);
    },
};
