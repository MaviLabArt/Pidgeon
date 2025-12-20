<p align="center">
  <img src="client/public/pidgeon-icon.svg" width="96" height="96" alt="Pidgeon logo" />
</p>
<h1 align="center">
  <img src="client/public/pidgeon-wordmark.svg" width="360" alt="Pidgeon" />
</h1>
<p align="center">
  Nostr scheduler client + DVM-powered job ledger.
</p>

Pidgeon is a privacy first Nostr scheduler client that comes with a companion DVM.

The official instance runs at `https://pidgeon.lol` and is accessible to all Nostr users.

## Repo layout
- `client/`: Vite/React UI
- `dvm/`: Pidgeon DVM (Node)
- `server/`: Website API + static hosting (Node)

## Docs
- `docs.md`: Scheduler + job ledger architecture and protocol

## Privacy: self-host your DVM
You can optionally self-host your own DVM and point Pidgeon to it for additional privacy.

- Self-host the DVM (see `dvm/README.md`).
- In the app, go to `Settings → Advanced` and set the DVM pubkey.

## Local dev
1) Start the DVM (see `dvm/README.md`)
2) Start the client:
```bash
cd client
npm install
npm run dev
```
