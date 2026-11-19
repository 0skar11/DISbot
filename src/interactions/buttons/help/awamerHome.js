import { buildAwamerMainPayload } from '../../../services/help/awamerService.js';

export default {
  name: 'awamer_home',
  async execute(interaction, client) {
    const payload = buildAwamerMainPayload(client);
    await interaction.update(payload).catch(() => {});
  },
};
