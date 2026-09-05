# Prism security tests

Every required negative/security property maps to a passing test. `cd contracts && forge test -vvv`.

## Direct payment integrity

| Property | Test | Mechanism |
|---|---|---|
| Wrong signer rejected | `testWrongSignerRejected`, `testFuzz_wrongSignerAlwaysRejected` | envelope `ecrecover != payer` → `BadEnvelopeSignature` |
| Modified amount rejected | `testModifiedAmountRejected` | amount is in the signed envelope AND the ERC-3009 auth |
| Modified recipient rejected | `testModifiedRecipientRejected` | recipient is in the signed envelope AND the ERC-3009 auth |
| Modified requestId rejected | `testModifiedRequestIdRejected` | requestId bound in the envelope digest |
| Expired payment rejected | `testExpiredPaymentRejected` | `block.timestamp >= validBefore` → `Expired` |
| Replay rejected | `testReplayRejected` | `paymentUsed[paymentId]` + USDC `authorizationState` |
| paymentId reuse rejected | `testPaymentIdReuseRejected` | fresh nonce, same paymentId → `PaymentAlreadyUsed` |
| No phone-derived value on-chain | `testResolutionHashIsOpaqueMetadata` | resolutionHash/requestId are opaque Prism refs, emitted verbatim |

The relayer can never redirect or resize a payment: recipient and amount are bound into **both** the
Prism envelope signature and USDC's own ERC-3009 signature. Tampering either breaks a signature.

## Send-before-signup (claims)

| Property | Test | Mechanism |
|---|---|---|
| Gasless claim funding succeeds | `testClaimFundingSucceeds`, `testFuzz_claimLifecycle` | ERC-3009 `receiveWithAuthorization` (sender needs 0 MON) |
| No phone correlation in references | `testRandomRecipientReferenceHasNoPhoneCorrelation` | random `claimId`/`recipientReference`; vault derives nothing |
| Correct claimant succeeds | `testCorrectClaimantSucceeds` | valid backend eligibility + recipient Mera intent |
| Wrong claimant fails | `testWrongClaimantFails` | recipient intent `ecrecover != recipient` → `BadRecipientIntent` |
| Forged eligibility fails | `testForgedEligibilityFails` | eligibility `ecrecover != claimAuthorizer` → `BadEligibility` |
| Expired eligibility fails | `testExpiredEligibilityFails` | `block.timestamp > eligibilityExpiry` → `EligibilityExpired` |
| Double claim fails | `testDoubleClaimFails` | status leaves `Funded` → `NotFunded` |
| Refund before expiry fails | `testRefundBeforeExpiryFails` | `block.timestamp <= expiry` → `NotYetExpired` |
| Refund after expiry succeeds | `testRefundAfterExpirySucceeds` | funds return to original sender |
| Claim after refund fails | `testClaimAfterRefundFails` | status `Refunded` → `NotFunded` |
| Double refund fails | `testDoubleRefundFails` | status `Refunded` → `NotFunded` |
| Refund destination cannot change | `testRefundDestinationCannotBeChanged` | refund pays stored `sender`; caller supplies no address |

Claiming requires BOTH an isolated backend eligibility signature (designed for KMS/HSM; the key is
never hardcoded — set at deploy, rotatable via `setClaimAuthorizer`) AND the recipient's own Mera
account signature.

## Fund-safety invariants (128,000 randomized calls, 0 reverts)

| Invariant | Test |
|---|---|
| vault liabilities ≤ balance (exact equality) | `invariant_balanceEqualsOutstanding` |
| claim funds can never disappear / be conjured | `invariant_fundsConserved` |
| completed/refunded claims cannot return to funded | `invariant_noFundedRegression` |

## Signature hygiene

- EIP-2 low-s enforced and `v ∈ {27,28}` in `PrismEIP712.recover`; malformed signatures recover to
  `address(0)` and fail closed.
- ERC-3009 authorizations are additionally tracked by USDC's own `authorizationState`, giving
  defense-in-depth replay protection beyond the router/vault nonce maps.
