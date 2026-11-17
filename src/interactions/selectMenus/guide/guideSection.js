import { GUIDE_MENU_PREFIX, buildGuidePayload } from '../../../services/cc/guideUi.js';

// The sections menu of the `شرح` guide (report #283): shows the chosen section, or the contents page,
// in place of the current one. `guide:<guildId>`: the server the guide was asked from (0 when unknown).
async function execute(interaction, client, [guildId]) {
    const section = interaction.values?.[0];
    await interaction.update(buildGuidePayload({ guildId: guildId === '0' ? null : guildId, section }));
}

export default { name: GUIDE_MENU_PREFIX, execute };
