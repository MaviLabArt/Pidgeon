import { nip44 } from "nostr-tools";

const b64uToBytes = (s = "") => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64u = (u8) =>
  btoa(String.fromCharCode(...u8))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const toU8 = (val) => (val instanceof Uint8Array ? val : new Uint8Array(val));

export function nip44EncryptWithKey(conversationKey, plaintext) {
  return nip44.v2.encrypt(plaintext, toU8(conversationKey));
}

export function nip44DecryptWithKey(conversationKey, payload) {
  return nip44.v2.decrypt(payload, toU8(conversationKey));
}

export function bytesToB64uString(u8) {
  return bytesToB64u(u8);
}

export function b64uToBytesSafe(s = "") {
  return b64uToBytes(s);
}
