# Security Model (v1.1)

## Security invariants

These hold across the whole system and are the acceptance bar for the build:

- phone number = **private** reachability alias (never a key, never an on-chain identifier);
- @handle = optional **public** reachability alias;
- OTP proves **alias control only**;
- OTP can **never** seize an already-funded account;
- the **Mera passkey account is the financial signing authority**;
- Prism Identity is a lightweight, persistent product identity — it holds no key;
- there is **no public phone → wallet registry** and **no public SHA(phone) → wallet map**;
- the backend is **not** the canonical money ledger; Monad/USDC state is canonical for money;
- **submitted ≠ completed**;
- stale/changed recipient mappings **fail closed**.

## Trust boundaries

### Device

- Runs the official Mera library (via the WKWebView bridge) to create/restore the passkey-derived
  account and to sign. The passkey and its derived secret never leave the device and are never sent
  to the Prism backend.
- Applies the local human approval gate (Face ID via `LAContext`, or a local PIN) **before** any
  signing call.
- Verifies that a prepared payment exactly matches the user's visible intent before signing.
- Remembers previously trusted recipient identity mappings and warns on change.

### Mera signing sessions

- Sessions are **scoped** (`payments` vs `identity`) and **always expire** (a warm key is zeroed on
  `end()`), so routine payment signing need not present a passkey sheet every time.
- **High-risk identity/account actions always re-authenticate** (`identity` scope forces a fresh
  session). Payment sessions may be reused until they expire.
- The local PIN / Face ID gate is independent of, and in addition to, the Mera session.

### Resolver / backend

The backend may know an individual phone number during explicit OTP and selected-contact lookup. It
is never the money ledger or a spending authority.

- no raw phone in logs; HMAC index rather than `SHA256(phone)`; encrypted phone persistence;
- authenticated, rate-limited lookup; short-lived, requester-bound, signed resolutions; versioned
  aliases with revocation;
- the **relayer** key only pays MON and cannot alter a payment's recipient/amount (nonce binding);
- the **claim authorizer** is an isolated secp256k1 key (KMS/HSM in production) restricted to the
  exact EIP-712 claim schema; no backend endpoint can sign with a user's account key.

### Blockchain

Monad is canonical for balances and settlement. Public state reveals accounts, USDC transfers and
balances; Prism does not claim these payments are private.

## Recipient and amount integrity

Direct payments and claim funding both rely on the **binding nonce**: the payer's ERC-3009
authorization commits to a 32-byte nonce equal to `keccak256(...recipient, amount, reference...)`.
The router/vault recompute that nonce from their arguments; if a relayer rewrites the recipient, the
amount, or the reference, the nonce no longer matches the signed value and USDC's own `ecrecover`
check reverts. No smart-contract wallet or EIP-1271 is required.

## OTP / SIM swap

A successful SMS OTP is evidence of current phone possession, not authority over a funded account. A
phone rebind updates reachability only; the funded account is bound to the Mera passkey. OTP alone
can never repoint a bound account — proven by `backend/test/identity.test.js` and
`security-boundaries.test.js`.

## Account recovery (replaces key rotation)

Because the account is deterministically derived from the passkey, signing in on a new device with
Face ID / Touch ID restores the **same** account. There is no on-chain key rotation and no seed
phrase. Passkeys sync via the platform account (iCloud Keychain); total passkey loss is handled by
Mera's recovery, never by the phone number.

## Resolution compromise

If the resolver changes a previously trusted contact from identity A to identity B, the app shows an
identity-change warning instead of silently using B. Resolutions expire; stale/revoked alias
versions fail closed.

## Verify, don't trust (USDC)

Before relaying, the backend recomputes USDC's EIP-712 domain separator and compares it to the
token's on-chain `DOMAIN_SEPARATOR()` (`chain/eth.js#verifyUsdcDomain`), failing closed on any
drift in address, name, version, or chainId.

## App integrity hardening

Apple App Attest can be layered onto resolver and claim-eligibility requests so the backend accepts
assertions only from legitimate app instances. It is optional for the hackathon proof.

## Required negative tests

- raw phone in calldata/event/storage: fail review
- plain SHA/SHA-256 phone index: fail review
- unauthenticated bulk resolution: rate-limit/deny
- OTP-only funded-account takeover: reject
- stale alias resolution: reject
- recipient mutation after signature: reject (nonce binding)
- amount mutation after signature: reject (nonce binding)
- ERC-3009 authorization replay: reject (USDC authorization state)
- double claim: reject
- claim after refund: reject
- refund before expiry: reject
- silent identity change: reject

---

# Prism Circles — shared accounts

A Circle is a shared USDC account. Its money lives in a Safe Smart Account on Monad; Prism holds the
Circle's *name*, who was invited, and what a proposal was for. Everything below follows from that
split, and the audit that checks it is `backend/test/circles-hostile-audit.test.js` (CIR-001…CIR-017),
`contracts/test/circles/CircleSafeOwnerCompat.t.sol` (a Monad fork, real Safe v1.4.1) and
`contracts/test/AllowanceModuleCompat.t.sol` (Safe's canonical Allowance Module runtime).

## Trust boundaries

| Question | Decided by | Prism's role |
|---|---|---|
| Who may move this money? | the Safe's owner set, on Monad | reads it; cannot change it |
| How many must agree? | the Safe's threshold | reads it; cannot change it |
| Did this payment happen? | the Monad receipt + the USDC `Transfer` log | observes it; cannot assert it |
| How much is in the Circle? | `USDC.balanceOf(safe)` | reads it; keeps no balance |
| May this member spend alone? | the Allowance Module, when deployed and enabled | reads it; cannot grant it |
| Who is this recipient? | the Protected Alias Resolver | resolves, and blocks a changed identity |
| What was this payment for? | Prism | owns it |

## Security assumptions

1. **The Safe is the authority, not Prism.** Prism can propose and relay. It cannot approve, cannot
   change an owner set or a threshold, and cannot move a Circle's money. A compromised backend can
   annoy a Circle; it cannot spend from one. Proven by CIR-009 (a backend that rewrites its own row
   to claim the threshold is met still cannot execute) and by the hostile-relayer test.
2. **Signatures are re-verified against the live owner set on every read.** An approval is never a
   number Prism increments. An admin removed on-chain stops counting with nobody telling the backend
   (CIR-008).
3. **The device re-derives what it signs.** The approval payload carries the ten Safe transaction
   fields plus the Safe and chain; the phone recomputes the digest and refuses to sign if it
   disagrees with the one it was handed (CIR-010, `CircleApprovalWireTests`).
4. **One asset, one call shape.** A Circle moves USDC and nothing else, and the only Safe calls Prism
   will build are the eight Circle intents. No route accepts a target, calldata, an operation type or
   a token (`circles-route-audit.test.js`).
5. **Members hold no MON.** Every on-chain write is sent by the relayer wallet — there is exactly one
   wallet in the backend and it is the relayer's. Members sign typed data; they never sign a
   transaction.
6. **Gas sponsorship is a liveness dependency, not a custody one.** If the relayer stops, nothing is
   lost: the Circle's owners can build, sign and execute a Safe transaction with any Safe client.
7. **The Safe Transaction Service is coordination, never evidence.** It carries proposals and
   collects signatures. Prism re-verifies every confirmation it returns, and the Payment Proof lists
   it with a `coordination` status so no reader mistakes it for proof that something happened.
8. **A phone number is not authority.** Being reachable at a number that used to reach an admin
   confers nothing: the owner set is unchanged, and the alias resolves to a different PrismIdentity,
   which is visibly blocked rather than silently honoured.

## Known limitations

- **No live Circle on Monad.** Every Circle claim is proven against the in-memory Safe in
  `circles-harness.js` (which enforces Safe's real `execTransaction` rules) and against real Safe
  bytecode on a Monad fork. No Circle has been deployed and no Circle payment has been broadcast to a
  public chain — that needs a funded key. See `forge/PROOF_LEDGER.md`.
- **Spending limits are OFF.** Safe's Allowance Module v1.0.0 is not deployed on Monad; the runtime
  gate refuses to enable limits and Circles falls back to threshold-only. The module's own security
  properties are proven against its canonical bytecode, not against a Monad deployment.
- **Safe Transaction Service runs local-only here.** The coordination path is exercised in its absent
  configuration; a hosted service has not been integrated.
- **A Circle's transfers are public.** Amounts, the Safe address and recipient accounts are on-chain
  and linkable, exactly as any USDC transfer is. Prism claims identifier privacy — no phone number or
  phone-derived value on-chain — not payment privacy.
- **A threshold that cannot be met freezes the money.** If admins lose their devices past the point
  where the threshold can be reached, Prism cannot help: that is the same property that stops Prism
  from spending a Circle's money. The creation flow states this trade-off and requires the creator to
  acknowledge it.
- **Prism's own liveness.** With the backend down, a Circle's funds remain fully under its owners'
  control, but the app's proposal, approval-collection and receipt surfaces are unavailable.
- **The iOS app has not been compiled on macOS.** The model layer parses, typechecks and its XCTest
  suites run on Linux (`make test-ios-linux`); the SwiftUI views and Combine coordinators are
  syntax-checked only.
