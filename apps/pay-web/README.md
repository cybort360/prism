# Prism pay-web

The **pay-by-link** surface for cross-chain payment requests. A Prism user shares a request link;
anyone — with no Prism app and **no funds on Monad** — opens it here, connects a wallet on their own
chain, and **Aurora Intents** routes USDC to the requester's Monad account (and, if they chose one,
sweeps it into their Circle or Savings).

Standalone Vite + React app. It talks only to the Prism backend's **unauthenticated** routes:
`GET /v1/requests/:id/public`, `POST /v1/pay/:id/quote`, `POST /v1/pay/:id/fulfill`.

## Honest settlement (read this)

NEAR Intents (which Aurora sits on) carries **Monad mainnet**, not testnet — where Prism is deployed.
So on this build:

- The **Aurora quote/route** is real (live cross-chain pricing, dry-run).
- The **wallet connection and signature** are real.
- **Settlement is simulated** (`AURORA_MODE=demo`): the backend credits the requester with a real
  testnet USDC mint and fires their pre-signed sweep. Only "funds actually moved from chain X to
  Monad" is simulated. Every screen says so.

## Run (demo)

```bash
# 1. backend in demo mode, allowing this app's origin:
cd ../../backend
AURORA_MODE=demo PAY_WEB_ORIGIN=http://localhost:5173 node src/server.js   # (with your .env)

# 2. this app:
cd ../apps/pay-web
cp .env.example .env        # VITE_API_BASE_URL=http://localhost:8787
npm install
npm run dev                 # http://localhost:5173
```

Create a **universal** payment request in the Prism iOS app (optionally with a Savings/Circle
destination), open `http://localhost:5173/pay/<requestId>`, connect a wallet (Base/Arbitrum/Optimism/
Ethereum), get the real Aurora quote, and pay. The payer signs a message; the backend verifies it,
mints to the requester, marks the request PAID, and relays the sweep.

## Config

| Env | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Prism backend base URL. Must be in the backend's `PAY_WEB_ORIGIN` CORS allow-list. |
| `VITE_WALLETCONNECT_PROJECT_ID` | Optional. Enables the WalletConnect connector (injected/MetaMask works without it). |

## The signed message

`src/PayPage.tsx`'s `paymentMessage()` must stay byte-for-byte identical to the backend's
`crossChainPayService.paymentMessage` (same field order, same `getAddress` checksums), or signature
verification fails. If you change one, change both.

## Deploy

Static build (`npm run build` → `dist/`). Host anywhere (e.g. Vercel); point `VITE_API_BASE_URL` at
the production backend and add that host to the backend's `PAY_WEB_ORIGIN`.
