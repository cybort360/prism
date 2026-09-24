# Aurora Demo Mode — Receive From Any Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate "receive from any chain → your Monad balance" end-to-end on testnet behind `AURORA_MODE=demo`, where the credited USDC is real testnet USDC (only the cross-chain deposit event is simulated).

**Architecture:** A `DemoAuroraClient` drops into the existing `setAuroraClient` seam (mirrors sub-project A's provider swap). A demo-only `auroraService.simulateInboundDeposit` has the relayer mint real testnet USDC to the caller's own account and advances the deposit through the existing Aurora status machine to `delivered`. iOS re-enables the receive screen behind a demo flag with a "Simulate incoming deposit" action.

**Tech Stack:** Node.js ESM + `node:test` + viem (backend); SwiftUI (iOS). Branch `feat/aurora-demo-receive` off `main` (independent of sub-projects A/B).

## Global Constraints

- **Money-truth (INV-M1/M2):** the credited USDC is a real on-chain testnet mint; balance stays an on-chain read. No fabricated balances, no delivery claim without the real credit.
- **Honesty:** every demo surface is labeled demo; the notice copy is "Demo — the cross-chain deposit is simulated; the USDC credited to your balance is real testnet USDC." Only the deposit *event* is simulated.
- **Mode parity:** `AURORA_MODE` defaults to `preview` (unchanged); `live` (real mainnet Aurora) untouched. Demo is opt-in via env.
- **Demo-gated & safe:** the simulate endpoint is demo-mode-only, auth-required, and only credits the **caller's own** account with testnet mock USDC.
- **RECEIVE only:** no SEND/SPEND, no background scheduler.
- **Commit rules:** NO Claude/Anthropic attribution in commit messages. Run `xcodegen generate` after adding/removing Swift files.
- **Test commands:** backend `cd backend && npm test`; iOS `cd ios && xcodegen generate && xcodebuild -project Prism.xcodeproj -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' build`.
- **Aurora facts:** deposit status machine `AURORA_PROGRESSION = ['quoted','funding','funded','routing','delivered']`; `quoted → delivered` is a legal transition; status `'SUCCESS'` maps to state `'delivered'` (`AURORA_STATUS_STATE` in `backend/src/lib/lifecycle.js`). A new deposit record starts at `state: 'awaiting_deposit'` (mapped to `'quoted'` by `_applyStatus`).

---

## Task 1: `AURORA_MODE=demo` config

**Files:**
- Modify: `backend/src/config.js` (`auroraMode()` ~line 179; the `aurora:` block ~line 161)
- Test: `backend/test/aurora-demo.test.js` (new)

**Interfaces:**
- Produces: `config.aurora.mode ∈ {'preview','demo','live'}` (default `'preview'`); `config.aurora.demo` (boolean, `mode === 'demo'`).

- [ ] **Step 1: Write the failing test** — `backend/test/aurora-demo.test.js`

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

test('config: AURORA_MODE defaults to preview; demo flag derived', async () => {
  delete process.env.AURORA_MODE;
  const { config } = await import(`../src/config.js?a=${Math.random()}`);
  assert.equal(config.aurora.mode, 'preview');
  assert.equal(config.aurora.demo, false);
});
```
> If a fresh `config.js` import throws for missing env, prepend the same env bootstrap block other backend tests use (grep `test/aurora-send.test.js` for the `process.env.*` setup) — do not weaken validation.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/aurora-demo.test.js`. Expected: FAIL (`config.aurora.demo` undefined).

- [ ] **Step 3: Edit `config.js`** — replace `auroraMode()`:
```javascript
function auroraMode() {
  const mode = env('AURORA_MODE', 'preview');
  if (!['preview', 'demo', 'live'].includes(mode)) throw new Error("AURORA_MODE must be 'preview', 'demo', or 'live'");
  return mode;
}
```
In the `aurora:` block, after `mode: auroraMode(),` add:
```javascript
    demo: env('AURORA_MODE', 'preview') === 'demo',
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test test/aurora-demo.test.js`. Expected: PASS. Then `npm test` — no regressions.

- [ ] **Step 5: Commit**
```bash
git add backend/src/config.js backend/test/aurora-demo.test.js
git commit -m "Add AURORA_MODE=demo config"
```

---

## Task 2: `DemoAuroraClient` + startup wiring

**Files:**
- Create: `backend/src/aurora/demoAuroraClient.js`
- Modify: `backend/src/server.js` (swap the client at startup when demo)
- Test: add to `backend/test/aurora-demo.test.js`

**Interfaces:**
- Consumes: the demo token catalog from `backend/src/aurora/mockAuroraClient.js` if exported, else an inline list; `setAuroraClient` from `backend/src/aurora/index.js`.
- Produces: `makeDemoAuroraClient()` returning an object with the same interface as `auroraApiClient`: `name`, `available()` → true, `async listTokens()` → the catalog array, `async persistentAddress({ recipient, sender, depositChain, destinationChain, destinationAsset })` → `{ depositAddress, memo: null, correlationId: null, alreadyExists: false }` (deterministic per recipient+chain), `async status({ depositAddress })` → `{ status: null }` (the service tracks demo status in its own store; the client stays inert), `async quote()` → null, `async submitDeposit()` → null.

- [ ] **Step 1: Write the failing test** — append to `backend/test/aurora-demo.test.js`

```javascript
test('DemoAuroraClient: available, deterministic address, token catalog', async () => {
  const { makeDemoAuroraClient } = await import('../src/aurora/demoAuroraClient.js');
  const c = makeDemoAuroraClient();
  assert.equal(c.available(), true);
  const tokens = await c.listTokens();
  assert.ok(Array.isArray(tokens) && tokens.length > 0);
  const recipient = '0x00000000000000000000000000000000000000A1';
  const a1 = await c.persistentAddress({ recipient, depositChain: 'base', destinationChain: 'monad', destinationAsset: 'x' });
  const a2 = await c.persistentAddress({ recipient, depositChain: 'base', destinationChain: 'monad', destinationAsset: 'x' });
  assert.match(a1.depositAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(a1.depositAddress, a2.depositAddress); // deterministic
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/aurora-demo.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Write `backend/src/aurora/demoAuroraClient.js`**

```javascript
import { createHash } from 'node:crypto';

// Demo Aurora client for AURORA_MODE=demo. Same interface as auroraApiClient, but it makes no network
// calls and issues no real routes: it returns the real source-chain token catalog so the picker works,
// a deterministic per-user demo deposit address (display only), and an inert status (the service
// tracks demo delivery in its own store and credits real testnet USDC via simulateInboundDeposit).
const DEMO_TOKENS = [
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 0.9998 },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.9998 }
];

function demoAddress(...parts) {
  return `0x${createHash('sha256').update(['prism-demo-aurora', ...parts].join('|')).digest('hex').slice(0, 40)}`;
}

export function makeDemoAuroraClient() {
  return {
    name: 'aurora-demo',
    available() { return true; },
    async listTokens() { return DEMO_TOKENS; },
    async persistentAddress({ recipient, depositChain, destinationChain, destinationAsset }) {
      return {
        depositAddress: demoAddress(recipient, depositChain, destinationChain, destinationAsset),
        memo: null, correlationId: null, alreadyExists: false
      };
    },
    async status() { return { status: null }; }, // demo delivery is tracked by the service, not here
    async quote() { return null; },
    async submitDeposit() { return null; }
  };
}
```

- [ ] **Step 4: Wire the swap at startup in `server.js`** — near the aurora imports/construction (the file already imports `auroraClient` from `./aurora/index.js`; add `setAuroraClient`):
```javascript
import { auroraClient, setAuroraClient } from './aurora/index.js';
import { makeDemoAuroraClient } from './aurora/demoAuroraClient.js';
// after config is available, before the server starts handling requests:
if (config.aurora.mode === 'demo') setAuroraClient(makeDemoAuroraClient());
```
Place the `if` right after the service constructions (it only needs `config`). Verify `setAuroraClient` is exported from `aurora/index.js` (it is).

- [ ] **Step 5: Run to verify it passes** — `cd backend && node --test test/aurora-demo.test.js`. Expected: PASS. Then `npm test`.

- [ ] **Step 6: Commit**
```bash
git add backend/src/aurora/demoAuroraClient.js backend/src/server.js backend/test/aurora-demo.test.js
git commit -m "Add DemoAuroraClient + demo-mode startup swap"
```

---

## Task 3: `simulateInboundDeposit` + demo notice + route

**Files:**
- Modify: `backend/src/services/auroraService.js` (settlementAvailable, `_previewNotice`→`_modeNotice`, add `simulateInboundDeposit`)
- Modify: `backend/src/server.js` (add `POST /v1/aurora/demo/deposit`)
- Test: add to `backend/test/aurora-demo.test.js`

**Interfaces:**
- Consumes: `chainProvider()` from `backend/src/providers/index.js` (`writeContract`, `getTransactionReceipt`); `config.chain.usdc`; the existing `_account(prismId)`, `_publicDeposit(record)`, `_applyStatus(key, status)`, and `auroraDeposits` store.
- Produces: `auroraService.simulateInboundDeposit({ prismId, depositAddress, sourceChain, amountAtomic }) -> { txHash, deposit }`. Route `POST /v1/aurora/demo/deposit`.

- [ ] **Step 1: Read the existing shapes** — open `backend/src/services/auroraService.js` and confirm: `_account(prismId)`, `_publicDeposit(record)`, `_applyStatus(key, status)`, `_previewNotice()`, and the `auroraDeposits` record keyed by `depositAddress.toLowerCase()` (from `createDepositAddress`). Confirm `get settlementAvailable()` returns `this.mode === 'live'` today.

- [ ] **Step 2: Write the failing test** — append to `backend/test/aurora-demo.test.js`

```javascript
import { JsonStore } from '../src/lib/jsonStore.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
function tmpStore() { return new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-aurora-')), 'store.json')); }

test('simulateInboundDeposit credits the caller and delivers the deposit', async () => {
  const { AuroraService } = await import('../src/services/auroraService.js');
  const store = tmpStore();
  const account = '0x00000000000000000000000000000000000000A1';
  const addr = '0x00000000000000000000000000000000000000de';
  store.mutate((d) => { d.auroraDeposits = { [addr.toLowerCase()]: { depositAddress: addr, prismId: 'p1', recipientAccount: account, depositChain: 'base', state: 'awaiting_deposit', history: [], createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } }; });
  const config = { aurora: { mode: 'demo', destinationChain: 'monad' }, chain: { usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3' } };
  const identityService = { get: () => ({ prismId: 'p1', accountAddress: account }) };
  let minted = null;
  const chain = { writeContract: async (args) => { minted = args; return '0xmint'; }, getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) };
  const svc = new AuroraService({ store, config, identityService, paymentService: null, chain });
  const res = await svc.simulateInboundDeposit({ prismId: 'p1', depositAddress: addr, sourceChain: 'base', amountAtomic: '50000000' });
  assert.equal(res.txHash, '0xmint');
  assert.equal(res.deposit.state, 'delivered');
  assert.equal(minted.functionName, 'mint');
  assert.deepEqual(minted.args.map(String), [account, '50000000']);
});

test('simulateInboundDeposit rejects a non-owned address', async () => {
  const { AuroraService } = await import('../src/services/auroraService.js');
  const store = tmpStore();
  const addr = '0x00000000000000000000000000000000000000de';
  store.mutate((d) => { d.auroraDeposits = { [addr.toLowerCase()]: { depositAddress: addr, prismId: 'other', recipientAccount: '0x0', state: 'awaiting_deposit', history: [] } }; });
  const config = { aurora: { mode: 'demo' }, chain: { usdc: '0x0' } };
  const svc = new AuroraService({ store, config, identityService: { get: () => ({ prismId: 'p1', accountAddress: '0x0' }) }, paymentService: null, chain: {} });
  await assert.rejects(() => svc.simulateInboundDeposit({ prismId: 'p1', depositAddress: addr, sourceChain: 'base', amountAtomic: '1' }), /belongs to another|not found/i);
});
```

- [ ] **Step 3: Edit `auroraService.js`** — inject an optional `chain`, flip settlement in demo, rename the notice, add the method.

3a. Constructor: accept an injected chain provider (default the real one). At the top of the file add `import { chainProvider } from '../providers/index.js';` and in the constructor params add `chain = null`, then `this.chain = chain ?? chainProvider();`.

3b. Replace `get settlementAvailable() { return this.mode === 'live'; }` with:
```javascript
  get settlementAvailable() { return this.mode === 'live' || this.mode === 'demo'; }
```

3c. Rename `_previewNotice()` to `_modeNotice()` and make it mode-aware; update ALL call sites (grep `_previewNotice` — chains/listDeposits/arrivals/_publicRoute/_publicDeposit):
```javascript
  _modeNotice() {
    if (this.mode === 'live') return null;
    if (this.mode === 'demo') return {
      mode: 'demo',
      headline: 'Demo — cross-chain receive is simulated',
      detail: 'The deposit event is simulated; the USDC credited to your balance is real testnet USDC.'
    };
    // preview (unchanged copy):
    return {
      mode: this.mode,
      headline: 'Preview — routes are quoted, not settled',
      detail: `Aurora routes to Monad mainnet. Prism is running against chain ${this.config.chain.chainId}, so a deposit reaches your account on mainnet and will not appear in the balance shown here.`
    };
  }
```

3d. Add the method (place near `refreshDeposit`):
```javascript
  // Minimal MockUSDC mint ABI — demo delivery credits real testnet USDC to the user's own account.
  static get MINT_ABI() {
    return [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];
  }

  /**
   * Demo-only: simulate an inbound cross-chain deposit. The relayer mints real testnet USDC to the
   * caller's own account (a genuine on-chain credit — money-truth holds) and the deposit advances to
   * `delivered`. Only the "a deposit arrived on chain X" event is simulated; the money is real.
   */
  async simulateInboundDeposit({ prismId, depositAddress, sourceChain, amountAtomic }) {
    if (this.mode !== 'demo') throw httpError(409, 'demo deposits are only available in AURORA_MODE=demo');
    if (!/^\d+$/.test(String(amountAtomic)) || BigInt(amountAtomic) <= 0n) throw httpError(400, 'amount must be a positive integer');
    const key = String(depositAddress ?? '').toLowerCase();
    const existing = (this.store.read().auroraDeposits ?? {})[key];
    if (!existing) throw httpError(404, 'deposit address not found');
    if (existing.prismId !== prismId) throw httpError(403, 'deposit address belongs to another account');
    const account = this._account(prismId);

    // Real on-chain credit: mint testnet USDC to the user. (If this deployment's USDC is not the
    // mintable mock, replace with a transfer from a funded relayer balance — same shape.)
    const { getAddress } = await import('viem');
    const txHash = await this.chain.writeContract({
      address: getAddress(this.config.chain.usdc), abi: AuroraService.MINT_ABI, functionName: 'mint',
      args: [getAddress(account), BigInt(amountAtomic)]
    });
    await this.chain.getTransactionReceipt(txHash).catch(() => null);

    // Advance the deposit to delivered through the existing status machine ('SUCCESS' -> 'delivered').
    const updated = this._applyStatus(key, { status: 'SUCCESS', swapDetails: { sourceChain, amountAtomic, demo: true, txHash } });
    logger.info('aurora.demo.deposit', { prismId, sourceChain, amountAtomic });
    return { txHash, deposit: this._publicDeposit(updated) };
  }
```
(Confirm `httpError`, `logger`, `_account`, `_applyStatus`, `_publicDeposit` are all in scope in this file — they are.)

- [ ] **Step 4: Add the route in `server.js`** — near the other aurora routes:
```javascript
route('POST', '/v1/aurora/demo/deposit', async ({ user, body }) => {
  rateLimit(`aurora-demo:${user.prismId}`, 30);
  return auroraService.simulateInboundDeposit({ prismId: user.prismId, depositAddress: body.depositAddress, sourceChain: body.sourceChain, amountAtomic: body.amountAtomic });
}, true);
```

- [ ] **Step 5: Run tests** — `cd backend && node --test test/aurora-demo.test.js` then `npm test`. Expected: PASS, no regressions (preview notice copy unchanged; `_modeNotice` returns the same preview object in preview mode — verify an existing aurora test still passes).

- [ ] **Step 6: Commit**
```bash
git add backend/src/services/auroraService.js backend/src/server.js backend/test/aurora-demo.test.js
git commit -m "Add demo inbound-deposit settlement (real testnet USDC credit) + route"
```

---

## Task 4: iOS models + API

**Files:**
- Modify: `ios/Prism/Services/PrismAPI.swift` (add the simulate method); `ios/Prism/Features/Aurora/AuroraModels.swift` (ensure the chains/deposits responses expose `mode` + `notice`)
- Test: iOS build

**Interfaces:**
- Produces: `simulateAuroraDeposit(depositAddress:sourceChain:amountAtomic:) -> AuroraDeposit`; the Aurora chains/deposits response models decode `mode: String?` and `notice: AuroraNotice?` (`{ headline, detail, mode }`).

- [ ] **Step 1: Add the API method** — in `PrismAPI.swift` near the other aurora methods:
```swift
  struct SimulateAuroraDepositBody: Encodable { let depositAddress: String; let sourceChain: String; let amountAtomic: String }
  func simulateAuroraDeposit(depositAddress: String, sourceChain: String, amountAtomic: String) async throws -> AuroraDeposit {
    try await api.send("/v1/aurora/demo/deposit", body: SimulateAuroraDepositBody(depositAddress: depositAddress, sourceChain: sourceChain, amountAtomic: amountAtomic))
  }
```
(Confirm `AuroraDeposit` is the type `createAuroraDepositAddress`/`refreshAuroraDeposit` already return; reuse it.)

- [ ] **Step 2: Ensure `mode`/`notice` decode** — in `AuroraModels.swift`, the chains + deposits response structs should carry optional `mode: String?` and `notice: AuroraNotice?` where `struct AuroraNotice: Codable, Equatable { let headline: String; let detail: String; let mode: String? }`. Add them if absent (optional, backward-compatible). The backend already returns `mode`, `settlementAvailable`, `notice` on these responses.

- [ ] **Step 3: Build** — `cd ios && xcodegen generate && xcodebuild -project Prism.xcodeproj -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED" | head`. Expected: BUILD SUCCEEDED. (Cross-file SourceKit "cannot find type" are false positives.)

- [ ] **Step 4: Commit**
```bash
git add ios/Prism/Services/PrismAPI.swift ios/Prism/Features/Aurora/AuroraModels.swift ios/Prism.xcodeproj
git commit -m "Add simulate-aurora-deposit API + mode/notice models"
```

---

## Task 5: iOS receive screen (demo) + simulate action

**Files:**
- Modify: `ios/Prism/Features/Aurora/AuroraDepositSection.swift` (the receive-from-any-chain UI); the entry point that gates it (find via `grep -rn "AuroraDepositSection" ios/Prism`)
- Test: iOS build

**Interfaces:**
- Consumes: `auroraChains()`, `createAuroraDepositAddress(depositChain:)`, `auroraDeposits()`, `refreshAuroraDeposit(address:)`, `simulateAuroraDeposit(...)`, `PrismAPI.shared.balance()`.

- [ ] **Step 1: Gate + banner** — add `@AppStorage("feature.crossChainReceive") private var crossChainReceive = false` on the entry point that shows `AuroraDepositSection`, so the receive screen is reachable when the flag is on. In `AuroraDepositSection`, when the chains/deposits response `mode == "demo"`, render a demo banner using `notice.headline` + `notice.detail`.

- [ ] **Step 2: Simulate action** — after a deposit address is shown, add a "Simulate incoming deposit" control: pick a source chain (from `auroraChains()`) + an amount, then:
```swift
let deposit = try await PrismAPI.shared.simulateAuroraDeposit(depositAddress: address, sourceChain: chain, amountAtomic: atomic)
// then refresh the real state:
_ = try? await PrismAPI.shared.auroraDeposits()
// refresh the account balance so the real credit shows (never optimistic):
await model.refreshBalance()   // use whatever the app calls to re-read on-chain balance
```
Show the deposit's `state` ("delivered") from the returned/ refreshed record. The received amount must come from the refreshed on-chain **balance**, never asserted optimistically from the simulate call.

- [ ] **Step 3: Build** — `cd ios && xcodegen generate && xcodebuild ... build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**
```bash
git add ios/Prism/Features/Aurora
git commit -m "Re-enable Aurora receive (demo) with a simulate-deposit action"
```

---

## Task 6: End-to-end smoke + close-out

**Files:** none (verification)

- [ ] **Step 1:** Backend up with `AURORA_MODE=demo`. Confirm the app's testnet USDC (`config.chain.usdc`) is the mintable MockUSDC — call `mint` once via `cast` or the endpoint; if it reverts (non-mintable), switch delivery to a transfer from a pre-funded relayer USDC balance (fund the relayer once) and re-test.
- [ ] **Step 2: Simulator smoke** — enable `feature.crossChainReceive`, open the receive screen → confirm the demo banner → generate a deposit address → "Simulate incoming deposit" (source chain + amount) → confirm the account **balance rises** by that amount (real on-chain credit) and the deposit shows `delivered`.
- [ ] **Step 3: Full pass** — `cd backend && npm test` (green incl. aurora-demo.test.js), `cd ios && xcodebuild ... build` (BUILD SUCCEEDED).

---

## Self-Review

**Spec coverage:**
- `AURORA_MODE=demo` + demo flag (§1) → Task 1.
- `DemoAuroraClient` in the setAuroraClient seam (§1) → Task 2.
- `settlementAvailable` in demo + demo notice (§2) → Task 3 (3b, 3c).
- `simulateInboundDeposit` (real USDC mint, status→delivered, ownership + demo-mode guards) + route (§2) → Task 3.
- iOS receive screen behind demo flag + simulate action + honest balance (§3) → Tasks 4–5.
- Money-truth (§4) → Task 3 (real mint) + Task 5 (balance from on-chain read).
- Testing (§5) → per-task + Task 6.

**Placeholder scan:** No TBD/TODO. "find via grep" for the AuroraDepositSection entry point and the balance-refresh call name are locate-and-match instructions against real code, not invented APIs.

**Type consistency:** `simulateInboundDeposit({ prismId, depositAddress, sourceChain, amountAtomic }) -> { txHash, deposit }` defined Task 3, consumed by the Task 4 iOS method shape. `_modeNotice` replaces `_previewNotice` at all call sites (Task 3, 3c). `makeDemoAuroraClient` interface (Task 2) matches `auroraApiClient`'s used methods.

**Open items the implementer confirms (not blockers):** whether the testnet USDC is mintable (Task 6 Step 1 — the mint call verifies; fallback documented); the exact iOS balance-refresh call name (Task 5) and the AuroraDepositSection entry point (Task 5 Step 1).
