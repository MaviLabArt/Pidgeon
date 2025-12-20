import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools";
import { BunkerSigner as NBunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { REQUIRED_NIP46_PERMS_CSV } from "./nip46Perms.js";
import { attachNip46Debug } from "./nip46Debug.js";

const CONNECT_TIMEOUT_MS = 90_000;
const SIGN_TIMEOUT_MS = 120_000;
const NIP44_TIMEOUT_MS = 30_000;
const NIP04_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class BunkerSigner {
  signer = null;
  clientSecretKey;
  pubkey = null;
  connectPromise = null;
  allowSecretOnConnect = true;

  constructor(clientSecretKey) {
    this.clientSecretKey = clientSecretKey ? hexToBytes(clientSecretKey) : generateSecretKey();
  }

  async ensureConnect() {
    if (!this.signer) throw new Error("Not logged in");
    if (this.connectPromise) return this.connectPromise;

    const remotePubkey = this.signer.bp?.pubkey;
    if (!remotePubkey) throw new Error("Missing remote signer pubkey");

    const connectOnce = async (secret) =>
      withTimeout(
        this.signer.sendRequest("connect", [remotePubkey, secret || "", REQUIRED_NIP46_PERMS_CSV]),
        CONNECT_TIMEOUT_MS,
        "remote signer connect"
      );

    this.connectPromise = (async () => {
      const secret = this.allowSecretOnConnect ? this.signer.bp?.secret || "" : "";
      try {
        return await connectOnce(secret);
      } catch (err) {
        // Some bunkers use one-time secrets; retry without secret for reconnects.
        if (secret) {
          return await connectOnce("");
        }
        throw err;
      }
    })().catch((err) => {
      this.connectPromise = null;
      throw err;
    });

    return this.connectPromise;
  }

  async login(bunker, isInitialConnection = true) {
    const bunkerPointer = await parseBunkerInput(bunker);
    if (!bunkerPointer) {
      throw new Error("Invalid bunker URI");
    }
    this.signer = NBunkerSigner.fromBunker(this.clientSecretKey, bunkerPointer, {
      onauth: (url) => {
        try {
          console.debug("nip46:bunker auth challenge", url);
        } catch {}
        const popup = window.open(url, "_blank");
        if (!popup) {
          window.location.href = url;
        }
      }
    });
    attachNip46Debug(this.signer, "bunker");
    this.allowSecretOnConnect = Boolean(isInitialConnection);
    // Best effort: connect early so nip44 methods don't hang later.
    await this.ensureConnect();
    this.pubkey = await this.signer.getPublicKey();
    return this.pubkey;
  }

  async getPublicKey() {
    if (!this.signer) throw new Error("Not logged in");
    if (!this.pubkey) {
      this.pubkey = await this.signer.getPublicKey();
    }
    return this.pubkey;
  }

  async signEvent(draftEvent) {
    if (!this.signer) throw new Error("Not logged in");
    return withTimeout(this.signer.signEvent(draftEvent), SIGN_TIMEOUT_MS, "remote signer sign_event");
  }

  async nip04Encrypt(pubkey, plainText) {
    if (!this.signer) throw new Error("Not logged in");
    return await withTimeout(this.signer.nip04Encrypt(pubkey, plainText), NIP04_TIMEOUT_MS, "remote signer nip04_encrypt");
  }

  async nip04Decrypt(pubkey, cipherText) {
    if (!this.signer) throw new Error("Not logged in");
    return await withTimeout(this.signer.nip04Decrypt(pubkey, cipherText), NIP04_TIMEOUT_MS, "remote signer nip04_decrypt");
  }

  async nip44Encrypt(pubkey, plainText) {
    if (!this.signer?.nip44Encrypt) throw new Error("nip44 not supported by remote signer");
    await this.ensureConnect();
    return await withTimeout(this.signer.nip44Encrypt(pubkey, plainText), NIP44_TIMEOUT_MS, "remote signer nip44_encrypt");
  }

  async nip44Decrypt(pubkey, cipherText) {
    if (!this.signer?.nip44Decrypt) throw new Error("nip44 not supported by remote signer");
    await this.ensureConnect();
    return await withTimeout(this.signer.nip44Decrypt(pubkey, cipherText), NIP44_TIMEOUT_MS, "remote signer nip44_decrypt");
  }

  getClientSecretKey() {
    return bytesToHex(this.clientSecretKey);
  }
}
