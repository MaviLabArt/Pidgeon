export const REQUIRED_NIP46_PERMS = [
  // Used for NIP-46 draft encryption/decryption (we encrypt drafts to self for portability).
  "nip44_encrypt",
  "nip44_decrypt",
  "sign_event:1",
  "sign_event:5",
  "sign_event:13",
  "sign_event:27235",
  // Draft events (kind 31234).
  "sign_event:31234"
];

export const REQUIRED_NIP46_PERMS_CSV = REQUIRED_NIP46_PERMS.join(",");
