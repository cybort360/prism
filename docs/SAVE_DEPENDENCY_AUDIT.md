# SAVE — Dependency Audit (Phase 0 / Phase 1)

Verification-only pass for **Prism Save** (USDC → AUSD → earnAUSD). No Save code written.
All on-chain facts gathered with `cast` against public RPCs on **2026-09-14**. Where a fact could not
be independently verified with the available tools, it is marked **UNKNOWN** — not assumed.

> **Headline blocker:** the Save substrate (AUSD, earnAUSD) is live on **Monad mainnet (chainId 143)**.
> **PRISM is deployed on Monad testnet (chainId 10143)** — verified: **no code** at the earnAUSD address
> on testnet. The real vault cannot be exercised from PRISM's current chain, and its deposit interface
> could not be verified from a trusted source. Per the task's stop condition, this halts before any build.

---

## MONAD

| | Value | Notes |
|---|---|---|
| PRISM environment | **testnet, chainId 10143**, RPC `https://testnet-rpc.monad.xyz` | Where PRISM's router/vault/accounts + USDC mock are deployed (`backend/src/config.js` default). |
| Save-substrate environment | **mainnet, chainId 143**, RPC `https://rpc.monad.xyz` | Where AUSD + earnAUSD live. Confirmed `eth_chainId → 143`. |

## USDC

| field | mainnet (143) | testnet (10143) |
|---|---|---|
| address | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| symbol / decimals | `USDC` / `6` ✓ | `USDC` / `6` (PRISM mock) |
| ERC-2612 | `nonces()` responds (permit likely) | n/a |
| Prism-account compatibility | PRISM has **no** deployed account/router on 143 | PRISM settles here today (ERC-3009 + PrismPaymentRouter) |
| usable for Save input | only on the chain where earnAUSD exists (143) | earnAUSD absent on 10143 |

Both addresses are already present in `backend/src/config.js` (`USDC_KNOWN`). Save input is USDC per the
product definition; normal Prism payments stay USDC and are untouched.

## AUSD

| field | value |
|---|---|
| network | Monad mainnet (143) |
| address | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` |
| symbol / decimals | `AUSD` / `6` ✓ |
| issuer / backing | Agora; 1:1 USD, T-bills (VanEck / State Street) — per Agora docs |
| ERC-20 | yes (symbol/decimals responded) |
| ERC-2612 / ERC-3009 | **UNKNOWN** (not probed on AUSD; verify `permit`/`transferWithAuthorization` before relying) |
| verified source | **UNKNOWN** (explorers Cloudflare-blocked; Sourcify not checked for AUSD) |
| usable | as an ERC-20, yes on 143; not present on PRISM's testnet |

## EARNAUSD

| field | value |
|---|---|
| network | Monad mainnet (143) |
| address (proxy) | `0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA` |
| proxy | **YES** — EIP-1967. impl `0x7a5606730b4c7f40b0f2079d873232034560e718`, admin `0x04ae5a71ea943f9fc4ecb3bd4118e381cd04067d` |
| owner() | `0xCA139BD2F6fcf6a0B4b2b523351C651832797d25` |
| underlying asset | `asset()` → AUSD (`0x0000…9012a`) ✓ |
| share token vs vault | **UNRESOLVED** — see below |
| decimals / symbol / name | **UNKNOWN** — all **revert** on-chain |
| totalSupply / totalAssets | **UNKNOWN** — revert |
| previewDeposit / convertToShares / maxDeposit | **UNKNOWN** — revert |
| paused() | **UNKNOWN** — reverts |
| deposit ABI | **UNKNOWN** — not established |
| instant-withdraw ABI | **UNKNOWN** |
| queued-withdraw ABI | **UNKNOWN** |
| share-price calc | **UNKNOWN** (no responding price/preview fn) |
| withdrawal fees / queue | per docs only: queued ~72h (processed daily) **or** instant for a small fee; **not** read from contract |
| incentives | extra AUSD + wMON via **Merkl** (separate claim) — per docs |
| curator / policy | **Gamma Research** (per Upshift docs); on-chain policy controls UNKNOWN |
| upgrade authority | proxy admin `0x04ae…067d` (address only; ProxyAdmin/timelock nature UNVERIFIED) |
| verified source | **NO** — Sourcify has no match for impl on chain 143; Monad explorers (monadexplorer.com → monadvision.com) are Cloudflare/403-walled to automated fetch |
| **usable** | **NO** (interface unverified + wrong chain for PRISM) |

### Why "do not assume ERC-4626" was right
The on-chain surface at `0x36eD…406aA` answers **only** `asset()` and `owner()`; every ERC-20 metadata
call (`symbol/name/decimals/totalSupply`) and every ERC-4626 call (`previewDeposit/convertToShares/
totalAssets/maxDeposit`) and `paused()` **revert with empty data**. Documentation says earnAUSD is a
**Veda BoringVault** (Upshift infra): deposits go through a separate **Teller** (approve the BoringVault,
call `Teller.deposit`), and a BoringVault is normally its own ERC-20 share token with a working `symbol`.
This address matches **neither** a vanilla ERC-4626 **nor** a standard BoringVault share token. Without
verified source, the actual deposit entry point (Teller address) and its ABI are **not established** — so
the deposit contract is **not independently verified.**

---

## Repository execution reality (corrects a premise in the task)

- **`PrismAccount.executeBatch` is NOT in the active codebase.** It exists only under
  `archive/erc4337-p256/src/PrismAccount.sol` (`execute` / `executeBatch`, `onlyEntryPoint`) — archived,
  not the runtime.
- The **live** account is `contracts/src/PrismP256Account.sol`, which exposes only `pay(...)` and states
  "no bundler/EntryPoint dependency." It cannot perform an arbitrary `approve → swap → approve → deposit`
  batch.
- Consumer payments today use the **Mera passkey (secp256k1) account + `PrismPaymentRouter` + ERC-3009**,
  on **testnet**. There is no live ERC-4337 / batch-capable account, and none deployed on mainnet 143.

Implication: **Phase 3 (atomic Save inside one sponsored UserOperation via `executeBatch`) is not
achievable with the current active contracts.** It requires reviving the archived ERC-4337 account (or
confirming the Mera account supports batched execution) **and** deploying it on the chain where earnAUSD
lives.

---

## PHASE 1 — Route candidates (USDC → AUSD, then → earnAUSD)

None of these could be **proven executable by a real Prism address** because (a) PRISM has no execution
address on Monad mainnet 143, and (b) the earnAUSD deposit ABI is unverified. Quotes were **not
fabricated**; where an API/key was required and not run, that is stated.

| Route | Status | Finding |
|---|---|---|
| **A. Agora Instant Settlement** | `PERMISSIONED_UNAVAILABLE / UNKNOWN` | Agora Instant Settlement on mainnet is **permissioned** (`APPROVED_SWAPPER`). No factory/pair confirmed callable, and no Prism execution address exists on 143 to be approved. Cannot mark usable. |
| **B. Enso (USDC→AUSD→earnAUSD)** | `UNPROVEN` | Not confirmed that Enso indexes this earnAUSD position on Monad; no live route obtained. Generic Enso vault support ≠ earnAUSD indexed. |
| **C. 0x (USDC→AUSD)** | `UNPROVEN` | Live Monad-mainnet quote not obtained (needs 0x API access; and any quote would be for 143, which PRISM can't execute from today). |
| **D. Kuru (USDC→AUSD)** | `UNPROVEN` | Kuru is a Monad-native order-book DEX; a USDC/AUSD market + quote were not confirmed. |

---

## Recommendation

**Do not build Save execution yet.** Two hard prerequisites are unmet:

1. **Independently verify the earnAUSD deposit interface.** Obtain the Teller/BoringVault addresses + the
   exact `deposit` / withdraw ABI and share-price source from an authoritative source — the Upshift/Veda
   team, the Veda `boring-vault` deployment registry, or a browser-authenticated Monad explorer (the
   automated fetch is Cloudflare-blocked). Until then the deposit contract is unverified → **STOP** holds.
2. **Resolve the execution model.** earnAUSD is **mainnet-143 only**; PRISM is **testnet-10143** with no
   mainnet account and **no live batch account**. Real Save requires PRISM to operate on mainnet 143
   with a **batch-capable, user-controlled account** (revive the archived ERC-4337 `PrismAccount`, or
   confirm the Mera account can batch) so the swap + vault-deposit are atomic and the user (never a
   backend wallet) receives the earnAUSD shares.

Likely V1 shape **once those are resolved** (not yet proven): `USDC → AUSD` via **0x or Kuru** (Agora
Instant Settlement only if Prism's exec address is granted `APPROVED_SWAPPER`), then a single
`Teller.deposit(AUSD, amount, minShares)` with `receiver = user's Prism account`, all inside one
sponsored batched UserOperation with client-side allowlist verification.

---

## verified_at
2026-09-14, via `cast` on `https://rpc.monad.xyz` (143) and `https://testnet-rpc.monad.xyz` (10143);
Sourcify v2 (`/server/v2/contract/143/...` → no match); explorer HTML/API fetches blocked by Cloudflare.
