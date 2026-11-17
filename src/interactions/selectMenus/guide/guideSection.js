import { GUIDE_MENU_PREFIX, buildGuidePayload } from '../../../services/cc/guideUi.js';
import { isMovedCCCommand } from '../../../config/commands/commandAvailability.js';

// The sections menu of the `شرح` guide (report #283): shows the chosen section, or the contents page,
// in place of the current one. `guide:<guildId>`: the server the guide was asked from (0 when unknown).
// The guide moved to the CC bot (report #287): a menu left in an old DM is acknowledged without a change.
async function execute(interaction, client, [guildId]) {
    if (isMovedCCCommand('guide')) {
        await Promise.resolve(interaction.deferUpdate?.()).catch(() => {});
        return;
    }
    const section = interaction.values?.[0];
    await interaction.update(buildGuidePayload({ guildId: guildId === '0' ? null : guildId, section }));
}

export default { name: GUIDE_MENU_PREFIX, execute };
