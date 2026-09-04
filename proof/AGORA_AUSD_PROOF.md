# AGORA / AUSD PROOF

**Status: PROVEN (live chain readback).** This is the one integration claim that was verified
against a real deployed contract rather than a mock.

Prism asserts that the payer's Mera account signs an AUSD ERC-3009 authorization that the live
Agora token will accept. That claim has three failure modes, and all three are checked here against
the deployed token, not against `MockAUSD`.

## Environment

| Field | Value | Source |
|---|---|---|
| Network | Monad testnet | `eth_chainId` |
| chainId | `10143` (`0x279f`) | `cast chain-id --rpc-url https://testnet-rpc.monad.xyz` |
| Block at verification | `59477252` | `cast block-number` |
| Verified at | 2026-09-03T23:51:03Z | — |
| AUSD (proxy) | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` | `contracts/.env`, `backend/src/config.js` |
| AUSD implementation | `0xc1e3c7d486d6a92fbe920232e439eec2ceb112da` | EIP-1967 slot `0x360894a1…82bbc` |

## Claim 1 — the EIP-712 domain Prism signs under is the token's real domain

This is the claim most likely to be silently wrong, because the token's ERC-20 `name()` and its
EIP-712 domain `name` **disagree**, and a codebase that read `name()` would sign unusable
authorizations.

| Read | Value |
|---|---|
| `name()` | `"AUSD"` |
| `symbol()` | `"AUSD"` |
| `decimals()` | `6` |
| `DOMAIN_SEPARATOR()` (on-chain) | `0x7ff7d6b4bdc3e260c85cf89f8779b1ac80120e3c277f7db4900739a507f03ea1` |

Independent readback — recomputing the separator locally over candidate domains:

| Candidate domain | Computed separator | Match |
|---|---|---|
| `name="Agora Dollar"`, `version="1"` | `0x7ff7d6b4bdc3e260c85cf89f8779b1ac80120e3c277f7db4900739a507f03ea1` | **YES** |
| `name="Agora Dollar"`, `version="2"` | `0x01ceaf03a8ea2d64c927d3ae47611ff84239bd23f4bb5b8bd704be447abf1362` | no |
| `name="AUSD"`, `version="1"` | `0xe6af656f42e4f4a09f37146e4d3a3c0833078b83a12382f3991cadca17d735f5` | no |
| `name="AUSD"`, `version="2"` | `0xa142b0ddbcaf9514b81e0571b0200a188d3ab8a87448fb6caee8129968fc892d` | no |

`AUSD_DOMAIN = { name: 'Agora Dollar', version: '1' }` in `backend/src/config.js` is **correct**,
and `MockAUSD`'s domain is byte-identical to the live token's, so a signature valid in the Foundry
suite is valid against the real token. `backend/src/chain/eth.js:verifyAusdDomain()` re-derives and
compares this at startup and refuses to relay on mismatch.

> Deviation worth knowing: `MockAUSD.name()` returns `"Agora Dollar"` while the live token's
> `name()` returns `"AUSD"`. Cosmetic — `name()` is not an input to the domain separator, which is
> what signatures actually commit to — but the mock is not byte-faithful on that one getter.

## Claim 2 — the live token exposes the `(v, r, s)` ERC-3009 functions the router calls

`PrismPaymentRouter.settle` calls `transferWithAuthorization(...uint8,bytes32,bytes32)` and
`PrismClaimVault.fundClaim` calls `receiveWithAuthorization(...uint8,bytes32,bytes32)`. If the live
token only shipped the packed-`bytes` variant, every payment would revert on-chain.

Selector presence in the implementation runtime bytecode at `0xc1e3…12da`:

| Selector | Signature | Present |
|---|---|---|
| `0xe3ee160e` | `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` | **yes** |
| `0xef55bec6` | `receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` | **yes** |
| `0xe94a0102` | `authorizationState(address,bytes32)` | **yes** |
| `0x5a049a70` | `cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)` | **yes** |
| `0xcf092995` | `transferWithAuthorization(...,bytes)` | yes (unused by Prism) |
| `0x88b7ab63` | `receiveWithAuthorization(...,bytes)` | yes (unused by Prism) |

Live call confirming the function is real and reachable through the proxy:

```
cast call 0xa9012a…22dC "authorizationState(address,bytes32)(bool)" 0x00…00 0x00…00
=> false
```

## Claim 3 — the live token actually verifies signatures

A `transferWithAuthorization` call carrying a junk signature was submitted as `eth_call`:

```
cast call 0xa9012a…22dC "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" \
  0x..01 0x..02 1 0 99999999999 0x..01 27 0x..01 0x..01
=> Error: execution reverted: InvalidSignature   (data: 0x8baa579f)
```

`0x8baa579f` is `InvalidSignature()`. The token performs real signature recovery and fails closed —
it does not silently no-op on a bad authorization.

## What is NOT proven here

- **No AUSD has been moved on Monad testnet by this codebase.** `mint(address,uint256)` on the live
  token is role-gated (`eth_call` from an arbitrary address reverts `AddressIsNotMinterRole`), so
  test AUSD must come from Agora's faucet/treasury. See `TESTNET_DEPLOYMENT.md`.
- The mainnet token (`0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`) was **not** probed; only testnet.

## Reproduce

```bash
export PATH="$HOME/.foundry/bin:$PATH"; R=https://testnet-rpc.monad.xyz
A=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
cast call $A "name()(string)" --rpc-url $R
cast call $A "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $R
cast storage $A 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $R
cast call $A "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000000 \
  0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url $R
```
