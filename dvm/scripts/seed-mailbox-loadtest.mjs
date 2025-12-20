// Load-test seeding script for a running DVM + localhost relay.
import crypto from "crypto";
import { getSharedSecret } from "@noble/secp256k1";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { publish } from "@welshman/net";
import { normalizeRelayUrl } from "@welshman/util";

function usage(msg = "") {
  if (msg) console.error(msg);
  console.error(`
Seed Pidgeon with real Nostr data (exercises mailbox fetching + kind:1 fetching).

Required:
  --nsec <nsec>                 User key to sign notes + requests (use a throwaway test account)
  --dvm-pubkey <hex|npub>       DVM pubkey (the DVM prints it on boot)

Relay (localhost-only):
  --relay <ws://127.0.0.1:PORT> Publish requests to the DVM AND ask it to publish kind:1 to the same relay
                               (script refuses non-localhost relays)

Counts:
  --scheduled <n>               Future scheduled jobs (default 50)
  --posted <n>                  Past jobs to publish immediately (default 100)

Tuning:
  --concurrency <n>             Publish concurrency (default 3)
  --content-len <n>             Note content length chars (default 220)
  --scheduled-window-sec <n>    Spread scheduled times across window (default 1209600 = 14d)

Examples:
  node scripts/seed-mailbox-loadtest.mjs --nsec nsec1... --dvm-pubkey <hex> --relay ws://127.0.0.1:7777 --posted 120 --scheduled 60
`.trim());
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

function asInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRelays(input) {
  const list = String(input || "")
    .split(/[,\s]+/)
    .map((r) => normalizeRelayUrl(String(r || "").trim()))
    .filter(Boolean);
  return Array.from(new Set(list));
}

function isLocalhostRelay(relay) {
  const r = normalizeRelayUrl(relay);
  if (!r) return false;
  try {
    const u = new URL(r);
    if (!["ws:", "wss:"].includes(u.protocol)) return false;
    const host = String(u.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return false;
  }
}

function requireSingleLocalRelay(input, argName) {
  const relays = normalizeRelays(input);
  if (relays.length !== 1) {
    throw new Error(`${argName} must contain exactly 1 relay (got ${relays.length || 0})`);
  }
  const relay = relays[0];
  if (!isLocalhostRelay(relay)) {
    throw new Error(`${argName} must be a localhost relay (ws://127.0.0.1:PORT or ws://localhost:PORT)`);
  }
  return relay;
}

function decodeNsecToBytes(nsec) {
  if (!nsec) throw new Error("Missing --nsec");
  const decoded = nip19.decode(String(nsec).trim());
  if (decoded.type !== "nsec" || !decoded.data) throw new Error("Invalid nsec");
  return decoded.data;
}

function decodePubkeyHex(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (s.startsWith("npub1")) {
    const decoded = nip19.decode(s);
    if (decoded.type !== "npub" || !decoded.data) throw new Error("Invalid npub");
    return typeof decoded.data === "string" ? decoded.data : bytesToHex(decoded.data);
  }
  return s;
}

function nostrPubkeyToSecpCompressed(pubkeyHex) {
  const raw = hexToBytes(String(pubkeyHex || "").trim());
  if (raw.length !== 32) throw new Error("Invalid pubkey length (expected 32-byte hex)");
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(raw, 1);
  return compressed;
}

function deriveMasterKey({ userSkBytes, dvmPubkeyHex }) {
  const shared = getSharedSecret(userSkBytes, nostrPubkeyToSecpCompressed(dvmPubkeyHex), true).slice(1);
  const salt = Buffer.from("pidgeon:v3", "utf8");
  const info = Buffer.from(`pidgeon:v3:root:${dvmPubkeyHex}`, "utf8");
  const key = crypto.hkdfSync("sha256", shared, salt, info, 32);
  return new Uint8Array(key);
}

function deriveSubKey(rootKeyBytes, label) {
  const key = crypto.hkdfSync("sha256", Buffer.from(rootKeyBytes), Buffer.alloc(0), Buffer.from(label, "utf8"), 32);
  return new Uint8Array(key);
}

function makeContent({ kind, idx, createdAt, targetLen }) {
  const header = `${kind === "posted" ? "Posted" : "Scheduled"} load test #${idx + 1}`;
  const stamp = `ts=${createdAt}`;
  const base = `${header} (${stamp}) — `;
  const filler =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
  let out = base;
  while (out.length < targetLen) out += filler;
  return out.slice(0, targetLen);
}

function buildScheduleWrap({
  userSkBytes,
  userPubkey,
  dvmPubkey,
  submitKey,
  publishRelays,
  signedNote
}) {
  const inputTags = [["i", JSON.stringify(signedNote), "text"]];
  if (publishRelays.length) inputTags.push(["relays", ...publishRelays]);
  const requestContent = nip44.v2.encrypt(JSON.stringify({ tags: inputTags }), submitKey);

  const rumor = {
    kind: 5905,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", dvmPubkey],
      ["k", "3"],
      ...(publishRelays.length ? [["relays", ...publishRelays]] : [])
    ],
    content: requestContent,
    pubkey: userPubkey
  };
  rumor.id = getEventHash(rumor);

  const sealKey = nip44.v2.utils.getConversationKey(userSkBytes, dvmPubkey);
  const sealPayload = nip44.v2.encrypt(JSON.stringify(rumor), sealKey);
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: sealPayload,
      pubkey: userPubkey
    },
    userSkBytes
  );

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, dvmPubkey);
  const wrapPayload = nip44.v2.encrypt(JSON.stringify(seal), wrapKey);
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", dvmPubkey]],
      content: wrapPayload,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

async function publishMany({ relays, events, concurrency }) {
  const list = (events || []).filter(Boolean);
  if (!list.length) return;
  const max = Math.max(1, Math.min(concurrency || 1, list.length));
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) return;
      // eslint-disable-next-line no-await-in-loop
      await publish({ relays, event: list[idx] });
    }
  }
  await Promise.all(Array.from({ length: max }, () => worker()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const userSkBytes = decodeNsecToBytes(args.nsec);
  const userPubkey = getPublicKey(userSkBytes);

  const dvmPubkey = decodePubkeyHex(args["dvm-pubkey"]);
  if (!dvmPubkey) usage("Missing --dvm-pubkey (copy it from the DVM logs on startup)");

  const relay = requireSingleLocalRelay(args.relay, "--relay");
  const dvmRelays = [relay];
  const publishRelays = [relay];
  const scheduledCount = Math.max(0, asInt(args.scheduled, 50));
  const postedCount = Math.max(0, asInt(args.posted, 100));
  const concurrency = Math.max(1, Math.min(16, asInt(args.concurrency, 3)));
  const contentLen = Math.max(20, Math.min(5000, asInt(args["content-len"], 220)));
  const scheduledWindowSec = Math.max(60, asInt(args["scheduled-window-sec"], 14 * 24 * 3600));

  const rootKey = deriveMasterKey({ userSkBytes, dvmPubkeyHex: dvmPubkey });
  const submitKey = deriveSubKey(rootKey, "pidgeon:v3:key:submit");
  const now = Math.floor(Date.now() / 1000);

  console.log("[seed] user", userPubkey);
  console.log("[seed] dvm", dvmPubkey);
  console.log("[seed] relay", relay);
  console.log("[seed] counts", { posted: postedCount, scheduled: scheduledCount });

  const wraps = [];

  // Posted: schedule in the past so DVM publishes immediately.
  for (let i = 0; i < postedCount; i++) {
    const created_at = now - (postedCount - i) - 10; // unique, safely in the past
    const content = makeContent({ kind: "posted", idx: i, createdAt: created_at, targetLen: contentLen });
    const note = finalizeEvent(
      {
        kind: 1,
        created_at,
        tags: [["t", "pidgeon-loadtest"], ["t", "posted"]],
        content,
        pubkey: userPubkey
      },
      userSkBytes
    );
    wraps.push(
      buildScheduleWrap({
        userSkBytes,
        userPubkey,
        dvmPubkey,
        submitKey,
        publishRelays,
        signedNote: note
      })
    );
  }

  // Scheduled: spread across a window into the future.
  for (let i = 0; i < scheduledCount; i++) {
    const slot = Math.floor(((i + 1) * scheduledWindowSec) / (scheduledCount + 1));
    const created_at = now + 60 + slot + i; // ensure uniqueness
    const content = makeContent({ kind: "scheduled", idx: i, createdAt: created_at, targetLen: contentLen });
    const note = finalizeEvent(
      {
        kind: 1,
        created_at,
        tags: [["t", "pidgeon-loadtest"], ["t", "scheduled"]],
        content,
        pubkey: userPubkey
      },
      userSkBytes
    );
    wraps.push(
      buildScheduleWrap({
        userSkBytes,
        userPubkey,
        dvmPubkey,
        submitKey,
        publishRelays,
        signedNote: note
      })
    );
  }

  console.log(`[seed] publishing ${wraps.length} wrapped requests to DVM relays (concurrency=${concurrency})…`);
  await publishMany({ relays: dvmRelays, events: wraps, concurrency });
  console.log("[seed] done. Open the client and wait for mailbox rev to update; posted notes will hydrate via kind:1 fetch.");
}

main().catch((err) => {
  usage(err?.message || String(err));
});
