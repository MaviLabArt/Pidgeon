# Pidgeon Job Ledger Scheduler Flow

This doc describes Pidgeon’s “job ledger is truth” scheduler architecture: wrapped NIP‑59 requests plus an encrypted job ledger state (kind `30078`) published by the DVM.

## Goals
- Job ledger state on Nostr is authoritative; UI can rebuild from relays (localStorage is cache-only).
- Privacy: relays cannot link job ledger coordinates to a user pubkey.
- Scale: bounded event growth via replaceable shards.
- UX: one NIP‑07 decrypt per device for jobs (master unwrap), no per‑job prompts.
- Add scheduled NIP‑17 DMs without affecting note scheduling.

## Core deterministic secrets
We keep the deterministic master‑key flow, but add a second deterministic secret: a job ledger id `mb`.

### Derivation (DVM)
In `dvm/src/index.js`, per-(user,DVM) secrets are derived (see `deriveMailboxSecrets(pubkey)`):

**HKDF requirements (to avoid cross-impl drift)**
- HKDF is RFC5869 **Extract+Expand** (not expand-only).
- `salt` / `info` are UTF‑8 bytes of the literal strings shown below.
- When `salt=""` is shown below, it means **zero-length bytes** (`[]` / `Buffer.alloc(0)`), not `null`/`undefined` and not “omit salt” (some libraries replace a missing salt with `HashLen` zeros, which would diverge).
- `shared` is the 32-byte x-only ECDH secret from noble secp256k1 `getSharedSecret(...).slice(1, 33)` (strip the 0x02/0x03 prefix byte).
- `b64url()` is base64url without padding.

```js
shared = ECDH(sk_dvm, pk_user) // noble getSharedSecret, strip prefix
kr = HKDF(ikm=shared, salt="pidgeon:v3", info="pidgeon:v3:root:<dvm_pubkey>", len=32) // 32-byte OKM (aka “master key”)
K_mailbox = HKDF(ikm=kr, salt="", info="pidgeon:v3:key:mailbox", len=32)
K_submit = HKDF(ikm=kr, salt="", info="pidgeon:v3:key:submit", len=32)
K_dm = HKDF(ikm=kr, salt="", info="pidgeon:v3:key:dm", len=32)
K_blob = HKDF(ikm=kr, salt="", info="pidgeon:v3:key:blob", len=32)
mb = b64url(HKDF(ikm=kr, salt="", info="pidgeon:v3:mailbox-id", len=16))
```

`mb` is stable per (user,DVM) but unguessable; never include user pubkey in any `d` tag.

### Master gift wrap (client + DVM)
Keep kinds `5901` (request rumor), `5900` (master payload), and `1059` (gift wrap).

Privacy note: wrapping the request (1059→13→5901) hides the **user pubkey** (one-time outer pubkey) and hides plaintext, but relays still see “someone sent a 1059 addressed to this DVM” on whichever relays you publish it to. The main win is unlinkability to the user identity, not hiding that the DVM was contacted.

- **Master request (wrapped)**: user → DVM using the same NIP‑59 structure as job submissions:
  - inner **rumor kind 5901** with content `{"t":"pidgeon-master-request","v":3}`, tags include `["p", dvmPubkey]`, `["k","3"]`
  - **seal kind 13** signed by user, nip44 encrypted to DVM, tags `[]`
  - outer **gift wrap kind 1059** signed by ephemeral, nip44 to DVM, tags `[["p", dvmPubkey]]`
- **Master gift wrap (kind 1059)**: DVM → user (NIP‑59 gift wrap) containing the master rumor.
  - outer tags include `["p", userPubkey]` and `["t","pidgeon-master-v3"]` so clients can REQ with `#t` (fallback to `#p` only if needed).
- **Rumor (kind 5900)** payload:

```json
{ "t":"pidgeon-job-master", "v":3, "kr":"<b64u root_key>", "mb":"<mb>", "relays":[...] }
```

`relays` here are **bootstrap job ledger relay hints** (where to fetch the first job ledger index/shards). After the client has fetched the job ledger global index, `index.relays` becomes the canonical job ledger relay set.

Client uses `ensureMailboxSecrets()` returning `{ rootKey, mailboxKey, submitKey, dmKey, blobKey, mb }` and caching `{ rootKey, mb }`.

**Identity for wrapped 5901:** when the DVM unwraps a master request, it derives secrets for the **seal signer pubkey** (the unwrapped inner event’s `pubkey`). The inner 5901 rumor content/tags are not identity‑bearing and must not be trusted for requester identity.

## Private scheduler requests (to DVM)
Only wrapped 5905 accepted.

### Notes (kind 5905 request rumor)
- **5905 rumor**: `content` is `nip44(K_submit, JSON)` where the JSON payload carries the input tags and optional capability hints:
  - `{ "tags": [...], "cap": { "allowFree": true }? }`
  - Schedule time is **the signed note’s** `created_at` (inside the `["i", JSON(noteEvent), "text"]` tag); there is no separate `scheduledAt` field in the 5905 payload.
  - The DVM schedules exactly at `noteEvent.created_at`.
  - Tags include:
    - `["p", dvm]`
    - `["k","3"]`
    - `["relays", ...relayHints]`
    - `["i", JSON(noteEvent), "text"]` (full signed kind‑1 note **or** kind‑6 repost)
- **13 seal**: signed by user, nip44 to DVM, tags `[]`.
- **1059 gift wrap**: signed by ephemeral, nip44 to DVM, tags `[["p", dvm]]`.

**Supported publish kinds**
- `kind:1` normal note (current behavior).
- `kind:1` quote (NIP‑18):
  - client includes `["q", "<targetId>", "<relayHint>", "<targetPubkey?>"]` (relay/pubkey optional but recommended when known)
  - client SHOULD include `["p", "<targetPubkey>"]` so the author is notified
  - content SHOULD include a trailing NIP‑21 `nostr:note...` reference to the quoted note (so clients can render a quote card)
- `kind:6` repost (NIP‑18, for kind‑1 notes only):
  - client includes `["e", "<targetId>", "<relayHint>"]` (relay hint is required; `ws(s)://...`)
  - client SHOULD include `["p", "<targetPubkey>"]` when the target is resolved
  - content MAY embed JSON of the target event (size‑bounded); otherwise empty
  - DVM validates on schedule **and** at publish time; if the target can’t be resolved to a kind‑1 note, the job is marked `error` and is not published

Because the rumor is unsigned, the DVM must:
- treat the **seal’s signer pubkey** (the unwrapped event’s `pubkey`) as authoritative;
- ignore any embedded `pubkey`/recipient fields inside the decrypted rumor JSON entirely;
- require the rumor tags include `["p", dvmPubkey]` (and the outer 1059 was addressed to the DVM via `#p:[dvmPubkey]`) before accepting;
- optionally enforce `noteEvent.pubkey === sealSignerPubkey` if you want to guarantee the user authored the scheduled note.

DVM path stays: `listenForRequests` → `handleRequest` → `parseRequest` → `schedulePayload`.

### DMs (kind 5906 schedule + kind 5907 retry)
We schedule NIP‑17 “Private Direct Messages” by having the **client build the NIP‑17 seals** and the **DVM build the outer gift wraps at send time**.

Wrapped request kinds:
- `5906`: schedule a DM job
- `5907`: retry a DM job (idempotent republish of already-built wraps)

**Client responsibilities (schedule):**
- Build an **unsigned kind 14** rumor payload `{ kind:14, created_at: scheduledAt, pubkey: sender, tags:[["p", recipient]], content }`.
- For each recipient (and for a sender copy), build a **kind 13 seal**:
  - `seal.kind = 13`
  - `seal.tags = []`
  - `seal.content = nip44Encrypt(unsignedKind14, senderSecretKey, targetPubkey)` (via signer `nip44Encrypt`)
  - `seal` is **signed by the sender** (NIP‑17 requirement for seal auth; the kind‑14 is still unsigned/deniable).
- Encrypt the DM schedule payload with `K_dm` (derived from `kr`) and submit as a wrapped request (1059→13→5906).

**DM schedule payload (inside 5906 rumor `content`, encrypted under `K_dm`):**
- Optional: `cap` can be included as `{ "allowFree": true }` to request a “use for free” unlock when a DVM gate would otherwise block the schedule.
```json
{
  "v": 1,
  "scheduledAt": 1730001234,
  "cap": { "allowFree": true },
  "pkv_id": "<preview key id>",
  "dmEnc": "<nip44 ciphertext encrypted with preview key>",
  "dmMeta": { "bytes": 123 },
  "recipients": [{ "pubkey": "<hex>", "seal": { "...kind13..." } }],
  "senderCopy": { "seal": { "...kind13..." } },
  "previewKeyCapsules": { "<pkv_id>": { "v":1, "alg":"nip44-to-user", "eph":"...", "ct":"..." } }
}
```
`v` here is the **DM payload schema id** (independent of the outer `k` tag value).

**DVM responsibilities (send):**
- At send time, for each target (each recipient + sender copy), build a **kind 1059 gift wrap** around the provided seal and publish it to that target’s **kind 10050 inbox relays**.
- Gate strictly on `kind:10050`: if the recipient has no inbox relays, mark the job as failed (don’t “spray” to random relays).

**Idempotency (avoid duplicate DMs):**
- The DVM persists the full signed **1059 event JSON** per target before publishing.
- Retries (`5907`) republish the *exact same* stored 1059, optionally to additional 10050 relays.

**Success criteria + queue visibility:**
- A DM job is considered **successful once all recipients have been delivered**.
- Sender copy publish is best-effort and must not block success (and must not surface as a user-facing “partial” state).
- Pidgeon does **not** keep DM history: on recipient success the job is removed from the job ledger pending view.

### Repair job ledger (kind 5908 request rumor)
Advanced / manual operation to recover from missing job ledger shards on relays.

- **5908 rumor**: payload is nip44-encrypted under `K_submit` (same authorization model as schedule requests).
- **13 seal**: signed by user, nip44 to DVM, tags `[]`.
- **1059 gift wrap**: signed by ephemeral, nip44 to DVM, tags `[["p", dvm]]`.

The DVM:
- verifies the request is addressed to itself (`#p` tag), and that the requester is the **seal signer pubkey**;
- checks relays first (REQ by `kind:30078` + `#d`) and republishes **only missing/outdated shards**, not everything;
- runs repair work off the main request handler so bursts don’t stall the DVM loop.

### Support actions (kind 5910 request rumor)
Optional “soft gates” + “support nudges” are DVM-authored and published in the job ledger global index as `support`.

- **5910 rumor**: payload is nip44-encrypted under `K_submit` (same authorization model as schedule requests).
- **Actions**:
  - `use_free`: unlock gates and suppress prompts for the next `windowSchedules` schedules
  - `maybe_later`: snooze the prompt (no unlock)
  - `support`: unlock window + optionally request a LNURL-verify invoice (if enabled)
  - `check_invoice`: force an immediate LNURL-verify check for the current invoice (if any)
- **Optional fields**:
  - `sats`: requested invoice amount (only used when LNURL-verify is enabled)
  - `invoiceId`: which invoice to check (for `check_invoice`; otherwise DVM checks the current pending invoice)

Example payload (inside the 5910 rumor `content`, encrypted under `K_submit`):
```json
{ "v": 1, "t": "pidgeon-support-action", "action": "use_free", "promptId": "nudge:10", "source": "nudge" }
```

## Job ledger state (authoritative)
All job list rendering comes from DVM‑authored job ledger events.

### Event kind
- kind `30078` (NIP‑78 addressable app data)
- author = DVM pubkey
- tags:
  - `["d", "<dTag>"]`
  - `["k","3"]` (schema/encryption marker)
- content encryption:
  - index/pending/history/bucket shards: `nip44.v2.encrypt(JSON, K_mailbox)`
  - blob parts (`:blob:` dTags): `nip44.v2.encrypt(JSON, K_blob)`

### Job ledger coordinates (`d` tags)
Using `mb` from the master payload:

- `d` lives in a global value space, so every coordinate is namespaced with a stable app prefix: `pidgeon:v3:`.
- **Global index**: `d="pidgeon:v3:mb:<mb>:index"`
- **Pending pages** (sharded if needed): `d="pidgeon:v3:mb:<mb>:pending:0"`, `...:pending:1`, …
- **Blob parts** (oversized pending notes): `d="pidgeon:v3:mb:<mb>:blob:<noteId>:<part>"`
- **Bucket index** (one per month): `d="pidgeon:v3:mb:<mb>:bucket:<yyyy-mm>"`
- **History pages** (sharded, log‑structured): `d="pidgeon:v3:mb:<mb>:hist:<yyyy-mm>:<page>"`
- Delimiter is `:` with fixed segment positions. Interpolated segments are: `mb`, `yyyy-mm`, page numbers, `noteId` (hex), and blob `part` index. None of these contain `:`, so parsing can safely split on `:` at known offsets.

### Schemas
All job ledger JSON blobs include:
- `v`: schema field (starts at 1)
- `rev`: job ledger revision (monotonic integer per user)

**Global index (`pidgeon:v3:mb:<mb>:index`)**  
Bounded forever: lists pending pages + history buckets (not every page).

```json
{
  "v": 1,
  "rev": 42,
  "relays": ["wss://relay1", "wss://relay2"],
  "counts": { "queued": 8, "posted": 120, "error": 1, "canceled": 2 },
  "previewKeyCapsules": {
    "<pkv_id>": { "v":1, "alg":"nip44-to-user", "eph":"...", "ct":"..." }
  },
  "pending_pages": [
    { "d":"pidgeon:v3:mb:<mb>:pending:0", "count": 8, "updated_at": 1730000000, "hash": "<sha256>" }
  ],
  "bucket_order": "desc",
  "buckets": ["2025-12", "2025-11"]
}
```

Notes:
- `counts` currently track **note jobs only** (to keep the existing notes UX stable). DMs live only in pending pages and do not affect queue/history counts.
- `previewKeyCapsules` are opaque blobs the DVM republishes; only the user’s signer can decrypt them (used for DM previews).

**Job ledger relay policy**
- DVM publishes job ledger shards to the job ledger relay set (a tight, DVM‑controlled set), typically `DVM_RELAYS` filtered to only relays that index `#d`.
- Global index `relays` is the canonical read set. Client subscribes to job ledger shards on `index.relays` first; only fall back to user relay sets if shards are missing.
- DVM probes each relay for `#d` indexing support on kind `30078` and skips relays that fail (so job ledger shards remain queryable by `#d`). If all relays fail probing, it falls back to the full set.
- Probe results are cached in `app.db` with a TTL so restarts don’t publish probe events every time.

**Bucket index (`pidgeon:v3:mb:<mb>:bucket:<yyyy-mm>`)**  
Lists history pages for one bucket; keeps global index tiny. Includes an optional cursor to support infinite scroll.

```json
{
  "v": 1,
  "rev": 42,
  "bucket": "2025-12",
  "bucket_order": "desc",
  "next_bucket": "2025-11",
  "pages": [
    { "d":"pidgeon:v3:mb:<mb>:hist:2025-12:0", "page":0, "count": 120, "updated_at": 1730000100, "hash": "<sha256>" }
  ]
}
```

**Pending page (`pidgeon:v3:mb:<mb>:pending:<page>`)**  
Always sufficient to render scheduled jobs with correct content/time.  
Job ledger stores a render preview, not the full signed note.  
`notePreview` is a minimal render contract (intentionally small): `{ content, tags }` only. The note id lives at the top level as `noteId`.

```json
{
  "v": 1,
  "rev": 42,
  "page": 0,
  "pending": [
    {
      "jobType": "note",
      "jobId": "<requestId>",
      "status": "scheduled",
      "scheduledAt": 1730001234,
      "updatedAt": 1730000100,
      "noteId": "<event id (kind 1 or 6)>",
      "notePreview": { "content":"...", "tags":[...] },
      "noteBlob": { "dBase":"pidgeon:v3:mb:<mb>:blob:<noteId>:", "parts": 3, "bytes": 180000 },
      "relays": ["wss://..."]
    }
  ]
}
```

**Pending DM item shape**
DMs are stored in pending pages (not history pages):
```json
{
  "jobType": "dm17",
  "jobId": "<requestId>",
  "status": "scheduled|error",
  "statusInfo": "publishing in 120s|<error>",
  "scheduledAt": 1730001234,
  "updatedAt": 1730000100,
  "dm": { "pkv_id":"...", "dmEnc":"...", "meta":{...} },
  "recipients": [{ "pubkey":"<hex>", "status":"pending|sent|error", "lastError":"...", "relaysUsed":[...], "wrapId":"..." }],
  "senderCopy": { "status":"pending|sent|error", "lastError":"...", "relaysUsed":[...], "wrapId":"..." }
}
```

Client renders a placeholder like “DM to npub…” until it can decrypt `dm.dmEnc` using the preview key.

**Blob part (`pidgeon:v3:mb:<mb>:blob:<noteId>:<part>`)**  
Used only when a single note would exceed relay size caps in pending pages.
Encrypted under `K_blob` (derived from `kr`).

```json
{
  "v": 1,
  "rev": 42,
  "part": 0,
  "total": 3,
  "data": "<chunk-of-JSON({content,tags})>"
}
```

**History page (`pidgeon:v3:mb:<mb>:hist:*`)**  
Lightweight records; content comes from the public event referenced by `noteId` (typically kind `1`, but reposts are kind `6`). The history item includes `kind` so the client can fetch/render appropriately.

```json
{
  "v": 1,
  "rev": 42,
  "bucket": "2025-12",
  "page": 0,
  "items": [
    { "noteId":"<event id>", "kind": 1, "postedAt": 1730001234 },
    { "noteId":"<event id>", "kind": 6, "postedAt": 1730001240 },
    { "jobId":"<requestId>", "noteId":"<event id>", "status":"error", "statusInfo":"<error>", "scheduledAt":1730001234, "updatedAt":1730001300 }
  ]
}
```

### Revision protocol (atomicity)
To prevent the client observing half‑updated job ledger state:
- All **rewritten** shards in a flush share the same `rev` (pending pages, changed history pages, bucket/global indices). Old history pages are append‑only and may retain a previous `rev`; the client accepts them.
- Publish order per user: blob parts (if any) → pending pages → changed history pages → changed bucket indices → **global index last**.
- Client advances to the next `rev` once it has the global index **and the required pending pages** for that `rev`; it renders scheduled/pending jobs immediately, and streams in history separately (history is not `rev`‑gated).
- Client treats `rev` as monotonic: ignore any index/shard with `rev` lower than the current revision and only move forward.

### Sharding + size caps
- Current implementation uses a conservative fixed serialized event capBytes of `48_000` (post‑encryption, post‑tags).
- Enforce caps by the **final serialized event size** (post‑encryption + tags), because relays limit incoming event JSON bytes:

  ```js
  const evt = build30078Event(...);
  const bytes = Buffer.byteLength(JSON.stringify(evt), "utf8");
  if (bytes > cap) splitMore();
  ```

- Pending/history sharding starts from a **plaintext target** (cheap heuristic), but the real acceptance check is the **final serialized size** after encryption + tags. If a candidate shard is oversized, reduce the target and re-shard until the signed event fits the cap.
- **Log‑structured history**:
  - bucket by month (`yyyy-mm`) from `postedAt` (or scheduledAt on error).
  - append to active page until cap reached, then roll to next page.
  - only the active page is rewritten frequently; previous pages become stable.

### Pruning rule
When a job becomes `posted`:
- remove it from pending pages; append a light record to history pages.
- optional: keep a small `notePreview` for the most recent N posted jobs in history for instant UI.

For DM jobs:
- successful DM jobs are removed from pending immediately after recipient delivery (no DM history in Pidgeon).

## DVM implementation notes
This is implemented in the standalone DVM service (see `dvm/`), not in the website server.

1. **Derive secrets**
   - `dvm/src/index.js`: `deriveMailboxSecrets(pubkey)` returns `{ rootKey, mailboxKey, submitKey, dmKey, blobKey, mb }`.
   - DVM responds to the wrapped master request by publishing the master payload (gift-wrapped `1059`) containing `kr` (master key) and `mb` (id).

2. **Job ledger publisher**
   - `dvm/src/mailbox.js` + `dvm/src/mailboxWorker.js` + `dvm/src/mailboxFlush.js`:
     - `queueMailboxPublish(pubkey)` marks the pubkey dirty and debounces; **rev increments once per flush**, not per enqueue.

       ```js
       queueMailboxPublish(pubkey) {
         state[pubkey].dirty = true;
         debounceFlush(pubkey);
       }

       async function flush(pubkey) {
         if (!state[pubkey].dirty) return;
         state[pubkey].dirty = false;
         const rev = ++state[pubkey].rev;
         const snapshot = listJobsForPubkey(pubkey);
         const shards = buildShards(snapshot, rev);
         await publishShards(shards, rev);
       }
       ```
     - `rev` must be **strictly monotonic per pubkey**, even across restarts/clock drift. The persisted value in `mailbox_meta.rev` is the source of truth; never decrement or reuse a previous `rev`.
       - On boot/hydration:

         ```js
         const meta = getMailboxMeta(pubkey) || {};
         state[pubkey].rev = meta.rev || 0;
         state[pubkey].lastCreatedAtByDTag =
           JSON.parse(meta.lastCreatedAtByDTagJson || "{}") || {};
         ```
     - `nextCreatedAt(dTag)` enforces per‑`d` monotonic `created_at` (avoid same‑second replaceable races).
     - pending items store a small `notePreview` (`content`/`tags` only) and are sharded by size; `pending:0` contains the nearest upcoming jobs (best UX for “Load further” into the future).
     - If a **single pending note** would exceed `capBytes`, publish encrypted blob parts `pidgeon:v3:mb:<mb>:blob:<noteId>:<part>` and replace the pending entry with a truncated preview plus `noteBlob` metadata. Publish blobs before pending/index shards.
     - `flushMailbox(pubkey)` behavior (as implemented):
       - increment and persist `rev`;
       - rebuild pending pages and publish **only pages whose hash/count changed** (same optimization as history pages);
       - rebuild history pages per bucket from the DB snapshot and publish **only pages whose hash/count changed** (typically the latest/last page, and sometimes an additional page when a bucket rolls);
       - publish bucket index events for buckets that changed;
       - publish the global index **last** (includes `counts`, `pending_pages`, `buckets`, and canonical `relays`).
     - `buildBucketIndex(pubkey, bucket)` listing pages for that bucket plus `bucket_order:"desc"` and optional `next_bucket` pointer to the next earlier bucket (if any).
     - `buildGlobalIndex(pubkey)` listing `counts`, `pending_pages`, `buckets`, and canonical DVM `relays`.
     - `publishMailboxEvent({ dTag, json, pubkey })` → nip44 encrypt with `K_mailbox` (or `K_blob` for `:blob:` dTags) → kind 30078 signed by DVM → publish to `dvmRelays` using `nextCreatedAt(dTag)`.
   - DB meta tables (in `dvm/src/appDataDb.js`):
     - `mailbox_pages(pubkey, bucket, page, count, hash, updatedAt)` caches per-page hashes (used to avoid rewriting unchanged pending/history pages; recommended but not strictly required for correctness).
     - `mailbox_meta(pubkey, rev, lastCreatedAtByDTagJson)` is required so `rev` and `nextCreatedAt(dTag)` remain monotonic across restarts; the publisher must hydrate its per‑user state from this table on boot.

3. **Trigger points**
   - `schedulePayload`: after `upsertJob`, call `queueMailboxPublish(payload.pubkey)`.
   - `publishPayload` success/failure: after `markJobStatus`, call `queueMailboxPublish(payload.pubkey)`.
   - `handleDelete`: after cancellation, call `queueMailboxPublish(updatedJob.requesterPubkey)`.
   - `restoreSaved`: after boot, publish job ledger shards (pending pages + bucket/global indices) for all pubkeys with scheduled jobs.

4. **Request intake**
   - Subscribe only to wrapped submissions: `{ kinds:[1059], "#p":[dvmPubkey], since: backfill }`.
   - After unwrapping a 1059, dispatch by inner kind: `5901` → publish master gift wrap; `5905` → parse/schedule job.
   - Master wrap publish throttle (anti‑replay/abuse): keep a per‑user last‑publish timestamp and do not re‑issue a master gift wrap more than once per ~30s unless you intentionally want to rotate.

## Client implementation notes
Job ledger is truth; `localStorage` is only decrypted cache.

1. **Master secrets**
   - `client/src/nostr/dvm.js`:
     - `ensureMailboxSecrets()` returns `{ rootKey, mailboxKey, submitKey, dmKey, blobKey, mb }`.
     - if no master gift wrap is found on relays, publish a **wrapped master request** (1059→13→5901) to the DVM, then retry fetch; never publish raw kind‑5901 publicly.
     - cache keys:
       - rootKey: `pidgeon.root.<dvm>:<pubkey>`
       - mb: `pidgeon.mb.<dvm>:<pubkey>`

2. **Job ledger subscriber**
   - Add `client/src/services/mailboxNostr.js`:
     - `subscribeMailbox(pubkey, { onJobs, onSync, onCounts, onSupport })` returns `{ retryNow, close, hasMorePending, loadMorePending, hasMoreHistory, loadMoreHistory }`.
     - flow:
      1. `const { mailboxKey, mb } = await ensureMailboxSecrets(pubkey)`
      2. subscribe to global index `{ kinds:[30078], authors:[dvmPubkey], "#d":[`pidgeon:v3:mb:${mb}:index`] }`
      3. decrypt index via `nip44DecryptWithKey(mailboxKey, ev.content)` → `{ rev, pending_pages, buckets, relays, counts, support }`
       4. emit `onCounts(counts)` for UI counts (Queue/Posted numbers) that don't depend on how many pages are loaded.
       4b. emit `onSupport(support)` to drive prompts and client-side gate prechecks (may include an optional pending `support.invoice`).
       5. set `mailboxRelays = resolveRelays(relays)` and subscribe/fetch only the **required** pending pages (initially a small prefix, e.g. `pending:0`) for that `rev`.
          - Queue can progressively fetch additional future pending pages via `loadMorePending({ pages: 1 })` (no `rev` change required).
       6. enforce rev completeness for **first paint (pending‑first)**:
          - require the global index and the required pending pages for that `rev`;
          - once present, emit scheduled/pending jobs immediately.
          - if not all pending pages for `rev` arrive within ~2–5s, re‑fetch the global index on `mailboxRelays`; if shards are still missing, keep rendering the last completed `rev` and show a “syncing…” banner while retrying.
       7. stream history (not rev‑gated, incremental):
         - subscribe to the latest bucket index `pidgeon:v3:mb:${mb}:bucket:${buckets[0]}` for live updates;
          - enqueue history pages from bucket indices and fetch them on demand via `loadMoreHistory({ pages: 1 })`;
          - accept the latest replaceable event for each history page `d` regardless of its internal `rev` (some pages may retain a previous `rev`).
       8. decrypt pages, build jobs:
          - pending jobs from pending pages (use `notePreview.content/tags` plus the item’s `scheduledAt`); if `noteBlob` is present, keep truncated preview and store the blob reference on the job.
          - posted jobs from history (content empty until note fetch)
       9. call `onJobs(jobs)` on any change.
     - `#d` filtering depends on relay support; keep the job ledger relay set tight and under DVM control. If a relay doesn’t index `d`, fall back to `{ kinds:[30078], authors:[dvmPubkey] }` and client‑filter by `d`.
     - localStorage cache (instant paint only):
       - `pidgeon.mailbox.<mb>.index`
       - `pidgeon.mailbox.<mb>.<dTag>`

3. **App wiring**
   - `client/src/App.jsx`:
     - on login, start `subscribeMailbox(pubkey, { onJobs:setJobs })`.
     - keep kind‑1 note hydration but only for jobs where `status==="posted"` and `!job.noteEvent`.
     - on job preview/detail open, if a pending job has `noteBlob`, fetch/decrypt all blob parts and hydrate full content (show “syncing” if parts are missing).
     - Jobs view UX:
       - Posted: keep the multi-column grid; show a bottom “Loading older posts…” row with skeleton shimmer and a “Load older” button wired to `loadMoreHistory()`.
       - Queue: keep the multi-column grid; show a bottom “Loading future scheduled posts…” row with skeleton shimmer and a “Load further” button wired to `loadMorePending()`.
     - Calendar UX:
       - Calendar calls `onRangeChange({start,end})` on navigation; App best-effort calls `loadMorePending()` until scheduled jobs cover the visible range end (or there are no more pending pages).

4. **Optimistic UI**
   - After schedule/cancel/reschedule, update UI immediately as today, but treat as optimistic; job ledger updates overwrite within ~1s.

## DM previews (“locked to signer”, auto‑unlock)
To show queued DM previews without allowing relays or the DVM to read message content, we use a user-only preview key (`pkv`).

- Client generates a random `pkv` once per (user,DVM), caches it locally (`pidgeon.pkv.<dvm>:<user>`).
- Authoritative location: the **job ledger global index JSON** contains `previewKeyCapsules[pkv_id]` (encrypted under `K_mailbox`).
  - Transport: the client includes `previewKeyCapsules` in `5906` when introducing a `pkv_id`, and the DVM persists/merges these opaque capsules into job ledger state so they show up in the global index.
  - The capsule itself is encrypted to the user pubkey using NIP‑44 primitives via an ephemeral key (so only the user signer can decrypt it).
  - The DVM republishes this capsule but cannot decrypt it.
- Each DM job stores `dmEnc = nip44EncryptWithKey(pkv, {content})` so queued previews can be decrypted locally once `pkv` is recovered.
- UX: previews are **auto-unlocked** when visiting the DM page (one signer decrypt if needed), then all queued previews decrypt locally.

## Acceptance checklist
- Fresh login with empty localStorage shows full scheduled jobs from pending pages.
- No kind 6905 traffic.
- Global index stays bounded; bucket indices grow slowly and stay under caps.
- Pending pages and history pages always < relay caps; history rolls pages deterministically.
- Posted list can load older history pages via “Load older”; Queue can load further future scheduled pages via “Load further”.
- No flicker/blank jobs on updates due to `rev` gating.
- Clearing localStorage does not lose decryption ability (master gift wrap re‑fetch works).

## Drafts (encrypted, Nostr-synced)
Drafts are separate from the job ledger scheduler. They are stored as user-authored Nostr events so drafts can survive reloads and sync across devices.

### Event shape
- kind `31234`
- author = user pubkey
- tags:
  - `["d", "<draftId>"]` (UUID; acts like a replaceable key for “latest draft revision wins”)
  - `["k", "1"]` (draft target kind)
- content = raw **NIP-44 ciphertext** encrypted to the user pubkey (self-encryption)

### Plaintext schema
The decrypted plaintext is JSON (with a leading newline as a signer compatibility workaround):

```json
{
  "type": "draft",
  "app": "pidgeon",
  "version": 2,
  "id": "<draftId>",
  "content": "<draft text>",
  "tags": "<comma-separated tags>",
  "createdAt": 1730000000,
  "updatedAt": 1730000123
}
```

### Signer requirements / compatibility
- Requires NIP-44 (`nip44_encrypt` + `nip44_decrypt`) and `sign_event:31234` when using NIP-46.
- Amber 4.0.3+ has a decrypt parsing bug for plaintext that *starts* with `{`/`[`; Pidgeon prefixes a newline before the JSON so decrypt does not hang/time out.

## Media uploads (NIP-96 + Blossom)
Pidgeon supports two upload backends for inserting media URLs into notes (Compose + Calendar). Upload results return `{ url, tags }` and we cache the `imeta` tag per URL for draft building.

### Settings (client)
Stored in localStorage:
- `pidgeon.upload.backend`: `nip96` (default) or `blossom`
- `pidgeon.nip96`: base URL of a NIP-96 service (e.g. `https://nostr.build`)
- `pidgeon.blossom.servers`: newline/comma-separated list of Blossom server origins, tried in order

Implementation touchpoints:
- `client/src/App.jsx`: Settings UI and localStorage persistence.
- `client/src/components/Uploader.jsx`: file picker + progress; calls `mediaUpload.upload()` with backend settings.
- `client/src/services/mediaUpload.js`: NIP-96 + Blossom implementations and tag normalization.

### NIP-96 backend
- Discover upload endpoint from `/.well-known/nostr/nip96.json` (`api_url`), with a proxy fallback via `GET /api/nip96/resolve`.
- Sign NIP-98 HTTP auth (kind `27235`) for the resolved `api_url` and method `POST`.
- Upload via `POST <api_url>` with multipart/form-data (`file=<binary>`). To avoid CORS/cookies issues we first try the same-origin proxy `POST /api/nip96/upload` (see `server/src/api.js`).

### Blossom backend (BUD-01/02)
- Compute `sha256` of the file bytes client-side.
- Sign a Blossom authorization event (kind `24242`) with:
  - `["t","upload"]`
  - `["expiration","<unix future>"]`
  - `["x","<sha256>"]`
  - `content` as a human string (e.g. `Upload <filename>`)
- Send `PUT https://<server>/upload` with:
  - body = raw file bytes
  - headers: `Content-Type` (if known) and `Authorization: Nostr <base64(signed-event-json)>`
- Parse the returned blob descriptor (`{ url, sha256, size, type, uploaded, nip94? }`) and normalize it into NIP-94-like tags (`url`, `m`, `x`, `size`) plus an `imeta` tag so downstream draft building is backend-agnostic.

**CORS requirement:** Blossom servers must allow cross-origin `PUT` with the `Authorization` header (BUD-01 preflight rules), otherwise browser uploads will fail.

### Not implemented yet
- BUD-03 kind `10063` server list fetch/publish (currently uses the manual server list in settings).
- BUD-04 `/mirror`, BUD-02 `GET /list/<pubkey>`, and BUD-02 `DELETE /<sha256>`.
- BUD-01 auth-protected `GET/HEAD` retrieval (if a Blossom server requires auth for GET, browser previews may fail).
