# CLAIM PROOF (send before signup)

**Status: BLOCKED on testnet. No claim has been funded or collected on Monad.**

The "David is not registered → send $20 anyway → iPhone B installs, verifies the matching phone,
creates a Mera account, sees '$20 waiting', claims" sequence **has not been executed**. It needs a
deployed vault, a funded relayer, test AUSD, and two physical iPhones — none available here. See
`TESTNET_DEPLOYMENT.md`.

## What is proven locally

`contracts/test/PrismClaimVault.t.sol` (12 tests) + `PrismFuzz.t.sol::testFuzz_claimLifecycle`
(10,000 runs) + `PrismVaultInvariant.t.sol` (256 runs / 128k calls).

### Funding — `testClaimFundingSucceeds`

Funded through AUSD `receiveWithAuthorization`, which requires `to == msg.sender`, so only the vault
can pull the money and it happens atomically with recording the claim — no orphaned deposits. The
ERC-3009 nonce must equal `fundingNonce(claimId, recipientReference, amount, sender)`, so the
sender's signature commits to exactly this claim and a relayer cannot repoint it
(`NonceBindingMismatch`). Sender holds MON = 0 throughout; the relayer pays gas.

### Collection — `testCorrectClaimantSucceeds`

| | Value |
|---|---|
| Recipient AUSD before | `0` |
| Recipient AUSD after | `amount` |
| Requires | backend `ClaimEligibility` signature **and** the recipient's own Mera `ClaimIntent` |
| Submitted by | `relayer` (`vm.prank`) |

Rejections: `testWrongClaimantFails`, `testForgedEligibilityFails`, `testExpiredEligibilityFails`,
`testDoubleClaimFails` (MUT-10), `testClaimAfterRefundFails` (MUT-11).

### Privacy

`testRandomRecipientReferenceHasNoPhoneCorrelation`, plus
`contracts/test/PrismPrivacy.t.sol::testClaimLifecycleEmitsNoPhoneDerivedValue`, which scans the
`fundClaim` and `claim` calldata, all events, and all written vault storage for the phone ASCII,
`keccak256(phone)`, `sha256(phone)`, and the digits as an integer. `claimId` and
`recipientReference` are both `randomHex(32)` — 256-bit random, never phone-derived
(`ClaimService.createPending`).

### Invariants (256 runs / 128k calls)

`invariant_balanceEqualsOutstanding`, `invariant_fundsConserved`, `invariant_noFundedRegression`.

## Known structural risk

`claim()` releases funds on one `claimAuthorizer` signature plus the recipient's intent. The intent
proves who is asking, not who is entitled — entitlement is the authorizer's word alone, and
`aliasVersion` is signed but never compared against on-chain state. Compromise of that key drains
every funded claim. The KMS/HSM requirement is load-bearing. See `SECURITY_PROOF.md`.
