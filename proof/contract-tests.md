# Prism contract tests

`cd contracts && forge test --offline` — **31 tests, 0 failures** (25 unit/privacy, 3 fuzz, 3 invariant).

Solc 0.8.28, via-IR, optimizer 100k runs. USDC is exercised through `MockUSDC`, a faithful
reproduction of Circle USDC's ERC-20 + ERC-3009 surface with the EIP-712 domain
(`USDC` / `2`, 6 decimals), so a signature valid for the live token validates identically
here.

## Suites

| Suite | Coverage |
|---|---|
| `PrismPaymentRouter.t.sol` | direct USDC payment via the Prism `PaymentEnvelope` + ERC-3009 |
| `PrismClaimVault.t.sol` | send-before-signup: gasless funding, dual-signature claim, refund |
| `PrismFuzz.t.sol` | fuzz over amounts, expiry, nonces, signatures, and the full claim lifecycle |
| `PrismVaultInvariant.t.sol` | stateful invariants (256 runs × 500 calls = 128,000 calls, 0 reverts) |

## Direct payment (`PrismPaymentRouterTest`)

| Test | Proves |
|---|---|
| `testDirectPaymentSucceeds` | envelope + ERC-3009 settle, recipient credited exactly, `PaymentSettled` emitted |
| `testPayerOwnsZeroMon` | payer holds 0 MON; relayer submits; payment still settles |
| `testResolutionHashIsOpaqueMetadata` | `resolutionHash`/`requestId` emitted verbatim as opaque values |
| `testFuzz_directPayment` (256 runs) | arbitrary amount/expiry/nonce/requestId settles with exact balance delta |

## Fuzz

| Test | Range |
|---|---|
| `testFuzz_directPayment` | amount ∈ [1, 1e12], validity ∈ [1s, 3650d], random nonce/requestId |
| `testFuzz_wrongSignerAlwaysRejected` | any non-payer key → `BadEnvelopeSignature` |
| `testFuzz_claimLifecycle` | amount ∈ [1, 1e12], ttl ∈ [1h, 365d] fund→claim, vault fully drained |

## Invariants (128,000 calls each, 0 reverts)

| Invariant | Guarantee |
|---|---|
| `invariant_balanceEqualsOutstanding` | vault USDC balance == Σ funded-claim amounts (liabilities ≤ balance, and no leakage) |
| `invariant_fundsConserved` | outstanding + distributed == total ever funded (no USDC created/destroyed) |
| `invariant_noFundedRegression` | Claimed/Refunded claims never return to Funded |

Full negative-path / security mapping is in `security-tests.md`.
