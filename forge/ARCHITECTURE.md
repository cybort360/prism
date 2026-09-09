# ARCHITECTURE

The four-layer continuity model, mapped to the components that actually exist in this build.

```
HOW I AM FOUND        phone / @handle / QR / link
   │                  → backend resolver (POST /v1/resolve/{phone,handle,prism})
   │                    returns a SIGNED, short-lived, requester-bound attestation
   ▼
WHO I AM              persistent PrismIdentity  { prismId, accountAddress, aliasVersion, … }
   │                  → backend/src/services/identityService.js (the identity record + phoneIndex/handleIndex)
   ▼
WHO MAY AUTHORIZE     device passkey  →  Mera-derived secp256k1 account
MY MONEY              → @category-labs/mera in an offscreen WKWebView bridge
   │                    (ios/MeraBridge/*); Prism never handles a private key
   ▼
WHERE MY MONEY LIVES  that same secp256k1 account on Monad, holding USDC
                      → PrismPaymentRouter.settle() / PrismClaimVault (relayer-submitted, gasless)
```

## Components

- **Resolver** (`backend/src/services/resolverService.js`) — resolves an alias to a PrismIdentity and
  returns a P-256-signed attestation binding `{prismIdentity, recipientAccount, aliasVersion,
  requesterPrismId, requestId, issuedAt, expiresAt}`. No phone-derived value in the attestation.
- **Identity** (`identityService.js`) — the persistent `PrismIdentity`. Phone is stored **encrypted**;
  the lookup index is a private `phoneLookupKey = HMAC(pepper, E.164)` — never emitted. `aliasVersion`
  increments on a reachability change (phone rotation), the account is unchanged.
- **Authority** (`ios/MeraBridge/*`, `@category-labs/mera`) — a WebAuthn **passkey (P-256/secp256r1)**
  gates and derives a **standard secp256k1 EVM account**. That account produces the EIP-712/191
  signatures. Sessions are scoped (`payments` vs `identity`) and expire; identity actions
  re-authenticate.
- **Settlement** (`contracts/PrismPaymentRouter`, `PrismClaimVault`) — USDC ERC-3009
  (`receiveWithAuthorization` / `transferWithAuthorization`), recipient+amount bound in the nonce; a
  MON-funded relayer submits so the user needs no MON. Cross-chain adds `routeHash` in the same
  envelope slot (no contract change).
- **Truth** — Monad token state is canonical. The backend keeps a guarded state machine + append-only
  event log (`backend/src/lib/lifecycle.js`) and projects consumer language; Envio indexes real events
  for reconciled history; Alchemy provides live reads/receipts.

## ⚠️ Architectural conflict with the FORGE 1.4 canonical-model wording (reported, not resolved)

The FORGE 1.4 brief states the model as:

- *"WHO MAY AUTHORIZE MY MONEY = **device-backed P256 credential**"*
- *"WHERE MY MONEY LIVES = **Monad smart account**"*

The current implementation differs, and this is flagged here rather than silently reconciled:

1. **"device-backed P256 credential" — partially accurate.** The *root of authority* is a device
   passkey, which **is** a device-backed P-256 (WebAuthn/secp256r1) credential. But the credential
   that actually **signs on-chain** is a **secp256k1** account **derived from** that passkey by Mera —
   not a raw P-256 signature. So "P256 authorizes" is true at the root and misleading at the wire: the
   settlement signature is secp256k1.

2. **"Monad smart account" — conflicts.** In this build the money lives at a **secp256k1 EOA** (Mera:
   *"no bundler, no MPC"*), **not** an ERC-4337 smart-contract account. The **ERC-4337 + raw-P256
   smart-account** path exists only under `archive/erc4337-p256` and `archive/ios-secure-enclave-p256`
   and is **not active**. Calling the current money location a "smart account" would misdescribe it.

**Update (2026-09-09) — a P-256 smart-account path now exists and is proven live.** `PrismP256Account`
(`contracts/src/PrismP256Account.sol`) is a relayer-sponsored **smart account** whose spending
authority is a **device P-256 key verified on-chain** (RIP-7212 precompile `0x0100`) — deployed on
Monad testnet and exercised with a real P-256-authorized, gas-sponsored USDC payment (tx `0xdea2…8a88`;
`PROOF_LEDGER` CHAIN-7 / R1). This directly answers A-1/A-2 at the settlement layer. The **consumer app
still routes user payments through the secp256k1 `PrismPaymentRouter`**; wiring iOS/Mera to emit the
WebAuthn P-256 signature into `PrismP256Account` is the remaining adoption step (a front-end change, no
new on-chain primitive needed).

**Why it doesn't change the thesis:** the four-layer *decoupling* (reachability → identity → authority
→ money) — which is what Prism Continuity depends on — holds identically whether the authority is a
Mera secp256k1 account or an ERC-4337/P-256 smart account. The continuity invariants (INV-C1..C3) are
enforced in the resolver/identity/trust layers, above the account type, and are unaffected.

**Decision needed (owner):** either (a) adopt accurate wording in the brief/docs — "device passkey →
Mera-derived secp256k1 account" and "Monad account (EOA)"; or (b) if the intended direction really is
an ERC-4337/P-256 smart account, that is a *product/architecture change*, out of scope for the
`continuity-vertical-slice` phase, and must be planned explicitly (the archived path is the starting
point). This phase assumes (a).

See `../docs/ARCHITECTURE.md`, `../docs/MERA_INTEGRATION.md`, `../docs/IOS_ARCHITECTURE.md`,
`../docs/THREAT_MODEL.md`.
