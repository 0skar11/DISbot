// Server owners: they get owner-only access (purge, trust, protected boards, anti-raid trust).
// 1308224908576428079 (izatona) was removed as an owner by the owner's request (report #149).
// 626263734704275487 was added as an owner by the owner's request.
export const SERVER_OWNER_IDS = ['1159601661392715906', '626263734704275487'];

export function isServerOwner(userId) {
  return SERVER_OWNER_IDS.includes(String(userId));
}

// Members the owner allowed to give and take back Trust (`تراست` / `انتراست` / `trust` / `untrust` and the trusted
// list), without any other owner power (purge, protected boards, anti-raid trust stay owner-only).
export const TRUST_MANAGER_IDS = ['626263734704275487'];

export function isTrustManager(userId) {
  return isServerOwner(userId) || TRUST_MANAGER_IDS.includes(String(userId));
}
