import { MessageFlags } from 'discord.js';
import { isServerOwner } from '../../../config/serverOwners.js';
import { isHomeGuild } from '../../../config/homeGuild.js';
import { resetAllCC } from '../../../services/cc/ccResetService.js';
import { formatCC } from '../../../config/cc.js';

// `resetcc_confirm:<ownerId>:<expiresAt>` and `resetcc_cancel:<ownerId>` (services/cc/ccResetService.js).
const privately = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
const done = (content) => ({ content, components: [], allowedMentions: { parse: [] } });

function allowed(interaction, ownerId) {
    return interaction.inGuild() && isHomeGuild(interaction.guildId) && isServerOwner(interaction.user.id) && interaction.user.id === ownerId;
}

export default [
    {
        name: 'resetcc_confirm',
        async execute(interaction, client, [ownerId, expiresAt]) {
            if (!allowed(interaction, ownerId)) return privately(interaction, '❌ الزرار ده للأونر اللي كتب الأمر بس.');
            if (!Number.isFinite(Number(expiresAt)) || Date.now() > Number(expiresAt)) {
                return interaction.update(done('⌛ انتهت المهلة. اكتب `resetcc` من جديد.')).catch(() => {});
            }
            await interaction.deferUpdate().catch(() => {});
            const { members, cleared, holdings } = await resetAllCC(client);
            await interaction.editReply(done(`✅ اتعمل ريسيت: **${members}** عضو رجعوا 0 (اتمسح ${formatCC(cleared)} وممتلكات بورصة في ${holdings} أصل).`)).catch(() => {});
        },
    },
    {
        name: 'resetcc_cancel',
        async execute(interaction, client, [ownerId]) {
            if (!allowed(interaction, ownerId)) return privately(interaction, '❌ الزرار ده للأونر اللي كتب الأمر بس.');
            await interaction.update(done('✖️ اتلغى.')).catch(() => {});
        },
    },
];
