<p align="center">
  <img src="client/public/pidgeon-icon.svg" width="96" height="96" alt="Pidgeon logo" />
</p>
<h1 align="center">
  <img src="client/public/pidgeon-wordmark.svg" width="360" alt="Pidgeon" />
</h1>
<p align="center">
  Nostr scheduler client + DVM-powered job ledger.
</p>

Pidgeon is a Nostr scheduler client + a companion DVM that publishes an encrypted, authoritative job ledger state (kind `30078`) per user.

## Repo layout
- `client/`: Vite/React UI
- `dvm/`: Pidgeon DVM (Node)
- `server/`: Website API + static hosting (Node)

## Docs
- `docs.md`: Scheduler + job ledger architecture and protocol

## Local dev
1) Start the DVM (see `dvm/README.md`)
2) Start the client:
```bash
cd client
npm install
npm run dev
```
