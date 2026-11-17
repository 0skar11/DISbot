import { AUTOMOD_BUTTON, handleAutomodButton } from '../../../services/moderation/automodCommand.js';

// The buttons of the `automod` list (services/moderation/automodCommand.js): `automod:<page|add|remove|test>:<guildId>:<page>`.
// Only the server owners can use them; anyone else gets a private "owners only", an old list a polite note.
export default { name: AUTOMOD_BUTTON, execute: handleAutomodButton };
