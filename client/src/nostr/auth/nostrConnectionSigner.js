import { bytesToHex } from "@noble/hashes/utils";
import { BunkerSigner as NBunkerSigner, toBunkerURL } from "nostr-tools/nip46";
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

export class NostrConnectionSigner {
  signer = null;
  clientSecretKey;
  pubkey = null;
  connectionString;
  bunkerString = null;
  connectPromise = null;

  constructor(clientSecretKey, connectionString) {
    this.clientSecretKey = clientSecretKey;
    this.connectionString = connectionString;
  }

  async ensureConnect() {
    if (!this.signer) throw new Error("Not logged in");
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = withTimeout(
      this.signer.sendRequest("connect", [
        this.signer.bp.pubkey,
        this.signer.bp.secret || "",
        REQUIRED_NIP46_PERMS_CSV
      ]),
      CONNECT_TIMEOUT_MS,
      "remote signer connect"
    ).catch((err) => {
      this.connectPromise = null;
      throw err;
    });
    return this.connectPromise;
  }

  async login() {
    if (this.pubkey) {
      return {
        bunkerString: this.bunkerString,
        pubkey: this.pubkey
      };
    }

    this.signer = await NBunkerSigner.fromURI(this.clientSecretKey, this.connectionString, {
      onauth: (url) => {
        try {
          console.debug("nip46:nostrconnect auth challenge", url);
        } catch {}
        const popup = window.open(url, "_blank");
        if (!popup) {
          window.location.href = url;
        }
      }
    });
    attachNip46Debug(this.signer, "nostrconnect");
    this.bunkerString = toBunkerURL(this.signer.bp);
    // Best effort: request permissions early so nip04/nip44 methods don't hang later.
    await this.ensureConnect();
    this.pubkey = await this.signer.getPublicKey();
    return {
      bunkerString: this.bunkerString,
      pubkey: this.pubkey
    };
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
    // Many signers require an explicit connect() with perms before allowing nip44 methods.
    // Fail with a clear timeout instead of hanging indefinitely.
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
