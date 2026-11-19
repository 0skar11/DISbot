import { buildAwamerCategoryPayload } from '../../../services/help/awamerService.js';

export default {
  name: 'awamer_select',
  async execute(interaction, client) {
    const selectedCategory = interaction.values?.[0];
    const payload = buildAwamerCategoryPayload(client, selectedCategory);
    await interaction.update(payload).catch(() => {});
  },
};
