# Prism Threat Model (v1.1)

Scope: the consumer USDC payment path on Monad — Mera passkey account, protected alias resolver,
Prism payment router, and claim vault. Notation: **A** = attacker.

## Assets

| Asset | Where it lives | Protected by |
|---|---|---|
| Passkey / derived account secret | Device passkey (Secure Enclave / platform authenticator) | WebAuthn; never leaves device; never sent to backend |
| USDC funds | Monad / USDC contract | Mera account signature; ERC-3009 authorization state |
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
| T1 | Relayer redirects a payment to its own address | ERC-3009 nonce binds `keccak256(from,to,value,ref)`; tamper → USDC `ecrecover` reverts | `PrismPaymentRouter.t.sol::testRelayerCannotRedirectRecipient` |
| T2 | Relayer inflates the amount | Amount bound in the same nonce | `...testRelayerCannotChangeAmount` |
| T3 | Replay of a captured authorization | USDC `authorizationState` marks the nonce used; `validBefore` expiry | `...testReplayFailsClosed`, `...testExpiredAuthorizationFailsClosed` |
| T4 | SIM swap / OTP to seize a funded account | Account bound to the passkey; OTP updates reachability only | `identity.test.js`, `security-boundaries.test.js` |
| T5 | Backend rewrites the recipient after the user approves | Recipient bound in-signature (nonce); backend cannot forge a Mera signature | T1 + signature verification in `paymentService.submit` |
| T6 | Backend leak reverses phone → account | HMAC index (not SHA(phone)), AES-GCM at rest, no raw phone in logs | `resolver.test.js` |
| T7 | Bulk phone enumeration | Auth required + per-user/per-IP rate limits + short-lived signed resolutions | `resolverService.js`, `rateLimit.js` |
| T8 | Stale/rotated recipient silently paid | Alias-version check + identity-change warning; resolutions expire | `security-boundaries.test.js` (version invalidation) |
| T9 | Double-spend of a claim | Vault single-use authorization + status machine | `PrismClaimVault.t.sol::testFundAndCollectOnce` |
| T10 | Forged claim authorization | Vault verifies `ecrecover == claimAuthorizer` | `...testForgedAuthorizerRejected` |
| T11 | Refund griefing before expiry / claim after refund | Refund only after expiry; state transitions are one-way | `...testRefundOnlyAfterExpiry` |
| T12 | Claim funding repointed to another claim | Funding nonce binds `keccak256(claimId,ref,amount,from)` | `...testFundingNonceBindsClaim` |
| T13 | USDC address / domain drift or spoof | Runtime `DOMAIN_SEPARATOR()` re-check; deploy scripts take explicit USDC input | `chain/eth.js#verifyUsdcDomain` |
| T14 | "Submitted" shown as success while the tx fails | Terminal UI state comes only from a reconciled receipt | `paymentService.reconcile`, coordinator loop |
| T15 | Phone-derived value leaks on-chain | Random `claimId`/`recipientReference`; no phone data in any event | `security-boundaries.test.js`, contract review |

## Residual risks (documented, not hidden)

- The resolver is **not** blind to the phone number during a lookup (v1 uses HMAC + encryption +
  rate limits). OPRF/enclave/PSI is a production seam behind the same protocol.
- The self-funded relayer is a liveness/cost dependency; production uses Alchemy Gas Manager.
- The claim authorizer is a trusted oracle; production requires KMS/HSM and strict schema policy.
- On-chain USDC transfers are public; Prism does not claim payment privacy.
- Total passkey loss depends on Mera/platform recovery, not on Prism.

## Circles — hostile authority matrix

Attacks are pushed to the layer that actually decides. Where the Safe decides, the attack is
submitted to the Safe with CircleService bypassed; where Prism decides, its own database row is
edited first, to model a compromised backend rather than a polite one.

| ID | Attack | Result | Where it is proven |
|---|---|---|---|
| CIR-001 | A non-admin signs a payment | Refused by Prism, ignored in the count even if the row is forged, rejected by the Safe | `circles-hostile-audit.test.js`; fork: `test_E_WrongP256Signer_Fails` |
| CIR-002 | One signature on a 2-of-3 Circle | Cannot execute; the Safe answers GS020 | same; fork: `test_D_TwoOfTwo_RejectsASingleApproval` |
| CIR-003 | Recipient changed after the first approval | Approvals void; Safe rejects the altered transaction | same; fork: `test_E_ModifiedRecipient_Fails` |
| CIR-004 | Amount changed after the first approval | Approvals void; Safe rejects | same; fork: `test_E_ModifiedAmount_Fails` |
| CIR-005 | USDC target changed | Binding check refuses; Safe rejects | same; fork: `test_E_ModifiedTokenTarget_Fails` |
| CIR-006 | Completed Safe transaction replayed | Re-execute reconciles, never re-broadcasts; the Safe's nonce is spent | same; fork: `test_E_ReplayOfExecutedTransaction_Fails` |
| CIR-007 | Stale Safe nonce | Refused as EXPIRED; Safe rejects | same; fork: `test_E_WrongSafeNonce_Fails` |
| CIR-008 | A removed admin's approval on a pending payment | Stops counting by itself; authority re-read before every send; the Circle is not stuck | same |
| CIR-009 | Backend claims the threshold is met; the Safe disagrees | Chain wins — counts recomputed from verified signatures, execution refused | same |
| CIR-010 | Backend alters the safeTxHash after Face ID | The payload contradicts itself; the device refuses to sign | `CircleApprovalWireTests.testADigestThatDoesNotMatchTheFieldsIsRefused` |
| CIR-011 | Old, vulnerable Allowance Module | Startup and runtime gates fail closed; limits unavailable | `circles-hostile-audit.test.js`, `tools/circles/verify-allowance-module.mjs` |
| CIR-012 | $101 spend against $100 available | Refused, cumulative, and routed to the Circle for approval | same; module: `testSpendingOverTheLimitFails` |
| CIR-013 | Delegate authorization replayed | Refused — the module's per-delegate nonce is spent | same; module: `testTheSameTransferSignatureCannotBeReused` |
| CIR-014 | Revoked delegate spends (including an in-flight signature) | Refused at prepare, at submit, and by the module | same; module: `testARemovedDelegateCannotSpend` |
| CIR-015 | Delegate tries another token | No token parameter exists on the limit surface | same; module: `testWrongTokenFails` |
| CIR-016 | Delegate tries owner management | Not an expressible intent; the module cannot make a Safe call | same; module: `testADelegateCannotChangeTheOwnerSet` |
| CIR-017 | Delegate tries an arbitrary approval | Same | same; module: `testADelegateCannotGrantAnUnlimitedTokenApproval` |

Membership and continuity: an invitation is single-use and expires; a reassigned phone alias gains no
authority in an existing Circle; changing your own number preserves your identity and your authority;
removing an ordinary member is immediate, and removing an admin is refused in Prism because only the
Safe can do it.

Outages: with the Safe Transaction Service down, funds are untouched and the owners' recovery path is
unaffected. With Prism entirely gone, the owners still move their own money.
