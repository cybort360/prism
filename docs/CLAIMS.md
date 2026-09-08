# Claims (Send before signup)

The one rule: **money sent to someone not yet on Prism is real, protected, clearly intended, and
recoverable — without ever putting the recipient's phone on-chain.** There is exactly one escrow
system: `PrismClaimVault`. Consumer copy never says "escrow" or "vault".

## Lifecycle

```
created ─▶ funding_submitted ─▶ funded ─┬─▶ claim_submitted ─▶ claimed      (delivered)
                                        └─▶ (expiry) ─▶ refund_submitted ─▶ refunded  (returned)
```

- **Fund** — the sender signs an ERC-3009 `receiveWithAuthorization`; a relayer funds the vault
  gaslessly. Money is now *protected*, not "sent".
- **Claim** — requires BOTH the backend authorizer's eligibility signature AND the recipient's own
  Mera-account `ClaimIntent` (dual signature). An alias or OTP alone can never release funds.
- **Refund** — only after expiry, always back to the **original sender** (contract-enforced
  destination). Permissionless to trigger; the destination can't be chosen by the caller.

Exactly one terminal state: `claimed` **xor** `refunded`. The expiry boundary is a clean seam (claim
allowed while `now <= expiry`, refund only when `now > expiry`) — proven in
`PrismClaimVault.t.sol` (`testClaimAtExpiryInstantWinsAndBlocksRefund`,
`testClaimStrictlyAfterExpiryLosesToRefund`).

## Surfaces

- **Sender pre-fund** (`UnregisteredSendView`) — states the recipient isn't on Prism, the 7-day
  protection window, and that unclaimed money can be returned.
- **Funding success** — "Protected for David / Waiting to be claimed / Expires <date>" with **Remind**;
  never a misleading "Sent".
- **Sender claim detail** (`ClaimDetailView`) — timeline (created, funds protected, waiting,
  delivered), Remind, and an explicit **Return** flow once expired.
- **Recipient** (`ClaimMoneyView`) — "from <sender public handle>", "already protected for you",
  "Protected on Monad", **Claim**.

## Privacy

- The recipient's phone is **never** on-chain: the claim references are random
  (`claimId`, `recipientReference`), and the recipient's friendly name lives only on the sender's
  device (`ClaimRecipientStore`), never sent to the backend.
- The reminder invitation carries only the opaque random `claimId` — no phone, wallet, or eligibility
  material.
- Enforced by `phone-leak-audit.test.js` and `PrismClaimVault.t.sol`
  (`testRandomRecipientReferenceHasNoPhoneCorrelation`).

## Failure copy (recipient)

Precise, honest, with recovery only when it helps: wrong identity, already received, already returned,
expired, and network ("your money remains protected"). See `ClaimFailure.classify`.

## Proof

A claim projects to the same canonical model and Payment Proof, correlating `claimId` across the
operation, the claim record and the proof (`proof-correlation.test.js`). See
[PAYMENT_PROOF.md](PAYMENT_PROOF.md).
