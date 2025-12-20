import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api.js";
import { Nip07Signer } from "../nostr/auth/nip07Signer.js";
import { NsecSigner } from "../nostr/auth/nsecSigner.js";
import { BunkerSigner } from "../nostr/auth/bunkerSigner.js";
import { NostrConnectionSigner } from "../nostr/auth/nostrConnectionSigner.js";
import { NpubSigner } from "../nostr/auth/npubSigner.js";
import { ensureMailboxSecrets } from "../nostr/dvm.js";
import LoginDialog from "../components/nostr/LoginDialog.jsx";
import { bytesToHex } from "@noble/hashes/utils";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";

const STORAGE_KEYS = {
  accounts: "nostr:accounts:v2",
  current: "nostr:current-account",
  secrets: "nostr:account-secrets:v1"
};
const AUTO_LOGIN_DISABLED = "nostr:auto-login-disabled";

const DEFAULT_STATE = {
  pubkey: "",
  account: null,
  signerType: "",
  sessionPubkey: ""
};

const NostrContext = createContext(undefined);

function isServerSessionEnabled() {
  try {
    return typeof import.meta !== "undefined" && import.meta.env?.VITE_ENABLE_SERVER_SESSION === "1";
  } catch {
    return false;
  }
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function shortKey(key = "") {
  const str = String(key || "");
  if (!str) return "";
  if (str.length <= 12) return str;
  return `${str.slice(0, 6)}…${str.slice(-6)}`;
}

function stripBunkerSecret(uri = "") {
  try {
    const url = new URL(String(uri));
    url.searchParams.delete("secret");
    return url.toString();
  } catch {
    return String(uri || "");
  }
}

function buildNostrShim(signer) {
  const nip04Encrypt =
    (typeof signer?.nip04Encrypt === "function" && signer.nip04Encrypt.bind(signer)) ||
    (typeof signer?.nip04?.encrypt === "function" && signer.nip04.encrypt.bind(signer.nip04));
  const nip04Decrypt =
    (typeof signer?.nip04Decrypt === "function" && signer.nip04Decrypt.bind(signer)) ||
    (typeof signer?.nip04?.decrypt === "function" && signer.nip04.decrypt.bind(signer.nip04));
  const nip44Encrypt =
    (typeof signer?.nip44Encrypt === "function" && signer.nip44Encrypt.bind(signer)) ||
    (typeof signer?.nip44?.encrypt === "function" && signer.nip44.encrypt.bind(signer.nip44));
  const nip44Decrypt =
    (typeof signer?.nip44Decrypt === "function" && signer.nip44Decrypt.bind(signer)) ||
    (typeof signer?.nip44?.decrypt === "function" && signer.nip44.decrypt.bind(signer.nip44));

  const pickArgs = (params, payloadKeys = []) => {
    if (Array.isArray(params)) return params;
    if (params && typeof params === "object") {
      const payloadKey = payloadKeys.find((key) => params[key] !== undefined);
      return [params.pubkey || params.p, payloadKey ? params[payloadKey] : undefined];
    }
    return [params];
  };

  const call = async (method, params = []) => {
    switch (method) {
      case "getPublicKey":
        return signer.getPublicKey();
      case "signEvent":
        return signer.signEvent(Array.isArray(params) ? params[0] : params);
      case "nip04.encrypt":
      case "nip04_encrypt":
        if (nip04Encrypt) {
          const [pubkey, content] = pickArgs(params, ["plaintext", "content"]);
          return nip04Encrypt(pubkey, content);
        }
        throw new Error("nip04 not available");
      case "nip04.decrypt":
      case "nip04_decrypt":
        if (nip04Decrypt) {
          const [pubkey, content] = pickArgs(params, ["ciphertext", "content"]);
          return nip04Decrypt(pubkey, content);
        }
        throw new Error("nip04 not available");
      case "nip44.encrypt":
      case "nip44_encrypt":
        if (nip44Encrypt) {
          const [pubkey, content] = pickArgs(params, ["plaintext", "content"]);
          return nip44Encrypt(pubkey, content);
        }
        throw new Error("nip44 not available");
      case "nip44.decrypt":
      case "nip44_decrypt":
        if (nip44Decrypt) {
          const [pubkey, content] = pickArgs(params, ["ciphertext", "content"]);
          return nip44Decrypt(pubkey, content);
        }
        throw new Error("nip44 not available");
      default:
        throw new Error(`Unsupported nostr call: ${method}`);
    }
  };

  return {
    _call: call,
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (draftEvent) => signer.signEvent(draftEvent),
    nip04Encrypt: nip04Encrypt || (() => Promise.reject(new Error("nip04 not available"))),
    nip04Decrypt: nip04Decrypt || (() => Promise.reject(new Error("nip04 not available"))),
    nip44Encrypt: nip44Encrypt || (() => Promise.reject(new Error("nip44 not available"))),
    nip44Decrypt: nip44Decrypt || (() => Promise.reject(new Error("nip44 not available"))),
    nip04: {
      encrypt: nip04Encrypt || (() => Promise.reject(new Error("nip04 not available"))),
      decrypt: nip04Decrypt || (() => Promise.reject(new Error("nip04 not available")))
    },
    nip44: {
      encrypt: nip44Encrypt || (() => Promise.reject(new Error("nip44 not available"))),
      decrypt: nip44Decrypt || (() => Promise.reject(new Error("nip44 not available")))
    }
  };
}

function buildLazyNostrShim(getSigner) {
  const run = async (fn) => {
    const signer = await getSigner();
    const shim = buildNostrShim(signer);
    return fn(shim);
  };

  const shim = {
    __pidgeonShim: true,
    _call: (method, params) => run((s) => s._call(method, params)),
    getPublicKey: () => run((s) => s.getPublicKey()),
    signEvent: (draftEvent) => run((s) => s.signEvent(draftEvent)),
    nip04Encrypt: (pubkey, plaintext) => run((s) => s.nip04Encrypt(pubkey, plaintext)),
    nip04Decrypt: (pubkey, ciphertext) => run((s) => s.nip04Decrypt(pubkey, ciphertext)),
    nip44Encrypt: (pubkey, plaintext) => run((s) => s.nip44Encrypt(pubkey, plaintext)),
    nip44Decrypt: (pubkey, ciphertext) => run((s) => s.nip44Decrypt(pubkey, ciphertext)),
    nip04: {
      encrypt: (pubkey, plaintext) => run((s) => s.nip04.encrypt(pubkey, plaintext)),
      decrypt: (pubkey, ciphertext) => run((s) => s.nip04.decrypt(pubkey, ciphertext))
    },
    nip44: {
      encrypt: (pubkey, plaintext) => run((s) => s.nip44.encrypt(pubkey, plaintext)),
      decrypt: (pubkey, ciphertext) => run((s) => s.nip44.decrypt(pubkey, ciphertext))
    }
  };

  return shim;
}

function isPidgeonShim(nostr) {
  return Boolean(nostr?.__pidgeonShim);
}

function setGlobalSigner(signer) {
  if (typeof window === "undefined") return;
  if (signer) {
    window.nostrSigner = signer;
  } else {
    delete window.nostrSigner;
  }
}

export function useNostr() {
  const ctx = useContext(NostrContext);
  if (!ctx) throw new Error("useNostr must be used within NostrProvider");
  return ctx;
}

export function NostrProvider({ children }) {
  const [state, setState] = useState(DEFAULT_STATE);
  const [accounts, setAccounts] = useState(() => readJSON(STORAGE_KEYS.accounts, []));
  const [accountSecrets, setAccountSecrets] = useState(() => readJSON(STORAGE_KEYS.secrets, {}));
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [signer, setSigner] = useState(null);
  const [isBindingSession, setIsBindingSession] = useState(false);
  const originalNostrRef = useRef(typeof window !== "undefined" ? window.nostr : undefined);
  const signerRef = useRef(null);
  const pendingSwitchPromiseRef = useRef(null);
  const restoreStartedRef = useRef(false);
  const lazyShimRef = useRef(null);

  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);

  if (!lazyShimRef.current) {
    lazyShimRef.current = buildLazyNostrShim(async () => {
      if (signerRef.current) return signerRef.current;
      const pending = pendingSwitchPromiseRef.current;
      if (pending) {
        await pending;
        if (signerRef.current) return signerRef.current;
      }
      throw new Error("Connect a Nostr signer first");
    });
  }

  // Implicit provisioning: as soon as we have a signer+pubkey, start fetching (and if needed requesting)
  // the mailbox master secrets in the background. This avoids user-visible "master step" later.
  useEffect(() => {
    let cancelled = false;
    if (!signer || !state.pubkey || state.signerType === "npub") return;
    ensureMailboxSecrets(state.pubkey)
      .then(() => {
        if (cancelled) return;
        try {
          console.debug("[dvm] mailbox secrets ready");
        } catch {}
      })
      .catch((err) => {
        if (cancelled) return;
        // Non-fatal: scheduling will surface a friendly error if secrets can't be obtained.
        console.warn("[dvm] mailbox secrets bootstrap failed", err?.message || err);
      });
    return () => {
      cancelled = true;
    };
  }, [signer, state.pubkey, state.signerType]);

  // keep window.nostr shim in sync with the active signer
  useEffect(() => {
    const removeShim = (shim) => {
      if (window.nostrShim === shim) {
        delete window.nostrShim;
      }
      if (window.nostr === shim) {
        if (originalNostrRef.current) {
          window.nostr = originalNostrRef.current;
        } else {
          delete window.nostr;
        }
      }
    };

    if (!state.signerType || state.signerType === "nip07") {
      // No active signer or nip07 is handled by the extension directly.
      removeShim(window.nostrShim);
      return;
    }

    if (window.nostr && !isPidgeonShim(window.nostr)) {
      originalNostrRef.current = window.nostr;
    }

    const shim = lazyShimRef.current;
    window.nostrShim = shim;
    // Always expose the shim on window.nostr so any consumer (_call, nip04, etc.)
    // uses the active signer and never falls back to a NIP-07 extension by mistake.
    window.nostr = shim;

    return () => removeShim(shim);
  }, [state.signerType]);

  // on mount: restore session from server and attempt auto-login from stored account
  useEffect(() => {
    if (restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    const restore = async () => {
      try {
        const resp = await api.get("/nostr/me");
        const pk = resp?.data?.pubkey ? String(resp.data.pubkey) : "";
        if (pk) {
          setState((prev) => ({ ...prev, sessionPubkey: pk, pubkey: pk }));
          try {
            window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: pk } }));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      const storedAccounts = readJSON(STORAGE_KEYS.accounts, []);
      setAccounts(storedAccounts);
      const disableAutoLogin = localStorage.getItem(AUTO_LOGIN_DISABLED) === "1";
      if (disableAutoLogin) return;

      const currentPointer = readJSON(STORAGE_KEYS.current, null);
      const target = currentPointer || storedAccounts[0];
      if (!target) return;
      try {
        // Install a lazy shim immediately so any early window.nostr usages (drafts, nip98, etc.)
        // won't accidentally call a NIP-07 extension while we are restoring a non-nip07 session.
        if (target.signerType && target.signerType !== "nip07") {
          if (window.nostr && !isPidgeonShim(window.nostr)) {
            originalNostrRef.current = window.nostr;
          }
          window.nostrShim = lazyShimRef.current;
          window.nostr = lazyShimRef.current;
        }

        // Optimistic session restoration: show the account immediately, then hydrate signer.
        // This avoids "logged out on refresh" even when the signer init/bind takes a moment.
        setState((prev) => ({
          ...prev,
          pubkey: target.pubkey || "",
          account: target,
          signerType: target.signerType || "",
          sessionPubkey: ""
        }));

        // Retry auto-login a few times (useful for late-injected NIP-07 extensions).
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await switchAccount(target);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const msg = String(err?.message || err || "");
            const canRetry = target.signerType === "nip07" && /nip-07|NIP-07|Install a NIP-07/i.test(msg);
            if (!canRetry) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
          }
        }
        if (lastErr) throw lastErr;
      } catch (err) {
        console.warn("[nostr] auto-login failed", err?.message || err);
      }
    };
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistAccounts = (nextAccounts, nextSecrets) => {
    setAccounts(nextAccounts);
    writeJSON(STORAGE_KEYS.accounts, nextAccounts);
    if (nextSecrets) {
      setAccountSecrets(nextSecrets);
      writeJSON(STORAGE_KEYS.secrets, nextSecrets);
    }
  };

  const bindServerSession = async (activeSigner, pubkey) => {
    setIsBindingSession(true);
    try {
      const challenge = await api
        .get("/nostr/login/challenge")
        .then((r) => r.data?.challenge)
        .catch((err) => {
          throw new Error(err?.response?.data?.error || "Login challenge failed");
        });
      if (!challenge) throw new Error("Missing challenge");
      const ev = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challenge],
          ["domain", window.location.host]
        ],
        content: `Login to ${window.location.host}`,
        pubkey
      };
      const signed = await activeSigner.signEvent(ev);
      await api.post("/nostr/login/verify", { event: signed });
      setState((prev) => ({ ...prev, sessionPubkey: pubkey, pubkey }));
      try {
        window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey } }));
        window.dispatchEvent(new CustomEvent("nostr:session-bound", { detail: { pubkey } }));
      } catch {
        /* ignore */
      }
      return true;
    } finally {
      setIsBindingSession(false);
    }
  };

  const applyLogin = async ({ signerInstance, accountPointer, secretsUpdate }) => {
    const pubkey = await signerInstance.getPublicKey();
    localStorage.removeItem(AUTO_LOGIN_DISABLED);
    signerRef.current = signerInstance;
    setSigner(signerInstance);
    setGlobalSigner(signerInstance);
    setState((prev) => ({
      ...prev,
      pubkey,
      account: accountPointer,
      signerType: accountPointer.signerType,
      sessionPubkey: ""
    }));

    const nextAccounts = upsertAccount(accounts, accountPointer);
    const nextSecrets = { ...accountSecrets };
    if (secretsUpdate?.pubkey) {
      nextSecrets[secretsUpdate.pubkey] = {
        ...(nextSecrets[secretsUpdate.pubkey] || {}),
        ...secretsUpdate.secret
      };
    }
    persistAccounts(nextAccounts, nextSecrets);
    writeJSON(STORAGE_KEYS.current, accountPointer);
    if (isServerSessionEnabled()) {
      await bindServerSession(signerInstance, pubkey).catch((err) => {
        console.warn("[nostr] binding server session failed", err?.message || err);
      });
    }
  };

  const startLogin = () => setLoginDialogOpen(true);
  const closeLogin = () => setLoginDialogOpen(false);

  const nip07Login = async () => {
    // Ensure we talk to the actual NIP-07 extension (nos2x, Alby, etc.),
    // not a Pidgeon window.nostr shim from a previous session.
    if (typeof window !== "undefined" && isPidgeonShim(window.nostr)) {
      if (originalNostrRef.current) {
        window.nostr = originalNostrRef.current;
      } else {
        delete window.nostr;
      }
      delete window.nostrShim;
    }
    const signerInstance = new Nip07Signer();
    await signerInstance.init();
    const pubkey = await signerInstance.getPublicKey();
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "nip07" }
    });
    closeLogin();
    return pubkey;
  };

  const nsecLogin = async (nsec, password) => {
    if (!nsec) throw new Error("Private key required");
    if (String(nsec).startsWith("ncryptsec")) {
      return ncryptsecLogin(nsec, password);
    }
    const signerInstance = new NsecSigner();
    const pubkey = signerInstance.login(nsec);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "nsec" },
      secretsUpdate: { pubkey, secret: { nsec } }
    });
    closeLogin();
    return pubkey;
  };

  const ncryptsecLogin = async (ncryptsec, password) => {
    if (!password) throw new Error("Password required for ncryptsec");
    const privkey = await nip49.decrypt(ncryptsec, password);
    const nsec = nip19.nsecEncode(privkey);
    const signerInstance = new NsecSigner();
    const pubkey = signerInstance.login(privkey);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "ncryptsec" },
      secretsUpdate: { pubkey, secret: { ncryptsec, nsec } }
    });
    closeLogin();
    return pubkey;
  };

  const bunkerLogin = async (bunker) => {
    if (!bunker) throw new Error("Bunker URL required");
    const existing = Object.values(accountSecrets || {}).find(
      (secret) => stripBunkerSecret(secret?.bunker) === stripBunkerSecret(bunker)
    )?.bunkerClientKey;
    const signerInstance = new BunkerSigner(existing);
    const pubkey = await signerInstance.login(bunker, !existing);
    const clientSecretKey = signerInstance.getClientSecretKey();
    const bunkerUrl = stripBunkerSecret(bunker) || bunker;
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "bunker", bunker: bunkerUrl },
      secretsUpdate: { pubkey, secret: { bunker, bunkerClientKey: clientSecretKey } }
    });
    closeLogin();
    return pubkey;
  };

  const nostrConnectionLogin = async (clientSecretKey, connectionString) => {
    if (!clientSecretKey || !connectionString) {
      throw new Error("Missing Nostr Connect credentials");
    }
    const signerInstance = new NostrConnectionSigner(clientSecretKey, connectionString);
    const { pubkey, bunkerString } = await signerInstance.login();
    const bunkerUrl = stripBunkerSecret(bunkerString) || bunkerString;
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "nostrconnect", bunker: bunkerUrl },
      secretsUpdate: { pubkey, secret: { bunker: bunkerString, bunkerClientKey: bytesToHex(clientSecretKey) } }
    });
    closeLogin();
    return pubkey;
  };

  const npubLogin = async (npub) => {
    const signerInstance = new NpubSigner();
    const pubkey = signerInstance.login(npub);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "npub" }
    });
    closeLogin();
    return pubkey;
  };

  const logout = async () => {
    try {
      await api.post("/nostr/logout");
    } catch {
      /* ignore */
    }
    localStorage.setItem(AUTO_LOGIN_DISABLED, "1"); // prevent auto-login on next load
    setSigner(null);
    setGlobalSigner(null);
    setState(DEFAULT_STATE);
    writeJSON(STORAGE_KEYS.current, null);
    try {
      window.dispatchEvent(new Event("nostr:logout"));
      window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: "" } }));
    } catch {
      /* ignore */
    }
  };

  const removeAccount = (pointer) => {
    const filtered = accounts.filter((acc) => acc.pubkey !== pointer.pubkey);
    const nextSecrets = { ...accountSecrets };
    delete nextSecrets[pointer.pubkey];
    persistAccounts(filtered, nextSecrets);
    if (state.account?.pubkey === pointer.pubkey) {
      logout();
    }
  };

  async function switchAccount(pointer) {
    const promise = (async () => {
      if (!pointer) {
        await logout();
        return;
      }
      const secrets = accountSecrets[pointer.pubkey] || {};
      let signerInstance = null;
      let pointerToUse = pointer;
      if (pointer.signerType === "nip07") {
        // Ensure we use the real NIP-07 extension, not a Pidgeon shim left from another login.
        if (typeof window !== "undefined" && isPidgeonShim(window.nostr)) {
          if (originalNostrRef.current) {
            window.nostr = originalNostrRef.current;
          } else {
            delete window.nostr;
          }
          delete window.nostrShim;
        }
        signerInstance = new Nip07Signer();
        await signerInstance.init();
      } else if (pointer.signerType === "nsec") {
        if (!secrets.nsec) throw new Error("No saved nsec for this account");
        signerInstance = new NsecSigner();
        signerInstance.login(secrets.nsec);
      } else if (pointer.signerType === "ncryptsec") {
        if (secrets.nsec) {
          signerInstance = new NsecSigner();
          signerInstance.login(secrets.nsec);
        } else {
          throw new Error("Password required to unlock this account");
        }
      } else if (pointer.signerType === "bunker") {
        const bunkerInput = secrets.bunker || pointer.bunker;
        if (!bunkerInput) throw new Error("Missing bunker URL");
        const bunkerUrl = stripBunkerSecret(bunkerInput) || bunkerInput;
        signerInstance = new BunkerSigner(secrets.bunkerClientKey);
        await signerInstance.login(bunkerInput, !secrets.bunkerClientKey);
        pointerToUse = { ...pointer, bunker: bunkerUrl };
      } else if (pointer.signerType === "nostrconnect") {
        const bunkerInput = secrets.bunker || pointer.bunker;
        if (!bunkerInput) throw new Error("Missing Nostr Connect bunker URL");
        const bunkerUrl = stripBunkerSecret(bunkerInput) || bunkerInput;
        signerInstance = new BunkerSigner(secrets.bunkerClientKey);
        await signerInstance.login(bunkerInput, !secrets.bunkerClientKey);
        pointerToUse = { ...pointer, bunker: bunkerUrl };
      } else if (pointer.signerType === "npub") {
        signerInstance = new NpubSigner();
        signerInstance.login(pointer.npub || nip19.npubEncode(pointer.pubkey));
      } else {
        throw new Error("Unsupported account type");
      }
      await applyLogin({
        signerInstance,
        accountPointer: pointerToUse
      });
    })();

    pendingSwitchPromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (pendingSwitchPromiseRef.current === promise) {
        pendingSwitchPromiseRef.current = null;
      }
    }
  }

  const value = useMemo(
    () => ({
      pubkey: state.pubkey,
      sessionPubkey: state.sessionPubkey,
      signerType: state.signerType,
      account: state.account,
      accounts,
      accountSecrets,
      startLogin,
      closeLogin,
      nip07Login,
      nsecLogin,
      ncryptsecLogin,
      bunkerLogin,
      nostrConnectionLogin,
      npubLogin,
      logout,
      removeAccount,
      switchAccount,
      signEvent: (draftEvent) => signer?.signEvent(draftEvent),
      getPublicKey: () => signer?.getPublicKey(),
      nip04Encrypt: (pub, content) =>
        signer?.nip04Encrypt
          ? signer.nip04Encrypt(pub, content)
          : signer?.nip04?.encrypt
          ? signer.nip04.encrypt(pub, content)
          : Promise.reject(new Error(signer ? "nip04 not available" : "Connect a Nostr signer first")),
      nip04Decrypt: (pub, content) =>
        signer?.nip04Decrypt
          ? signer.nip04Decrypt(pub, content)
          : signer?.nip04?.decrypt
          ? signer.nip04.decrypt(pub, content)
          : Promise.reject(new Error(signer ? "nip04 not available" : "Connect a Nostr signer first")),
      shortKey,
      isBindingSession,
      hasSigner: !!signer
    }),
    [
      state.pubkey,
      state.sessionPubkey,
      state.signerType,
      state.account,
      accounts,
      accountSecrets,
      signer,
      isBindingSession
    ]
  );

  return (
    <NostrContext.Provider value={value}>
      {children}
      <LoginDialog open={loginDialogOpen} onClose={closeLogin} />
    </NostrContext.Provider>
  );
}

function upsertAccount(list, account) {
  const seen = new Set();
  const next = [];
  const all = [account, ...list];
  for (const acc of all) {
    if (!acc?.pubkey || seen.has(acc.pubkey)) continue;
    seen.add(acc.pubkey);
    next.push(acc);
  }
  return next;
}
