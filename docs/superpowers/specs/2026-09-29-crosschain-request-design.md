# Cross-chain payment request — design spec

- **Date:** 2026-09-29
- **Status:** Approved (brainstorming), ready for implementation planning
- **Feature:** "Pay a Prism request from any chain, without the Prism app" — the pivotal Aurora Intents showcase.

## Goal

A Prism user shares a payment-request **link**. Anyone — with no Prism account and **no funds on Monad** —
opens it in a browser, connects a wallet on **their own chain**, and pays. **Aurora Intents** handles the
cross-chain routing, and the money lands as USDC in the requester's Monad account (and, if they chose one,
sweeps into their Circle or Savings). This is the genuine demonstration that Prism uses Aurora Intents to
"hide chains" for both sides of a payment.

## The constraint that shapes settlement fidelity

NEAR Intents (which Aurora sits on) carries **Monad mainnet (143)**, not testnet. Prism is deployed on
**testnet (10143)**. So a genuinely-*settled* cross-chain payment would land on mainnet, not this build.

**Decision (settlement fidelity): real quote + simulated settle.** Everything except the cross-chain
*arrival* is real:

- The Aurora **quote/route** is a live dry-run against NEAR Intents (real cross-chain pricing, fees, ETA).
- The payer's **wallet connection and signature** are real.
- The **credit** is a real on-chain testnet USDC mint the requester's balance genuinely reads.

Only "funds actually moved Base→Monad" is simulated, gated behind the existing `AURORA_MODE` honesty (same
approach as the already-shipped Aurora *receive* demo). Every payer-facing surface carries an explicit
"demo settlement, simulated on testnet" notice. Nothing ever implies real funds moved.

## Architecture & flow

```
┌─ apps/pay-web (Vite + React, own deploy) ───────────────┐
│  /pay/:requestId                                        │
│  1. GET  /v1/requests/:id/public   → request details    │
│  2. Connect wallet (wagmi: injected + WalletConnect)    │
│  3. POST /v1/pay/:id/quote         → REAL Aurora route   │
│  4. personal_sign(canonical message)                    │
│  5. POST /v1/pay/:id/fulfill  {payerAddr, sourceChain,  │
│                                signature}                │
└───────────────────────────┬─────────────────────────────┘
                            ▼  (CORS-allowed, rate-limited, unauthenticated)
┌─ Node backend — crossChainPayService ───────────────────┐
│  quote:   Aurora quoteSend(dry) sourceAsset/chain →     │
│           USDC on requester's Monad account (amt fixed)  │
│  fulfill: verify sig (binds requestId+amount+addrs)      │
│    → mint USDC to requester  (real testnet, demo-gated)  │
│    → markPaid(request, payer = EVM addr + sourceChain)   │
│    → sweepService.executeFor(request)                    │
│         (Circle/Savings: relay the pre-signed sweep)     │
└──────────────────────────────────────────────────────────┘
        ▼  requester's Prism app reflects it from an on-chain read
   balance ↑  (or Circle/Savings ↑),  request shows PAID
```

**Boundary chosen (Approach A):** the non-Prism-payer path is its own well-bounded seam
(`crossChainPayService`) rather than being folded into the existing Aurora deposit-address flow (which is
"a Prism user receives") or the ERC-3009 payment path (whose payer is, by definition, a Prism account). It
maximally reuses what already exists: `getPublicView`, the demo mint, `sweepService.executeFor`, the request
state machine.

## Component 1 — Web app (`apps/pay-web/`)

**Stack:** Vite + React + TypeScript; `wagmi` + `viem` for wallet (injected MetaMask + WalletConnect
connectors). Config via `VITE_API_BASE_URL` (Node backend) and `VITE_WALLETCONNECT_PROJECT_ID`.

**Single route `/pay/:requestId`; a small state machine:**

| State | Payer sees | Data source |
|---|---|---|
| `loading` | spinner | `GET /v1/requests/:id/public` |
| `invalid` | "This request link is expired / already paid / not found" | 404 or status ≠ OPEN |
| `review` | "**@tester1 requests $20.00**" + memo; if a Circle/Savings destination, a subtle "lands in their Savings" line | public view |
| `connect` | "Connect a wallet to pay from any chain" → injected + WalletConnect | wagmi |
| `quote` | payer address + chain; source-asset picker (Aurora's supported source assets); **real route** ("Pay ~20.02 USDC on Base · Aurora routes it · @tester1 gets $20 on Monad") + fee/ETA + **preview notice** | `POST /v1/pay/:id/quote` |
| `signing` | wallet signature prompt | `personal_sign(message)` |
| `submitting` | "Completing payment…" | `POST /v1/pay/:id/fulfill` |
| `done` | ✓ "Paid — @tester1 received $20.00" + one line: *demo settlement simulated on testnet* | fulfill result |

**Notes:**
- The **preview/unsettled notice is always visible** on the quote + done screens — the same honesty the iOS
  Aurora surfaces carry. Never implies real funds moved.
- The payer needs **no Prism account, no Monad funds, no app install** — the whole point.
- Responsive, single-column, mobile-first (payment links open on phones). Prism's mint/ink palette, but a
  minimal standalone surface — not the app.
- **Deploy:** static build. For the demo it runs via `vite dev`/`preview` against the local backend. Vercel
  is the eventual host (documented, not required for the demo).

## Component 2 — Backend

**Reuse the existing public endpoint.** The `review` state calls the existing
`GET /v1/requests/:id/public` (`requestService.getPublicView`) — no new public route.

**Two new endpoints — unauthenticated (the payer has no Prism session), CORS-allowed, rate-limited:**

- `POST /v1/pay/:requestId/quote` — body `{ payerAddress, sourceChain, sourceAsset }`. Calls the real
  Aurora `quoteSend` (dry-run) for `sourceAsset/chain → USDC on the requester's Monad account`, amount fixed
  by the request. Returns the live route + pricing + fee/ETA + preview notice.
- `POST /v1/pay/:requestId/fulfill` — body `{ payerAddress, sourceChain, signature }`. The settlement.

**`fulfill` logic — new `backend/src/services/crossChainPayService.js`:**

1. **Load & validate request** — must be `OPEN`, not expired, and universal-or-unbound (a payer-designated
   request is not payable by an arbitrary wallet).
2. **Verify signature** — recover the signer from `personal_sign` over a canonical message binding
   `requestId + amount + requesterAccount + payerAddress`; the recovered signer must equal `payerAddress`.
   Replay protection is the request's one-time `OPEN → PAID` transition (step 4): a request can be fulfilled
   only once, and the message is bound to that unique `requestId`, so a captured signature can neither
   re-fulfill the same request nor be reused against another. No separate nonce needed.
3. **Simulate Aurora delivery** — mint `request.amount` MockUSDC to the requester's Monad account via the
   relayer (extracted `mintToAccount` helper, reused from the Aurora demo path). This is the money-truth
   credit.
4. **Mark paid** — `markPaid(request, { payer: payerAddress, sourceChain, deliveryTxHash, viaAurora: true })`.
   Attribution stores the **cross-chain payer** (EVM address + chain), not a `prismId`. State machine flips
   `OPEN → PAID`.
5. **Fire the sweep** — `sweepService.executeFor(requestId)` (already built, idempotent): if the request had
   a Circle/Savings destination, the requester's pre-signed sweep authorization relays the just-credited
   USDC into it.
6. **Return** `{ status, deliveryTxHash, destination }` for the `done` screen.

**Money-truth & safety:**
- The credit is a **real on-chain mint** → the requester's balance reads it truthfully; only the cross-chain
  *arrival* is simulated, gated behind `AURORA_MODE=demo` (in `preview`, `quote` still works but `fulfill`
  returns the quote with no mint; `live`/mainnet is the real Aurora route, later).
- The payer **cannot alter** the amount (fixed by the request), the recipient (the requester), or the
  destination — all read from the stored request, never from the request body.
- **CORS** is opened only for the public + `/v1/pay/*` routes, to a configurable `PAY_WEB_ORIGIN`; the
  authenticated API stays same-origin.
- Rate limits on both endpoints (per `requestId` + IP). `fulfill` is idempotent — one payment per request.

## Files

- **New:** `apps/pay-web/*` (Vite + React app).
- **New:** `backend/src/services/crossChainPayService.js`.
- **Changed:** `backend/src/server.js` — 2 new routes + CORS allowance for the public + `/v1/pay/*` routes.
- **Changed:** `backend/src/services/requestService.js` — `markPaid` accepts a cross-chain payer
  (EVM address + sourceChain, no `prismId`).
- **Refactor:** extract `mintToAccount` from the Aurora demo path so both the receive flow and this reuse it.
- **Config:** `PAY_WEB_ORIGIN` (backend CORS); `VITE_API_BASE_URL`, `VITE_WALLETCONNECT_PROJECT_ID` (web).

## Testing

- **Unit (backend):** signature verify (valid / tampered / replayed); request validation
  (open / expired / already-paid / amount-locked / payer-bound rejected); `fulfill` mints + marks PAID +
  fires sweep (mocked chain + sweep); idempotency (double-fulfill is a no-op).
- **Integration (backend):** `quote` returns a route via the mock Aurora client; `fulfill` end-to-end into a
  Circle destination (credit lands, request PAID, Circle balance grows).
- **Web:** the state machine renders each state; the preview notice is present on quote + done; a fulfilled
  request shows the success screen. (Wallet interactions mocked.)

## Out of scope / future

- Real mainnet settlement (needs a mainnet router/vault deploy + `AURORA_APP_KEY` + real USDC).
- Aurora Intents *Connect* (destination-chain contract calls) — access-gated, deliberately not integrated.
- The other two roadmap items (Gift = productizing the existing ClaimVault link; Circle spending-limit
  request/chat over governance) — separate specs.
- Production web hosting/CDN, custom domain for the link.

## Open items

None blocking. Confirm at implementation time: the exact set of Aurora **source** assets/chains to surface
in the picker (drive from the live Aurora token list, filtered to a demo-friendly few, e.g. USDC on
Base/Arbitrum/Optimism).
