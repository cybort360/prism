# FORGE Proof Plan (v1.1)

Each proof has a reproducible command, an inspectable artifact, a failure branch, and an independent
readback. Contract proofs run under `cd contracts && forge test`.

| ID | Claim | Positive proof | Negative / ablation proof |
|---|---|---|---|
| P0 | USDC address/domain are the real ones | `chain/eth.js#verifyUsdcDomain` matches on-chain `DOMAIN_SEPARATOR()` | mutate name/version/address → mismatch, relaying blocked |
| P1 | Mera account controls funds | payer's Mera secp256k1 signature authorizes the USDC pull | `MockUSDC` rejects any signer ≠ payer |
| P2 | Zero-MON UX | `testGaslessPaymentWithZeroMon`: payer MON balance 0, relayer submits, recipient credited | relayer omitted → the user path cannot self-fund gas |
| P3 | No phone on-chain | random `claimId`/`recipientReference`; scan events/storage for E.164 / phone digest | fixture containing a phone is detected by tests |
| P4 | Contact payment integrity | `testGaslessPaymentWithZeroMon` credits the bound recipient | `testRelayerCannotRedirectRecipient` / `testRelayerCannotChangeAmount` revert |
| P5 | Replay resistance | first authorization settles | `testReplayFailsClosed` (USDC authorization state); `testExpiredAuthorizationFailsClosed` |
| P6 | Identity-change safety | repeated same mapping sends normally | changed identity/alias-version blocks send until review (`security-boundaries.test.js`) |
| P7 | Pre-user claim | `testFundAndCollectOnce`: fund via ERC-3009, collect once into the Mera account | `testForgedAuthorizerRejected`, double-claim reverts, `testFundingNonceBindsClaim` |
| P8 | Refund | `testRefundOnlyAfterExpiry`: expired funds return to sender | premature refund reverts; claim-after-refund reverts |
| P9 | Request linkage | `PrismPayment(paymentRef,...)` binds a payment to its request; backend marks PAID on receipt | payment for another request does not close it (`request.test.js`) |
| P10 | Transaction truth | app reaches Completed only after `reconcile` sees a receipt | submitted-but-unreceipted stays `settling`, never `sent` |
| P11 | Canonical balance | iOS amount equals an independent USDC `balanceOf` read | backend disagreement is corrected by the chain read |

## Commands

```bash
cd contracts && forge test -vvv          # P1–P8 (router + vault + MockUSDC)
cd backend  && node --test test/*.test.js # P0, P3, P6, P9 boundaries
cd ios      && xcodegen generate && xcodebuild ... test  # app compiles + Money proofs
```

## Judge sequence

1. Fresh iPhone creates a Mera passkey account with Face ID — no seed phrase shown.
2. Prism shows no wallet address / gas / MON in the send flow.
3. Contacts -> Tobi -> $20 -> Face ID. Payer holds USDC, 0 MON.
4. Show sender MON = 0 and before/after USDC balances via an independent RPC read.
5. Replay the same signed authorization → rejected by USDC authorization state.
6. Send $10 to David, who is not registered → funds escrow in the claim vault.
7. Register David with the same phone alias → he collects $10 into his Mera account (no MON).
8. Create a second unclaimed fixture, expire it, refund to the sender.
9. Change a contact's alias mapping → Prism shows the identity-change warning.
10. Open the explorer / independent RPC receipt and the Envio-indexed `PrismPayment` event.
