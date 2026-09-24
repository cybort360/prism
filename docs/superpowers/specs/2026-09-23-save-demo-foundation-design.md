# Save demo + foundation (Sub-project A of 4)

**Date:** 2026-09-23. **Status:** Approved (design).

## Program context

This is the first of four sequenced sub-projects that turn Jay's + PurpleDNA's dark/preview
backend seams into working features. Each gets its own spec → plan → build:

| # | Sub-project | Reuses |
|---|-------------|--------|
| **A (this)** | **Save demo + foundation** — MockVault on testnet, demo Save deposit/position/withdraw | — |
| B | RECEIVE → Circle/Savings (two-hop sweep on settlement) | MockVault |
| C | Aurora demo mode (real testnet round-trip for the routed leg) | demo settlement agent |
| D | Full intent-facade migration (iOS onto `/v1/intent/prepare`) | A–C |

Cross-cutting decisions locked during brainstorming (apply to all four):
- Deployment-blocked seams (Aurora, Save) are built as **mock-live demo mode**, never real mainnet.
- Demo settlement is a **real testnet round-trip** — real USDC / real shares move on-chain, so the
  money-truth invariant (INV-M1/M2: shown balance is always an on-chain read) is preserved. Only the
  *source* (cross-chain bridge, mainnet yield) is simulated, never the money.

## Problem (this sub-project)

Prism Save ships as an announced preview: `quote` + chain-reconstructed `position` work, but there is
**no execute path at all** (`PreviewSaveExecutor.execute()` always throws `save_not_live`; no
submit/withdraw route; iOS Save is display-only). earnAUSD is mainnet-143-only with an unverified
deposit ABI, so real Save cannot run against this testnet deployment. We want Save demonstrable
end-to-end on testnet without inventing balances or touching mainnet.

## Existing seams we build behind (do not reimplement)

- `SaveService` takes a **`routeProvider`** (default `DevSaveRouteProvider`, preview, non-executable
  plan) — a drop-in seam by design.
- `saveExecution.js` exposes **`PreviewSaveExecutor`** (executor seam) — currently always 409s.
- `saveIntent.js` — EIP-712 typed data, `validateSaveIntent`, nonce consume. Reused for authorization.
- `savePositionService.position()` — already reconstructs the position from chain; we point it at the
  MockVault in demo mode.
- `contracts/src/mocks/MockUSDC.sol` — ERC-20 with `mint()`, already deployed on testnet. Vault asset.

## Design

### 1. MockVault.sol (new — `contracts/src/mocks/MockVault.sol`, deployed to Monad testnet)

A minimal ERC-4626-style vault whose asset is MockUSDC.

- Standard surface: `deposit(assets, receiver)`, `redeem(shares, receiver, owner)`,
  `previewDeposit(assets)`, `previewRedeem(shares)`, `convertToAssets(shares)`,
  `convertToShares(assets)`, `totalAssets()`, `balanceOf(owner)`, `decimals()`.
- `depositWithAuthorization(from, amount, validAfter, validBefore, nonce, v, r, s)` — verifies an
  ERC-3009 `receiveWithAuthorization` **pull** of `amount` USDC from `from`, then mints shares to
  `from`. This lets the **relayer submit one user-authorized deposit tx**, matching Prism's gasless
  payment model (no user gas, user authorizes by signature).
- `redeemWithAuthorization(owner, shares, validAfter, validBefore, nonce, v, r, s)` — the symmetric
  withdraw: verifies the `owner`'s EIP-712 signature over the redeem, burns the owner's shares, and
  sends the USDC to the owner. Relayer-submittable, single tx, no pre-set allowance.
- `simulateYield(uint256 usdcAmount)` — `onlyOwner`; pulls/mints MockUSDC into the vault so
  assets-per-share rises. Yield becomes a **real on-chain share-price change**, never a fabricated
  number. Chosen over time-based accrual for demo controllability (deterministic, triggerable on cue).
- Share math: first deposit mints 1:1 (assets == shares at 6 decimals); subsequent deposits use
  `assets * totalSupply / totalAssets`. Redeem is the inverse. Standard rounding-down on mint,
  rounding-down on redeem (never mint value from rounding).
- Deploy script `contracts/script/DeployMockVault.s.sol`; record the address in the deployed-config
  surface the backend reads (alongside the other testnet addresses). Broadcast artifacts are NOT
  committed (project rule).

### 2. Backend — demo providers behind the existing seams

- **Config:** new `SAVE_MODE = preview (default) | demo | live` and `SAVE_MOCK_VAULT` address. Keep
  `substrateVerified` meaning "real mainnet earnAUSD". Add a derived `demo = SAVE_MODE === 'demo'`.
  `state()` returns `demo`; deposits are allowed when `live || demo`. `realMoneyEnabled` stays false
  in demo (it is not real money / not mainnet).
- **`DemoVaultSaveRouteProvider`** (route-provider seam): builds an **executable** plan targeting
  MockVault. `live:false, demo:true`. The min-shares floor comes from an on-chain `previewDeposit`
  read minus `maxSlippageBps`; the plan verifies as executable (unlike the preview plan, which is
  intentionally non-executable). Review copy states demo status.
- **`DemoSaveExecutor`** (executor seam): submits `depositWithAuthorization` via the existing relayer;
  returns an operation with a **real tx hash**; drives state through the existing `saveLifecycle`.
  Idempotent by intent nonce (reuse `consumeSaveNonce`).
- **Routes:**
  - `POST /v1/save/prepare` (exists) → returns the SaveIntent typed data to sign in demo mode.
  - `POST /v1/save/submit` (new) → `{ intent, signature }`; validates via `validateSaveIntent`,
    executes via `DemoSaveExecutor`, returns `{ operationId, txHash, state }`.
  - `POST /v1/save/withdraw` (new) → `{ sharesAtomic, signature }`; relayer submits the redeem, real
    USDC returns to the user's account. Returns `{ operationId, txHash, state }`.
  - Withdraw authorization is **symmetric with deposit**: MockVault exposes
    `redeemWithAuthorization(owner, shares, validAfter, validBefore, nonce, v, r, s)` that verifies
    the `owner`'s EIP-712 signature over the redeem and lets the **relayer** execute it, burning the
    owner's shares and sending the USDC to the owner. One relayer tx, user-authorized by signature —
    no pre-set allowance, mirroring `depositWithAuthorization`.
- **`savePositionService.position()`**: in demo mode reads real shares from MockVault
  (`balanceOf`) → `convertToAssets` → USDC value. Yield shows because the share price actually moved.

### 3. iOS

- `SaveView`: when `state.demo == true`, render a **"Demo — simulated yield on testnet"** banner and
  enable the deposit flow: amount → quote → Face ID/PIN → sign SaveIntent → `POST /v1/save/submit`.
- Wire Position and Withdraw to the real reads / `POST /v1/save/withdraw`.
- Server-driven by `state.demo`; existing `feature.save` `@AppStorage` flag still gates whether Save
  is visible at all. New API methods: `savePrepare`, `saveSubmit`, `saveWithdrawSubmit`.

### 4. Invariants & honesty

- **INV-M1/M2:** position value and account balance are both on-chain reads; yield is a real testnet
  share-price change. No optimistic credit, no fabricated APY.
- **Copy:** "Demo — simulated yield on testnet, not real earnAUSD." Never "guaranteed", "best APY",
  or "highest yield" (`SAVE_MANAGED_COPY` rules still hold).
- Preview remains the default mode; demo is opt-in via env; no mainnet exposure. `live` mode remains
  the future real-earnAUSD path, unaffected.

## Testing

- **Foundry** (`contracts/test/MockVault.t.sol`): deposit mints correct shares; first-deposit 1:1;
  `depositWithAuthorization` verifies signature and pulls USDC; `redeem` returns correct assets;
  `simulateYield` raises share price so a later redeem returns more than deposited; rounding never
  mints value.
- **Backend** (`backend/test/save-demo.test.js`): `SAVE_MODE=demo` → `state.demo` true; demo route
  provider returns an executable plan; submit executes and returns a tx hash (mock chain provider);
  position reflects shares + yield; withdraw round-trips; preview mode unchanged (regression).
- **iOS:** build succeeds; smoke deposit → position (observe yield after `simulateYield`) → withdraw
  against a demo backend.

## Out of scope (YAGNI)

- Real earnAUSD / mainnet (`live` mode) — untouched.
- Multiple strategies, partial withdrawals UI beyond existing modes, APY history charts.
- Sub-projects B/C/D (separate specs). MockVault is built here; B reuses it for the SAVINGS sweep.
