# Prism PRD Addendum — v1.1

This addendum records the architecture change from the original v1 scaffold. Where it conflicts with
older notes, this document wins.

## What changed and why

| Area | v1 (original scaffold) | v1.1 (this build) | Why |
|---|---|---|---|
| Consumer signing | Custom Secure-Enclave **P-256** key + **ERC-4337** `PrismAccount` + bundler + paymaster | **Mera passkey-derived secp256k1 account** (official `@category-labs/mera`) | One consumer signing layer; no seed phrase; passkey recovery; standard signatures |
| Payment primitive | ERC-4337 `UserOperation` executing a token transfer | **AUSD ERC-3009 `receiveWithAuthorization`** via `PrismPaymentRouter`, relayer-submitted | Gasless for the user (AUSD>0, MON=0) with no bundler/account contract |
| Asset | USDC | **AUSD (Agora Dollar)** | Metropolis payment asset / Agora bounty |
| Claim vault | P-256-authorizer vault funded via 4337 `execute` | ERC-3009-funded vault with **secp256k1** authorizer | Matches the new signing/asset model; simpler `ecrecover` |
| Gas | Paymaster sponsors a UserOp | MON-funded **relayer** (prod: **Alchemy Gas Manager**) | Standard ERC-3009 relaying |
| Indexing | (implicit) | **Envio HyperIndex** of router/vault/AUSD events | Real product activity feed / Envio bounty |
| Recovery | On-chain P-256 key rotation | **Passkey re-derivation** (same account on a new device) | No on-chain rotation, no seed phrase |

The old path is not deleted from history — it is archived for reference under
`archive/erc4337-p256/` and `archive/ios-secure-enclave-p256/`, and is **not** active alongside
Mera.

## Preserved product requirements

- Core loop unchanged: `person → amount → Face ID / PIN → sent`.
- No "gas", "MON", "wallet", "seed phrase", "network", or hex address in the normal UI (the only
  address shown is the user's own deposit address, required to receive funds).
- Phone = private alias; @handle = optional public alias; QR and payment links resolve to a Prism
  identity, never to a raw address.
- All security invariants in `SECURITY.md` hold (OTP can't seize a funded account, submitted ≠
  completed, stale mappings fail closed, no public phone→wallet map, etc.).

## New user-facing behavior

- **Onboarding** creates a Mera passkey account with Face ID / Touch ID; the app proves control of
  that account to the backend (`bind_account` signature) — no key material is uploaded.
- **Paying** signs an EIP-712 AUSD authorization inside a scoped Mera session after the local PIN /
  Face ID gate; the relayer settles it on Monad.
- **Receiving as a new user** works through the claim vault: money waits in escrow and is released
  to the recipient's Mera account once they join and verify the alias.
- **Recovery** is "sign in with your passkey on the new phone" — the same account returns.

## Acceptance

- `make test` (backend `node --test`, `forge test`, iOS `xcodebuild test`) is green.
- Sponsor claims are mapped to concrete files and proofs in `SPONSOR_MATRIX.md`.
- The only open items are external credentials/services (see `README.md`).
