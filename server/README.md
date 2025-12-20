# Pidgeon Web Server

This package runs the website server:
- Serves the built client (SPA) from `client/dist`.
- Exposes a small HTTP API under `/api` (health, calendar helpers, NIP-96 upload proxy).

The DVM is a separate package in `dvm/` so it can be hosted independently.

## Quick start
```bash
cd server
npm install
npm run dev
```

