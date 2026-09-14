# Prism Circles — architecture proof (Phases 1–3)

This is the evidence behind the decision to build Prism Circles on Safe rather than on a custom
multisig. It is written to be falsifiable: every claim names the test that establishes it, and the
places where the original plan did not survive contact are stated plainly rather than smoothed over.

**No Circle UI is built in this phase, and no existing Prism account was modified.**

Run everything: `make test-circles`, plus the Swift suite in `ios/PrismTests/CircleSafeTxHashTests.swift`.

---

## The headline finding: there is no PrismAccount to make a Safe owner

The task assumed *"the existing PrismAccount has EIP-1271 support for its P256 authority"* and that
each admin's existing PrismAccount address could become a Safe owner. That assumption does not hold
against this repository, for three independent reasons. All three were verified, not inferred.

**1. PrismAccount is archived, not live.** Prism v1.1 replaced the Secure-Enclave-P256 / ERC-4337
path with the **Mera passkey-derived secp256k1 EOA**, which is now "both the USDC-holding account
and the signing authority" (`ios/MeraBridge/MeraAccountService.swift`). `PrismAccount.sol` exists
only under `archive/erc4337-p256/`. It is referenced by no live code and is deployed nowhere —
`deployments/monad-testnet.json` contains a router, a vault and a claim authorizer, and no account.

**2. It has never compiled.** `PrismAccount.validateUserOp` reads `userOp.signature.offset` in
assembly. Solidity does not permit `.offset` on a **calldata struct member** — only on a calldata
variable — so the file fails to compile under its own declared `solc 0.8.28`. Confirmed by reducing
it to a four-line repro. Git history shows the file was committed already inside `archive/`, so its
companion test never ran either. (`archive/erc4337-p256/` is also missing `SafeTransferLib.sol`,
which it imports, so the directory cannot build standalone at all.)

**3. Its EIP-1271 surface is the wrong one for Safe.** This is the substantive finding, and it
would have bitten even if (1) and (2) were fixed.

Safe **v1.4.1** validates a contract owner like this:

```solidity
// safe-contracts v1.4.1, Safe.checkNSignatures
require(keccak256(data) == dataHash, "GS027");
require(ISignatureValidator(currentOwner).isValidSignature(data, contractSignature)
        == 0x20c13b0b, "GS024");
```

It calls the **legacy** `isValidSignature(bytes,bytes)` and requires magic `0x20c13b0b`, passing the
full EIP-712 **pre-image**. It never calls `isValidSignature(bytes32,bytes)` / `0x1626ba7e` — that
form appears in v1.4.1 only on the `CompatibilityFallbackHandler`, for a Safe acting as a *signer*,
which is the opposite direction.

`PrismAccount` implements **only** the `bytes32` form. A Safe would call a function that does not
exist on it, and the call reverts with no data.

This is proven, not argued: `test_C_ArchivedPrismAccount1271Surface_IsRejectedBySafe` deploys the
archived 1271 logic verbatim as a real Safe's only owner, signs a genuinely valid P-256 signature
over the correct digest, shows the archived contract **accepts that signature on its own terms**
(`0x1626ba7e`), and then shows `execTransaction` reverting anyway — with a bare revert rather than
`GS024`, because there is no function to reject it.

### Why this does not change the architecture

The Safe architecture is sound; only the specific claim about the archived account was wrong. Both
owner paths are proven working against the real Safe v1.4.1 on Monad:

| Owner type | What it is today | Mechanism | Proof |
|---|---|---|---|
| **Mera passkey account (secp256k1 EOA)** | **what Prism ships now** | native Safe owner, plain ECDSA — no EIP-1271 involved | `test_B_MeraEoaOwner_CanSpendCircleUsdc` |
| P-256 authority via EIP-1271 | for if/when the smart-account path returns | `PrismP256SafeOwner`, same key, same digest convention, correct 1271 surface | `test_D_P256ContractOwner_CanSpendCircleUsdc` |
| Both together, 2-of-2 | a mixed Circle | Safe's ordered signature envelope | `test_D_TwoOfTwo_MeraEoaPlusP256Authority` |

### DECIDED: a Circle admin is their existing Mera account

**A Circle admin's owner identity is their existing Mera passkey-derived secp256k1 address — the
first row above.** Decided 2026-09-13; this is settled, not a recommendation.

It needs no new credential, no new contract, and no EIP-1271 at all: a Mera account is already a
native Safe owner signing plain ECDSA. Nothing about a person's existing personal Prism account
changes when they join a Circle.

`PrismP256SafeOwner` (`contracts/src/circles/PrismP256SafeOwner.sol`) stays in the tree as *proof
the P-256 path is available*, not because Circles uses it. It is not on the shipping path. If that
path is ever revived, the correct fix is to add the legacy `isValidSignature(bytes,bytes)` surface
to `PrismAccount` itself rather than ship a second contract per admin.

Consequence to remember: Safe owners are fixed at Circle creation. Revisiting this later means an
owner-swap transaction on every Circle that already exists — supported by Safe, but a migration.

---

## Phase 1 — PrismAccount → Safe owner compatibility

`contracts/test/circles/CircleSafeOwnerCompat.t.sol` — **17 tests, all passing.**

Everything runs against a **Monad testnet fork**: the real Safe v1.4.1 singleton and proxy factory
at their codehash-verified addresses, the real EIP-7951 P-256 precompile, and the real Circle USDC
contract. Only member key material is synthetic. P-256 signatures come from
`contracts/script/circles/p256-sign.mjs` over ffi, which signs with `sha256` digesting to reproduce
CryptoKit's `signature(for: Data)` — the exact convention Prism iOS uses. Its two keys are derived
from fixed seeds rather than stored: they are fixtures, they guard nothing (P-256 is not secp256k1,
so they can never be an Ethereum account, and no deployed contract is bound to them), and deriving
them keeps key-shaped material out of the repository.

Positive:

- the Safe singleton answers `VERSION() == "1.4.1"` and all three core codehashes match canonical;
- a Mera-style EOA owner spends Circle USDC, relayer-submitted;
- a P-256 contract owner spends Circle USDC, with `vm.expectCall` proving Safe really routes
  through the owner's `0x20c13b0b` entrypoint;
- a 2-of-2 Circle mixing both owner types settles; a single approval on it does not (`GS020`).

Negative — **every one fails with its exact Safe revert code**, not a bare "it reverted":

| Attack | Result |
|---|---|
| wrong P-256 signer | `GS024` |
| modified recipient | `GS024` |
| modified amount | `GS024` |
| modified token target | `GS024` |
| operation switched to `DelegateCall` | `GS024` |
| signed against the wrong Safe nonce | `GS024` |
| replay of an already-executed transaction | `GS024` |
| signature minted for a different Circle's Safe | `GS024` |
| signature minted under a different chainId | `GS024` |
| truncated (63-byte) / oversized (65-byte) signature | `GS024` |

The last three matter most: the Safe address and chainId are inside the EIP-712 domain, so a
signature is bound to one Circle, on one chain, at one nonce, with no extra machinery.

### Two findings about the toolchain

- **Foundry needs `--network monad`.** Without it, a call to the P-256 precompile at `0x0100`
  returns *success with empty output*, `P256Verifier.verify` reads that as "invalid", and every
  P-256 test quietly becomes vacuous while still appearing to run. Foundry ≥1.8 fixes this with
  `--network monad`, which is now mandatory in the Makefile and CI.
- **P-256 signatures are malleable on Monad.** The precompile accepts both `s` and `n − s`. Safe's
  nonce makes this unexploitable here, but **proposals must be keyed by `safeTxHash`, never by
  signature bytes**.

---

## Phase 2 — the phone verifies the Safe hash itself

The threat: a compromised backend renders "Pay Tobi $20" while handing the Secure Enclave a digest
for something else. The defence is that the phone never trusts a digest it did not compute.

New, on the iPhone (`ios/Prism/Core/Circles/`):

- `Keccak256.swift` — Keccak-256, which CryptoKit does not provide and which is *not* SHA3-256.
- `SafeABI.swift` — `SafeUInt256` (exact 256-bit parsing, refuses overflow rather than wrapping)
  and `EVMAddress` (case-insensitive, rejects malformed input).
- `SafeTransactionHash.swift` — the Safe v1.4.1 digest, domain separator and EIP-712 pre-image.
- `CircleApprovalPayload.swift` — the payload and the validator that refuses to sign.

`CircleApprovalValidator` checks, in order: circle id · Safe address · chainId · Safe nonce (when
known) · target is the Circle's configured USDC · operation is `Call` · zero native value · gas
refund fields neutral · calldata decodes as exactly `transfer(address,uint256)` · decoded recipient
equals the reviewed recipient · decoded amount equals the reviewed amount · **and the recomputed
`safeTxHash` equals the one the backend sent**. Any mismatch throws a specific, human-readable
rejection.

Two checks are worth calling out because they close gaps that are easy to miss:

- **Gas-refund neutrality.** A non-zero `gasPrice` makes the Safe reimburse `refundReceiver` out of
  Circle funds — a second, unreviewed payment hidden inside the first.
- **Exact calldata length (68 bytes).** An ABI decoder ignores trailing bytes, but they are inside
  the signed digest. Trailing data is rejected.

### The vectors are not self-generated

This is what makes the match meaningful. Three independent implementations are held to one another:

1. **The chain** — `contracts/test/circles/CircleSafeTxVectors.t.sol` asks a real Safe v1.4.1 on
   Monad for `getTransactionHash()` and `encodeTransactionData()`. Written to
   `proof/circles/safe-tx-vectors.json`. This is the authority; nothing recomputes it in Solidity.
2. **The official Safe protocol-kit** — `tools/circles/verify-vectors.mjs` re-derives every hash
   with `calculateSafeTransactionHash` / `preimageSafeTransactionHash`, and rebuilds the EIP-1271
   envelope with the official `buildSignatureBytes` rather than trusting the hand-rolled encoding.
   **18/18 checks agree.**
3. **Swift** — `ios/PrismTests/CircleSafeTxHashTests.swift`, against the same vectors.

Vectors cover varying recipient, amount, nonce, Safe address, chainId (10143 and 143) and a
zero-amount edge case. The Solidity test re-derives the committed file on every run and fails if it
has drifted; `WRITE_CIRCLE_VECTORS=1` regenerates.

**Result: 21 Swift tests pass, including `testSwiftSafeTxHashMatchesOnChainSafe`.** Swift's digest
equals the real Safe contract's digest for every vector.

These were executed, not deferred to macOS CI: the same source files were run under Swift 6.0.3 on
Linux via SwiftPM. The suite was also mutation-tested to prove it is not vacuous — corrupting one
nibble of the `SafeTx` typehash produces 13 failures, and weakening one Keccak round constant
produces 26.

---

## Phase 3 — execution and gas model

`contracts/test/circles/CircleRelayerModel.t.sol` — **4 tests, all passing.**

Circles uses Safe's **ordinary `execTransaction` path**. ERC-4337 is not enabled: the Safe4337Module
v0.3.0 *is* deployed on Monad (`0x75cf1146…`), but adopting it would add an EntryPoint, a bundler
and a paymaster to the trusted set in exchange for nothing the relayer does not already deliver.

- **Zero-MON members** — `test_CircleSettlesWithEveryMemberHoldingZeroMon` explicitly zeroes the
  balances of both owners *and* the Circle Safe, then settles a USDC payment. No member, and not
  the Safe, needs any MON. (Forked addresses can carry real testnet balances, so the zero-MON state
  is constructed rather than assumed.)
- **Any relayer works** — the same signed transaction executes when broadcast by an address Prism
  has never seen. Authority is in the signature, so the relayer is a courier.
- **The relayer cannot alter what was signed** — recipient, amount, asset target, operation, native
  value and calldata are each mutated after signing; each is rejected with `GS024`, the Circle's
  balance is unmoved, the nonce is unconsumed, and the honest transaction still executes afterwards.
- **The relayer cannot pay itself** — inflating `gasPrice` / `baseGas` / `gasToken` /
  `refundReceiver` after signing is rejected; those fields are inside the digest.

The nonce is deliberately absent from that list: `execTransaction` **takes no nonce argument**. The
Safe supplies its own and increments it on success, so a relayer cannot select one at all — a
stronger guarantee than rejecting a tampered value.

---

## What is deliberately NOT done

- **No Circle UI** — out of scope for this phase.
- **No custom multisig** — the Safe experiment succeeded, so the prohibition holds.
- **No spending limits** — Allowance Module v1.0.0 is released but deployed nowhere; the only
  Monad deployment is the vulnerable v0.1.1. `CIRCLE_LIMITS_ENABLED = false`, threshold-only. See
  `CIRCLES_DEPENDENCY_AUDIT.md`.
- **No ERC-4337**, no AUSD/earnAUSD, no change to Prism's USDC payment asset, and no modification
  to any existing personal Prism account.

## Open items before Circles ships

1. **Live testnet execution.** Everything above runs on a Monad testnet *fork*. No Circle Safe has
   been broadcast to live Monad, because this repository has no funded deployment key — the same
   constraint recorded throughout `proof/`.
2. **Monad mainnet contracts are unverified.** Safe lists the same addresses for chainId 143; they
   have not been code-verified here.
3. **Threshold guardrail — OPEN, founder decision.** A Circle's *spare* is
   `admins - threshold`: the number of admins it can lose and still move money. At spare = 0 (2-of-2,
   3-of-3), losing one phone freezes the funds **permanently**, because adding an owner, removing
   one, or lowering the threshold are each themselves Circle transactions requiring the very
   signature that was lost. There is no admin override and no support path. A Circle created at
   spare = 0 can never be repaired afterwards, which is why this has to be settled before Circle
   creation ships rather than bolted on later. Under discussion with the founders; tracked in
   `TODO.md`. Note that spare > 0 is necessary but not sufficient — two admin devices belonging to
   one person, or to one household, do not provide the independence the arithmetic assumes.
4. **Full recovery strategy — OPEN, backlog.** Social recovery, a Prism-held backup owner, and
   time-locked escape hatches are all viable on Safe and all deferred. Safe's own
   `addOwnerWithThreshold` / `removeOwner` / `swapOwner` already provide the mechanism, so this is a
   product-design question rather than a contract one. Tracked in `TODO.md`.
5. **Owner rotation for the P-256 path.** `PrismP256SafeOwner` holds an immutable key. Only relevant
   if the P-256 path is ever revived; not on the shipping path (see the DECIDED section above).
