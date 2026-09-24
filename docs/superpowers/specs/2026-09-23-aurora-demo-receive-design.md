# Aurora demo mode — receive from any chain (Sub-project C of 4)

**Date:** 2026-09-23. **Status:** Approved (design).

## Program context

Sub-project C of four that turn dark/preview backend seams into working demo features (A = Save demo,
B = RECEIVE→Circle/Savings sweep). C is **independent** of A/B (different subsystem) — branch
`feat/aurora-demo-receive` off `main`. Cross-cutting rule still applies: money-truth (INV-M1/M2 —
balances are on-chain reads, never fabricated); demo features are labeled demo; `preview`/`live`
untouched.

## Problem

Aurora Intents is **mainnet-only**: it bridges Monad **mainnet (143)**, while Prism runs **testnet
(10143)**. So `auroraService` ships in `preview` mode — quotes are `dry`, deposit addresses are not
fundable, and nothing settles against this deployment. The full quote→prepare→submit→reconcile
pipeline exists and is honest about being unsettleable. We want to demonstrate "receive from any
chain → your Monad balance" end-to-end on testnet without calling real Aurora and without faking a
balance.

## Decisions (from brainstorming)

1. **RECEIVE only** (cleanest money-truth): the demo delivers real testnet USDC *to the user's own
   account*. SEND/SPEND outbound is out of scope (its "delivery on another chain" can't be real on
   testnet — a bigger simulation gap).
2. **Delivery = a real on-chain testnet USDC credit.** The demo settlement agent (the relayer) mints
   testnet MockUSDC to the user's account (the app's testnet USDC at `0x534b…43A3` is expected to be
   the mintable MockUSDC; if not, deliver from a pre-funded relayer USDC balance instead — same flow).
   Only the "a deposit arrived on chain X" *event* is simulated; the money is real testnet USDC.
3. **Manual trigger** (controllable showcase): a "Simulate incoming deposit" action, demo-mode-only,
   credits the caller's own account on cue. No background scheduler.

## Design

### 1. `AURORA_MODE=demo` + `DemoAuroraClient`

- Config: extend `AURORA_MODE` to `preview (default) | demo | live`, add derived `demo` flag. Keep
  `settlementAvailable` true when `mode !== 'preview'` (so demo reports settleable). (Mirrors A's
  `SAVE_MODE`.)
- `DemoAuroraClient` (new) dropped into the existing `setAuroraClient` seam at startup when
  `mode === 'demo'`. Implements the same interface as `auroraApiClient`:
  - `available()` → true.
  - `listTokens()` → the source-chain/asset catalog (reuse the demo catalog the test double already
    defines, or the real list) so the chain/asset picker works.
  - `persistentAddress({ recipient, depositChain, destinationChain, destinationAsset })` → a stable,
    deterministic per-(recipient, chain) demo deposit address recorded in `auroraDeposits` exactly as
    today. It is a display address only — nothing real is deposited there; the actual credit is the
    mint to the user in step 2.
  - `status({ depositAddress })` → returns the stored demo delivery status for that address (or
    "awaiting_deposit" before a simulated deposit).
  - `submitDeposit`/`quote` → not used by RECEIVE; provide inert stubs (return null) so the interface
    is complete.

### 2. Demo settlement agent + trigger

- `auroraService.settlementAvailable` is true in demo; `_previewNotice()` becomes a **demo notice**
  when `mode === 'demo'`: "Demo — the cross-chain deposit is simulated; the USDC credited to your
  balance is real testnet USDC." (Kept in the service so it can't drift from config.)
- New `auroraService.simulateInboundDeposit({ prismId, depositAddress, sourceChain, amountAtomic })`
  (analogous to A's `simulateYield`), demo-mode only:
  - Validates the deposit address exists and belongs to `prismId` (from `auroraDeposits`); rejects
    otherwise (403/404). Rejects when `mode !== 'demo'` (409/503).
  - Has the relayer deliver **real testnet USDC to the caller's own account** — `MockUSDC.mint(account,
    amountAtomic)` (or a transfer from a funded relayer balance if the token is non-mintable), via the
    chain provider. Waits for the receipt.
  - Records the delivery on the deposit record and advances its status through the existing
    `_applyStatus` machine to a settled/delivered state.
  - Returns `{ txHash, deposit }` (public deposit view). Never fabricates a balance — the credit is a
    real on-chain mint, so `arrivals`/balance reflect it from chain truth.
- Route `POST /v1/aurora/demo/deposit` (auth; demo-mode-gated) → `{ depositAddress, sourceChain,
  amountAtomic }` → `simulateInboundDeposit`. Rate-limited. Because it only mints testnet mock USDC to
  the caller's own account in demo mode, there is no real-value risk.
- `arrivals(prismId)` and `refreshDeposit` (existing) reflect the real credit from the chain/index.

### 3. iOS

- Re-enable the Aurora **receive** surface (the receive-from-any-chain screen / `AuroraDepositSection`)
  behind the demo flag — server-driven `demo` (from the Aurora chains/deposits responses) plus the
  existing cross-chain feature flag. Show a demo banner (the demo notice copy).
- Add a **"Simulate incoming deposit"** affordance: pick a source chain (from the catalog) + amount →
  `POST /v1/aurora/demo/deposit` → refresh deposits/arrivals/balance → show the route "delivered."
  "Received" / the balance increase only appears after the real on-chain credit (from the balance read
  / arrivals), never optimistically.

### 4. Money-truth & honesty

- The credited USDC is a real on-chain testnet mint → balance stays an on-chain read (INV-M1). No
  fabricated balances or delivery claims. Only the cross-chain deposit *event* is simulated, and every
  surface is labeled demo. `preview` and `live` modes are byte-for-byte unchanged.

### 5. Testing

- Backend: `DemoAuroraClient` `available`/`listTokens`/`persistentAddress`/`status`;
  `simulateInboundDeposit` credits the caller (mock chain provider), advances the deposit status,
  rejects a non-owned address and non-demo mode; `arrivals` reflects the delivery; `preview` mode
  unchanged.
- iOS: build succeeds; smoke — create a deposit address, simulate a deposit, confirm the balance rises
  and the route shows delivered.

## Out of scope (YAGNI)

SEND/SPEND outbound (its cross-chain delivery can't be real on testnet); real mainnet Aurora (`live`);
background auto-delivery; sub-project D (intent-facade migration).
