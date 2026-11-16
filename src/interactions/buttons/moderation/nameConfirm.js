import { NAME_CONFIRM_PREFIX, handleNameConfirmButton } from '../../../services/moderation/nameConfirmation.js';

// The ✅ تأكيد / ❌ إلغاء / candidate buttons under `هل تقصد @member؟` (typed admin commands by name,
// services/moderation/nameConfirmation.js): `nm:confirm:<id>`, `nm:cancel:<id>`, `nm:pick:<id>:<index>`.
export default { name: NAME_CONFIRM_PREFIX, execute: handleNameConfirmButton };
