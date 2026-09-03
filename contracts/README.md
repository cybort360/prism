# Prism Contracts

Prism's on-chain payment surface on Monad. Prism does **not** deploy AUSD — Agora does; Prism
targets the live AUSD token and its ERC-3009 interface.

## Contracts

- `PrismPaymentRouter.sol` — gasless AUSD direct-payment path. Pulls a payer's ERC-3009
  `ReceiveWithAuthorization` to itself and forwards to the final recipient. The signed 32-byte nonce
  must equal `keccak256(from, to, value, paymentRef)`, so a relayer cannot redirect or resize a
  payment. Emits `PrismPayment(paymentRef, from, to, value)` for indexing.
- `PrismClaimVault.sol` — escrow for payments to people who have not joined Prism. Funded via
  ERC-3009 (`keccak256(claimId, recipientReference, amount, from)` binding). Collection is gated by
  an isolated **secp256k1 claim authorizer** (`ecrecover`, EIP-712), so a relayer can submit on the
  recipient's behalf. Random `claimId` / `recipientReference` only — never phone-derived. Refund to
  the original sender after expiry is permissionless.
- `interfaces/IERC3009.sol` — the AUSD ERC-3009 surface Prism uses (`(v, r, s)` variant).
- `mocks/MockAUSD.sol` — test-only faithful AUSD (EIP-712 domain `Agora Dollar` / `1`, 6 decimals,
  ERC-3009 authorization state) so signatures made for the real token validate in Foundry.

## Signature convention

The payer's Mera passkey-derived account is a standard secp256k1 EOA. It signs AUSD's EIP-712
`ReceiveWithAuthorization`; AUSD verifies with `ecrecover`. No P-256, precompile, or ERC-4337 is
involved. Signatures are 65 bytes (`r || s || v`); the router/vault take `(v, r, s)`.

## Deploy

```bash
cp .env.example .env   # set DEPLOYER_PRIVATE_KEY, AUSD_ADDRESS, CLAIM_AUTHORIZER_ADDRESS
forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast
```

## Claim privacy

The vault stores only random `claimId` and random `recipientReference`; neither is derived from a
phone number. The private backend maps a verified alias to the random claim ID off-chain.

## Archived

The previous Secure-Enclave-P256 / ERC-4337 account (`PrismAccount`, `PrismAccountFactory`,
`P256Verifier`, precompile mocks and their tests) lives under `../archive/erc4337-p256/` for
reference and is not part of the build.
