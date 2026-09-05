# PAYMENT PROOF

**Status: BLOCKED on testnet. No supported stablecoin has moved on Monad by this codebase.**

There is no tx hash, no block, and no deployed router. The end-to-end "magical moment" — iPhone A →
Contacts → Tobi → $20 → Face ID → Mera sign → router → USDC → Monad — **has not been executed**.
Blockers and the unblock sequence: `TESTNET_DEPLOYMENT.md`.

## What is proven locally

The payment mechanism is proven against a signature-faithful USDC mock using Circle's EIP-712
domain, so a signature valid in the local test exercises the same ERC-3009 digest shape.

`contracts/test/PrismPaymentRouter.t.sol::testDirectPaymentSucceeds`:

| | Value |
|---|---|
| Contract | `PrismPaymentRouter` (local EVM, Foundry) |
| Token | `MockUSDC`, domain `USDC`/`2`, 6 decimals |
| Amount | `25_000000` (25 USDC) |
| Payer USDC before | `1_000_000000` |
| Payer USDC after | `975_000000` |
| Recipient USDC before | `0` |
| Recipient USDC after | `25_000000` |
| Event | `PaymentSettled(paymentId, payer, recipient, 25e6, requestId, resolutionHash)` asserted with `vm.expectEmit(true,true,true,true)` |
| Submitted by | `relayer` (`vm.prank`), not the payer |

The payer's two signatures are cross-bound: the USDC authorization the router submits takes its
`to`, `value`, and `nonce` from the envelope, so a relayer that rewrites recipient, amount, or
reference invalidates the envelope signature *and* USDC's own `ecrecover`. Mutation coverage:
`testModifiedAmountRejected`, `testModifiedRecipientRejected`, `testModifiedRequestIdRejected`,
`testWrongSignerRejected`, `testReplayRejected`, `testPaymentIdReuseRejected`,
`testExpiredPaymentRejected`, plus fuzz runs of
`testFuzz_directPayment` and `testFuzz_wrongSignerAlwaysRejected`.

`testDirectPaymentSucceeds` and `testClaimFundingSucceeds` prove the payment and pre-user claim paths
with USDC's `USDC` / `2` EIP-712 domain.

Backend orchestration is proven in `backend/test/infra.test.js` and `mutation-audit.test.js`:
prepare → dual signature verification → simulate → relay → receipt reconcile → Envio index check,
with the Alchemy provider and Envio consumer both asserted to have been exercised.

## What cannot be claimed

- No timing numbers. `authorization → submission`, `submission → confirmation`, and total payment
  time are instrumented (`signing_wait_ms`, `relay_submit_ms`, `chain_confirmation_ms`,
  `end_to_end_payment_ms`, `envio_index_ms` in `backend/src/lib/metrics.js`, readable at
  `GET /v1/metrics`) but have **never been measured against Monad**. Any latency figure would be
  fabricated.
- No independent readback. There is no receipt to re-read from Alchemy and no `PaymentSettled` for
  Envio to index.
- The Face ID / passkey / Contacts leg has never run on hardware — see `MERA_PROOF.md`.
