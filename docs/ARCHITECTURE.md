# Prism v1.1 Architecture

## Product surface

The consumer sees:

`Contacts / @handle / QR / payment link -> amount -> Face ID or PIN -> sent`

No "gas", "MON", "wallet", "seed phrase", "network", or hexadecimal address appears in the normal
flow. The only address shown anywhere is the user's own deposit address on the Add-money screen,
which is unavoidable for receiving funds.

## Pipeline

```text
phone / @handle / QR / payment link
            |
            v
  PRISM IDENTITY + PROTECTED ALIAS RESOLVER      (lightweight product identity; no public phone->wallet map)
            |
            v
  MERA PASSKEY-DERIVED ACCOUNT                    (secp256k1 EOA from a passkey; the signing authority)
            |
            v
  AUSD / USDC                                     (ERC-3009 gasless authorization)
            |
            v
  PRISM PAYMENT ROUTER / CLAIM VAULT              (relayer-submitted; recipient/amount bound in-signature)
            |
            v
  MONAD                                           (canonical settlement)
```

Mera is the **single** consumer account and signing layer. The earlier custom
Secure-Enclave-P256 / ERC-4337 `PrismAccount` path has been removed from the production
architecture and preserved for reference under `archive/` (`erc4337-p256/`,
`ios-secure-enclave-p256/`). The two signing systems never run side by side.

## Why Mera

Apple has no first-party stablecoin account. Mera derives a **standard secp256k1 EVM account** from
a passkey (WebAuthn PRF), so:

- account creation is a Face ID / Touch ID prompt — no seed phrase, no backend custody;
- the same passkey reproduces the **same** account on a new device, so "recovery" is just signing in
  again — there is nothing to rotate on-chain;
- the account signs ordinary ECDSA, which is exactly what AUSD's ERC-3009 path verifies. No ERC-4337
  account, bundler, or paymaster is needed. USDC exposes the same ERC-3009 signing path.

Because Mera has no pure-Swift API, Prism runs the **official** `@category-labs/mera` TypeScript
library inside a tiny offscreen WKWebView and exposes only a narrow Swift protocol
(`MeraAccountService`: `createAccount`, `restoreAccount`, `signTypedData`, `signMessage`,
`createSession`, `revokeSession`). Passkey secrets and the derived root never leave the WebView and
are never sent to the Prism backend. See `ios/MeraBridge/`.

## Why AUSD, USDC, and ERC-3009

AUSD and USDC both expose ERC-3009 on Monad. A holder signs an EIP-712 authorization off-chain,
then a relayer submits the transaction and pays MON. A Prism user can hold either asset with no MON
and still pay.

Domain (verified + re-checked at runtime): name `Agora Dollar`, version `1`, 6 decimals. Addresses:
mainnet `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (chainId 143), testnet
`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (chainId 10143).
USDC uses domain `USDC`, version `2`, and 6 decimals. Addresses: mainnet
`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, testnet
`0x534b2f3A21130d7a60830c2Df862319e593943A3`.

## Direct payment

1. User chooses Tobi (Contacts / @handle / QR / link) and an amount.
2. The app submits only Tobi's selected E.164 number (or handle / prism id) to the protected
   resolver, which returns a short-lived, requester-bound, signed resolution: recipient account,
   Prism identity, alias version, expiry.
3. The app checks the resolution against its last locally trusted identity for this contact.
4. Backend builds the Prism envelope and the selected token's exact EIP-712
   `TransferWithAuthorization`, both binding recipient, token, amount, validity, and nonce.
5. The app shows the intent; Face ID or PIN is the local approval gate; the Mera session signs the
   typed data (secp256k1).
6. Backend verifies both signatures recover to the payer's account and relays
   `PrismPaymentRouter.settle(...)`, paying MON.
7. The router calls the selected token's `transferWithAuthorization` directly from payer to
   recipient. A change to the token, recipient, amount, or reference invalidates a signature.
8. The operation stays `sending` / `settling` until an on-chain receipt is reconciled. `submitted`
   is never shown as `completed`.

## Payment router (recipient integrity without a smart wallet)

`PrismPaymentRouter` accepts only its immutable AUSD and USDC addresses. Its signed payment envelope
binds the payer, recipient, token, amount, request, resolution, validity, and nonce. The router then
submits the matching ERC-3009 token authorization. Envio indexes `PaymentSettled` with the token.

## Claims for non-users

For a contact with no Prism account:

1. App creates cryptographically random `claimId` and `recipientReference` (never phone-derived).
2. Sender signs an ERC-3009 `ReceiveWithAuthorization` to the claim vault, with the binding nonce
   `keccak256(claimId, recipientReference, amount, from)`.
3. Relayer calls `PrismClaimVault.createClaim(...)`, which pulls the AUSD into escrow.
4. Recipient joins Prism (creates their Mera account) and verifies the same alias.
5. The isolated **claim authorizer** (secp256k1, KMS/HSM in production) signs an EIP-712
   `ClaimAuthorization(claimId, recipientAccount, aliasVersion, nonce, deadline)`.
6. Relayer calls `claim(...)`; the vault checks authorizer, deadline, single-use and state, then
   sends the funds to the recipient's Mera account. Recipient identity is bound by the authorizer
   signature, not by `msg.sender`, so the recipient needs no MON.
7. If the deadline passes unclaimed, anyone may trigger `refund(claimId)`; funds can only ever go
   back to the original sender.

No phone number, phone hash, handle, or deterministic alias identifier is emitted by any contract.

## Protected alias resolver

Phone numbers are normalized to E.164 and never stored or indexed as raw text:

- `phone_lookup = HMAC-SHA256(RESOLVER_PEPPER, e164)`;
- the E.164 value, when persisted, is AES-256-GCM encrypted with a separate key;
- resolver endpoints require a Prism session and are per-user/per-IP rate limited;
- responses expire in ~2 minutes and carry monotonically increasing alias versions;
- resolutions are signed by an internal resolver key and bound to the requesting Prism id.

This blocks rainbow-table reversal of a leaked index and bulk enumeration. It does **not** claim the
resolver is blind to the phone number during a lookup; an OPRF/enclave/PSI design can replace this
component behind the same app-facing protocol.

## Identity-change safety

The app stores `local contact -> last Prism identity -> last account -> alias version`. If a later
resolution points to a different identity/account, Prism does not silently send; it shows an
identity-change warning and requires explicit review. Stale/revoked alias versions fail closed.

## Relayer and gas

A MON-funded relayer submits router/vault transactions so users never touch MON. In production this
is replaced or augmented by **Alchemy Gas Manager** sponsorship. The relayer can never alter a
payment's recipient or amount (nonce binding) — it only pays gas.

## Indexing

Envio HyperIndex indexes AUSD `Transfer`, router `PrismPayment`, and vault `ClaimCreated` /
`ClaimPaid` / `ClaimRefunded` events into the product's activity feed and reconciliation view.

## Canonical sources

| State | Canonical source |
|---|---|
| AUSD balance | Monad RPC / AUSD contract |
| Signing authority | Mera passkey-derived account |
| Payment completion | Monad transaction receipt + `PrismPayment` event |
| Claim funds/state | PrismClaimVault |
| Phone alias binding | protected resolver |
| Handle binding | Prism directory |
| Contacts | iOS Contacts |
| PIN | protected local state |
| Request lifecycle | signed Prism backend state |
| Activity UI | reconciled projection (Envio + receipts) |
