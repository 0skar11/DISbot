import { AUTOMOD_FORM, handleAutomodForm } from '../../../services/moderation/automodCommand.js';

// The ➕ / ➖ / 🧪 forms of the `automod` list (services/moderation/automodCommand.js):
// `automodform:<add|remove|test>:<guildId>:<page>`. Checked again: the server owners only.
export default { name: AUTOMOD_FORM, execute: handleAutomodForm };
