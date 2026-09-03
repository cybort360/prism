# Mera Integration

Mera (`@category-labs/mera`) is the consumer account and signing layer. It derives a **standard
secp256k1 EVM account from a passkey** (WebAuthn PRF) — no seed phrase, no bundler, no MPC, no
backend custody. Prism is a native Swift app, so it runs the **official** Mera TypeScript library
through the smallest legitimate bridge rather than re-implementing derivation or signing.

## The bridge

```
Swift  ──MeraAccountService──▶  MeraAccountManager  ──▶  WKWebViewMeraBridge  ──▶  official @category-labs/mera
```

- `ios/MeraBridge/MeraAccountService.swift` — the narrow @MainActor protocol:
  `createAccount`, `restoreAccount`, `signTypedData`, `signMessage`, `createSession`, `revokeSession`.
- `ios/MeraBridge/WKWebViewMeraBridge.swift` — hosts the library in an offscreen WKWebView and
  message-passes a fixed command set. Passkey secrets and the derived root never leave the WebView
  and are never sent to the Prism backend; only public addresses and signatures cross into Swift.
- `ios/MeraBridge/MeraAccountManager.swift` — app-facing coordinator: owns the account and the
  scoped, expiring signing-session policy, and exposes hex signing helpers to `PrismAPI`.
- `ios/MeraBridge/web/` — the bundle source (`src/bridge.js`) and build (`npm run build` →
  `Prism/Resources/MeraWeb/mera-bridge.js`). See `ios/MeraBridge/web/BUILD.md`.

## Signing sessions

- Sessions are **scoped** (`payments` vs `identity`) and **always expire** (Mera's session zeroes
  its warm key on end), so routine payment signing needs no passkey sheet each time.
- **High-risk identity/account actions always re-authenticate** (`identity` scope). Payment sessions
  may be reused until expiry.
- The local PIN / Face ID gate is independent of and in addition to the Mera session.

## What Mera signs

| Action | Payload | Domain |
|---|---|---|
| Onboarding proof | personal_sign of `{action:"bind_account",account}` | EIP-191 |
| Identity mutation | personal_sign of the canonical action payload | EIP-191 |
| Request commit | personal_sign of the request signable | EIP-191 |
| Direct payment | EIP-712 `PaymentEnvelope` **and** AUSD `TransferWithAuthorization` | PrismPaymentRouter / Agora Dollar |
| Claim funding | EIP-712 AUSD `ReceiveWithAuthorization` | Agora Dollar |
| Claim collection | EIP-712 `ClaimIntent` | PrismClaimVault |

## Normal payment sequence

```
prepare (backend builds envelope + AUSD typed data)
  → PIN or Face ID (local approval gate)
  → Mera beginSession(.payments)
  → signTypedData(envelope) + signTypedData(ausd)
  → POST /v1/payments/submit (relayer pays MON, submits PrismPaymentRouter.settle)
  → poll GET /v1/payments/:id until a receipt reconciles
```

## Recovery

Because the account is deterministically derived from the passkey, signing in on a new device with
Face ID / Touch ID restores the **same** account — no seed phrase and nothing to rotate on-chain.
Passkeys sync via the platform account (iCloud Keychain); total passkey loss is handled by Mera's
recovery, never by the phone number. OTP proves alias control only and can never seize a bound
account.

## Simulator / testnet

The bridge injects a stable, Keychain-persisted **dev seed** on the simulator and signs statelessly
with viem's vetted secp256k1 (a real EVM account, just not passkey-derived) so the full flow is
exercisable without a physical authenticator. On device, real WebAuthn passkeys are used. See
`ios/MeraBridge/web/BUILD.md`.
