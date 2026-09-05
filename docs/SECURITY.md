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
token's on-chain `DOMAIN_SEPARATOR()` (`chain/eth.js#verifyAusdDomain`), failing closed on any
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
