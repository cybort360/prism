# Add money and Cash out: integration plan (Onramper, two-way, global)

Date: 2026-09-22. Companion to `ONRAMP_RESEARCH.md`. This is the build plan for a global, two-way
fiat rail: anyone can add money (fiat -> USDC on Monad) and cash out (USDC on Monad -> local fiat),
via Onramper as the single aggregator, Naira first-class.

## Principles (carry over from Prism)
- No blockchain shown. The user sees an amount and a payment method, never a chain or token.
- KYC is the provider's job. Prism never stores payout or ID PII.
- Money-truth. Balance changes only from the on-chain USDC read after settlement, never from a widget
  success callback. Mirrors INV-M1/M2.
- Destination is bound server-side. The wallet an on-ramp funds, and the address a cash-out sends to,
  are set by the backend from the provider's signed data, never supplied by the client. Mirrors the
  "recipient bound in the signed envelope" invariant.
- Real money is gated. Live on/off-ramp needs Prism on Monad mainnet (143) and a verified config
  flag, exactly like Save's `substrateVerified`. Testnet builds run in sandbox (UI only).

## Architecture at a glance
```
Add money (on-ramp):
  iOS AddMoneyView -> GET /v1/onramp/session (backend mints a widget URL, wallet bound)
    -> Onramper buy widget in a WKWebView -> user pays fiat, provider does KYC + delivery
    -> USDC lands in the user's Monad account
    -> Onramper webhook -> backend records/updates an "add-money" activity row
    -> balance reflects it from the on-chain read (money-truth)

Cash out (off-ramp):
  iOS CashOutView -> POST /v1/offramp/quote (amount + payout method + country)
    -> backend calls Onramper, returns a quote + provider deposit address (bound server-side)
    -> POST /v1/offramp/prepare -> backend builds a gasless USDC transfer to that address (signable)
    -> user approves with Face ID (Mera signs) -> POST /v1/offramp/execute -> relayer submits
    -> on-chain USDC transfer confirms -> backend debits/records; provider pays fiat to the bank
    -> Onramper webhook -> "cash-out" row goes pending -> paid
```
The cash-out crypto leg is just a USDC transfer from the user's account to the provider's address, so
it reuses the existing gasless ERC-3009 / PrismPaymentRouter signing path. Nothing new on the crypto side.

## Backend

### Config (`backend/src/config.js`, all from env, no secrets committed)
- `ONRAMPER_API_KEY` - publishable key for the widget URL.
- `ONRAMPER_SECRET_KEY` - server key for the Onramper API (quotes, off-ramp orders).
- `ONRAMPER_WEBHOOK_SECRET` - HMAC secret to verify inbound webhooks (reuse the Alchemy-webhook HMAC pattern already in the codebase).
- `ONRAMP_MODE` - `sandbox` | `production` (default sandbox).
- `ONRAMP_ENABLED` and `ONRAMP_SUBSTRATE_VERIFIED` - double gate for real money, mirroring Save. Real
  on/off-ramp is refused unless `production` + verified + chain is mainnet.
- Asset/network identifiers: the Onramper asset id for "USDC on Monad" (confirm exact id with Onramper),
  stored as config so the client never picks the chain.

### Routes (`backend/src/server.js`, follow `route(method, path, handler, authRequired)`)
- `GET  /v1/onramp/session` -> `onrampService.buySession(user.prismId)`
  Mints a preconfigured Onramper widget URL: apiKey, mode=buy, onlyCryptos = USDC-on-Monad,
  wallet = the user's Mera account (bound server-side from identity), optional amount, country left to
  geo-detection or prefilled for NG. Returns `{ url }`. Keeps the API key server-side and the
  destination wallet non-forgeable.
- `POST /v1/offramp/quote` -> `onrampService.sellQuote({ prismId, amountAtomic, payoutCountry, payoutMethod })`
  Calls Onramper's off-ramp for a sell quote; returns `{ quoteId, fiatAmount, fiatCurrency, rate, fees,
  depositAddress, expiresAt }`. The `depositAddress` is remembered server-side against `quoteId`.
- `POST /v1/offramp/prepare` -> `onrampService.sellPrepare({ prismId, quoteId })`
  Looks up the bound `depositAddress` for `quoteId`, builds a gasless USDC transfer (reuse the payment
  prepare path) from the user's account to that address for the quoted amount. Returns the signable
  envelope. The address is taken from the stored quote, never from the request body.
- `POST /v1/offramp/execute` -> `onrampService.sellExecute({ prismId, quoteId, signature })`
  Submits the signed transfer via the relayer; records an off-ramp order (PREPARED -> SUBMITTED).
  Reconciles to CONFIRMED from the on-chain receipt (reuse the payment reconcile path).
- `POST /v1/webhooks/onramp` (unauthenticated, HMAC-verified) -> updates the matching on-ramp or
  off-ramp order from the provider event (fiat received, crypto delivered, payout sent, failed).

### Service (`backend/src/services/onrampService.js`, new; injectable Onramper adapter)
- Announced dev adapter when `ONRAMP_MODE=sandbox`: it builds real sandbox widget URLs and real
  sandbox quotes, but never claims real settlement (matches the "dev adapters announce themselves" rule).
- Order records in the store: `{ orderId, prismId, kind: 'ONRAMP'|'OFFRAMP', amountAtomic, fiat, status,
  provider, txHash, createdAt, updatedAt }`. Status only reaches a terminal paid/delivered state from a
  verified webhook or an on-chain confirmation, never optimistically.

### Activity (`backend/src/services/activityService.js`)
- Add two row kinds: `add-money` (incoming, "Added money") and `cash-out` (outgoing, "Cashed out"),
  projected from the order records, status in the consumer vocabulary (Pending / Completed / Failed).
- Reconcile-on-read like we just did for circle payouts: opening Activity reconciles any pending
  off-ramp crypto legs from chain truth so a delivered leg stops showing Pending.

## iOS

### Add money (`AddMoney/AddMoneyView.swift`)
- Behind a new `@AppStorage("feature.onramp")` flag (off until ready), replace the "coming soon" teaser
  with: amount entry -> call `GET /v1/onramp/session` -> present the returned URL in a `WKWebView`
  sheet. The widget handles fiat + KYC + delivery. On dismiss, trigger a balance refresh.
- Keep the current jargon-free copy. No chain or token shown. Card is de-emphasized; bank/instant
  transfer leads (Nigeria reality), which Onramper's geo-detection already does.

### Cash out (new `Circles`-style flow or a `CashOutView.swift`)
- New entry (e.g. a "Cash out" action near Add money). Amount entry (capped at balance) + payout method
  picker (Onramper returns available methods per country).
- `quote -> prepare -> Face ID approve (Mera sign) -> execute`, reusing the payment authorization sheet
  and signing path already in the app. Show the fiat amount and fee from the quote before approval.
- Result routes into Activity as a "Cashed out" row that goes Pending then Completed.

## Sandbox vs mainnet
- Testnet build (today): `ONRAMP_MODE=sandbox`. The full UI + KYC flow is demoable and clearly labelled
  "sandbox, no real money." No on-chain settlement in sandbox (no provider supports Monad testnet).
- Production: `ONRAMP_MODE=production`, Prism on Monad mainnet, `ONRAMP_SUBSTRATE_VERIFIED=true`. The
  double gate refuses real money until all are set, same discipline as Save.

## Security and compliance
- API key and secret stay server-side; the widget URL is minted per user with the wallet bound, so a
  client cannot redirect a deposit.
- Off-ramp `depositAddress` is bound to the `quoteId` server-side and re-checked at prepare/execute, so
  a tampered client cannot send the cash-out to a different address.
- KYC and payout PII live entirely with the provider. Prism stores only order metadata (amount, status,
  tx hash), no ID documents, no bank details.
- Webhooks are HMAC-verified and idempotent (reuse the existing webhook dedupe guard).

## Testing
- Backend: unit-test `onrampService` with a fake Onramper adapter (session URL shape, quote binding,
  off-ramp prepare uses the bound address not the body, webhook state transitions, money-truth: no
  terminal status without webhook/receipt). Hostile: a client-supplied deposit address is ignored.
- iOS: build + a UI smoke of the Add money session load and the Cash out quote->approve path against
  the sandbox.

## Phasing
0. **Confirm with Onramper** (blocking): Monad off-ramp availability + country list, the USDC-on-Monad
   asset id, widget preconfiguration + lock, webhook events + signing, fees/margin, sandbox keys.
1. **On-ramp sandbox**: config + `GET /v1/onramp/session` + AddMoneyView WKWebView + add-money activity
   row. Demoable end to end in sandbox.
2. **Off-ramp sandbox**: quote/prepare/execute + the sign-and-send leg + cash-out activity row.
3. **Webhooks + reconcile**: `/v1/webhooks/onramp`, reconcile-on-read, money-truth hardening.
4. **Production gate**: mainnet + verified flags, go-live. Keep Coindisco as a backup adapter behind
   the same service seam.

## Open questions to close before Phase 1
- Onramper: can a user sell USDC on Monad and receive NGN (and other local fiats) via off-ramp today?
  Which countries for off-ramp?
- Exact Onramper identifiers for USDC on Monad (buy and sell), and whether the widget can be fully
  locked to it (so the chain never surfaces).
- Webhook event catalog and signing scheme (to wire money-truth correctly).
- Fees/margin per direction and per region, to show honest numbers before the user commits.
- Whether off-ramp on mobile prefers the widget "native send" hand-off or the API + our own sign-and-send
  (this plan assumes API + our signing, since it reuses the audited path and keeps the chain hidden).
