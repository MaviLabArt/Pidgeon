# Pidgeon DVM (Job Ledger)

Private job-ledger scheduler DVM. Accepts wrapped NIP‑59 submissions and publishes an authoritative encrypted job ledger state (kind `30078`) per user.

## Quick start
1) Create `dvm/.env`:
```
DVM_SECRET=<nostr-privkey-hex-or-nsec>
DVM_NAME=Pidgeon DVM
DVM_ABOUT=Schedules signed notes on your relays
DVM_PICTURE=https://example.com/logo.png
DVM_RELAYS=wss://relay1.example.com,wss://relay2.example.com
INDEXER_RELAYS=wss://relay1.example.com
DATA_DIR=./data   # optional, defaults to ./data
ENABLE_CORS=1     # needed for Vite dev server or cross-origin clients
CORS_ORIGIN=http://localhost:5173

# Support gates + nudges (optional)
# - Scheduling beyond the horizon or using gated features will trigger a non-blocking “support” prompt.
# - “Use for free” always remains available and unlocks gates/prompts for the next window.
DVM_SUPPORT_HORIZON_DAYS=7
DVM_SUPPORT_WINDOW_SCHEDULES=10
DVM_SUPPORT_GATED_FEATURES=repost,quote,dm17
DVM_SUPPORT_LUD16=you@getalby.com
DVM_SUPPORT_MESSAGE=If you like Pidgeon, consider supporting

# Optional: verify supporters via LNURL-verify (LUD-21)
DVM_SUPPORT_PAYMENT_MODE=lnurl_verify
DVM_SUPPORT_INVOICE_SATS=1000
DVM_SUPPORT_SUPPORTER_DAYS=30
DVM_SUPPORT_VERIFY_POLL_SECS=15
```
`DVM_SECRET` can also be a bech32 `nsec` (it will be decoded to hex automatically).

2) Install deps and run:
```bash
cd dvm
npm install
npm run dev   # or npm start
```

## What it does
- Publishes metadata (kind `0`), relay list (kind `10002`), and handler info (kind `31990`) advertising it handles schedule jobs (inner kind `5905`), DM/retry/repair requests (`5906`/`5907`/`5908`), and support actions (`5910`). Metadata publishes are skipped if unchanged (hash cached in `DATA_DIR/app.db`).
- Listens on `DVM_RELAYS` **only for wrapped requests**: outer kind `1059` with `#p` = DVM pubkey. After unwrap:
  - inner kind `5901` → publishes a master gift wrap (kind `1059`) back to the user containing `{ kr, mb }` (root key + job ledger id).
  - inner kind `5905` → decrypts with `K_submit` (derived from `kr`), schedules the signed kind‑`1` note for its `created_at`.
  - inner kind `5910` → support actions:
    - `use_free` / `maybe_later` / `support` (starts invoice flow if enabled; optional `sats` to request amount)
    - `check_invoice` (forces an immediate LNURL verify check; optional `invoiceId`)
  - inner kind `5908` → “repair job ledger”: probes relays and republishes only missing/outdated job ledger shards (no full republish).
- Persists scheduled jobs to `DATA_DIR` and restores them on restart.
- Publishes encrypted job ledger shards (kind `30078`, addressable/replaceable via `d`) for each user:
  - global index `pidgeon:v3:mb:<mb>:index`
  - pending pages `pidgeon:v3:mb:<mb>:pending:<n>` (full render previews for scheduled jobs)
  - bucket indices `pidgeon:v3:mb:<mb>:bucket:<yyyy-mm>`
  - history pages `pidgeon:v3:mb:<mb>:hist:<yyyy-mm>:<page>`
  The client renders jobs directly from these shards; `localStorage` is cache only.
- Honors cancel by watching for kind `5` deletes tagging the request id (`e`) and the DVM pubkey (`p`).

## Support gates
The global job ledger index includes a `support` object with:
- `policy`: DVM-configured gates (horizon days, gated features) + CTA (lud16/message).
- `state`: per-user counters and unlock window.
- `prompt`: either a “nudge” (every `DVM_SUPPORT_WINDOW_SCHEDULES`) or an active gate prompt.
- `invoice` (optional): when `DVM_SUPPORT_PAYMENT_MODE=lnurl_verify`, the DVM can publish a pending BOLT11 invoice here.

Gates are intentionally “soft”: users always have a “use for free” option which unlocks gates/prompts until the next window.

## File map
- `dvm/src/index.js`: DVM implementation (Welshman-based).
- `dvm/package.json`: scripts and deps (`@welshman/*`, `dotenv`).
- `dvm/.env` (you create): secrets/config.

## Notes
- Incoming submissions and master requests are NIP‑59 wrapped; requester identity is the **seal signer pubkey**.
- Job ledger encryption uses symmetric NIP‑44 with deterministic subkeys derived from `kr` (root key).
- There is no `6905` status traffic; job ledger updates are the single source of truth.
- DVM relay `#d` indexing is probed on startup and cached with a TTL (env: `DVM_D_INDEX_PROBE_TTL_SEC`) so restarts don’t publish probe events every time.

