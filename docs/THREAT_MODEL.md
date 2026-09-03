# Prism Threat Model (v1.1)

Scope: the consumer AUSD payment path on Monad — Mera passkey account, protected alias resolver,
Prism payment router, and claim vault. Notation: **A** = attacker.

## Assets

| Asset | Where it lives | Protected by |
|---|---|---|
| Passkey / derived account secret | Device passkey (Secure Enclave / platform authenticator) | WebAuthn; never leaves device; never sent to backend |
| AUSD funds | Monad / AUSD contract | Mera account signature; ERC-3009 authorization state |
| Phone ↔ account binding | Backend (encrypted + HMAC index) | AES-GCM, HMAC pepper, auth + rate limits |
| Alias reachability | Prism Identity | Alias-version + account-signature-gated mutations |
| Claim escrow | PrismClaimVault | secp256k1 claim authorizer, deadline, single-use |

## Actors

- Curious/greedy **relayer** (submits transactions, pays MON).
- **Backend compromise** (read/modify backend state and logs).
- **Alias attacker** (controls a phone/SIM, or performs a SIM swap).
- **Network/MITM** between app and backend.
- **On-chain observer** (reads all Monad state).

## Threats and mitigations

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | Relayer redirects a payment to its own address | ERC-3009 nonce binds `keccak256(from,to,value,ref)`; tamper → AUSD `ecrecover` reverts | `PrismPaymentRouter.t.sol::testRelayerCannotRedirectRecipient` |
| T2 | Relayer inflates the amount | Amount bound in the same nonce | `...testRelayerCannotChangeAmount` |
| T3 | Replay of a captured authorization | AUSD `authorizationState` marks the nonce used; `validBefore` expiry | `...testReplayFailsClosed`, `...testExpiredAuthorizationFailsClosed` |
| T4 | SIM swap / OTP to seize a funded account | Account bound to the passkey; OTP updates reachability only | `identity.test.js`, `security-boundaries.test.js` |
| T5 | Backend rewrites the recipient after the user approves | Recipient bound in-signature (nonce); backend cannot forge a Mera signature | T1 + signature verification in `paymentService.submit` |
| T6 | Backend leak reverses phone → account | HMAC index (not SHA(phone)), AES-GCM at rest, no raw phone in logs | `resolver.test.js` |
| T7 | Bulk phone enumeration | Auth required + per-user/per-IP rate limits + short-lived signed resolutions | `resolverService.js`, `rateLimit.js` |
| T8 | Stale/rotated recipient silently paid | Alias-version check + identity-change warning; resolutions expire | `security-boundaries.test.js` (version invalidation) |
| T9 | Double-spend of a claim | Vault single-use authorization + status machine | `PrismClaimVault.t.sol::testFundAndCollectOnce` |
| T10 | Forged claim authorization | Vault verifies `ecrecover == claimAuthorizer` | `...testForgedAuthorizerRejected` |
| T11 | Refund griefing before expiry / claim after refund | Refund only after expiry; state transitions are one-way | `...testRefundOnlyAfterExpiry` |
| T12 | Claim funding repointed to another claim | Funding nonce binds `keccak256(claimId,ref,amount,from)` | `...testFundingNonceBindsClaim` |
| T13 | AUSD address / domain drift or spoof | Runtime `DOMAIN_SEPARATOR()` re-check; deploy scripts take explicit AUSD input | `chain/eth.js#verifyAusdDomain` |
| T14 | "Submitted" shown as success while the tx fails | Terminal UI state comes only from a reconciled receipt | `paymentService.reconcile`, coordinator loop |
| T15 | Phone-derived value leaks on-chain | Random `claimId`/`recipientReference`; no phone data in any event | `security-boundaries.test.js`, contract review |

## Residual risks (documented, not hidden)

- The resolver is **not** blind to the phone number during a lookup (v1 uses HMAC + encryption +
  rate limits). OPRF/enclave/PSI is a production seam behind the same protocol.
- The self-funded relayer is a liveness/cost dependency; production uses Alchemy Gas Manager.
- The claim authorizer is a trusted oracle; production requires KMS/HSM and strict schema policy.
- On-chain AUSD transfers are public; Prism does not claim payment privacy.
- Total passkey loss depends on Mera/platform recovery, not on Prism.
