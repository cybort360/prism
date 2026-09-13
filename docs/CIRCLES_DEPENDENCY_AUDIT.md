# Prism Circles — dependency audit

Every external contract Prism Circles would stand on, verified against the live chain rather than
against documentation or a stale comment. No address in this file was copied from a blog post, a
tutorial, or an existing comment in this repository.

- **Verified at:** 2026-09-13T09:51Z, Monad testnet block **62,152,291**
- **Target network:** Monad **testnet**, chainId **10143** (`https://testnet-rpc.monad.xyz`)
- **Future network:** Monad **mainnet**, chainId **143** (`https://rpc.monad.xyz`)
- **Circle asset:** USDC only. AUSD / earnAUSD belong to Prism Save and appear nowhere here.

How each row was checked:

1. the address was read from the official `@safe-global/*` deployment package, never typed by hand;
2. `eth_getCode` was called on Monad and `keccak256` of the result compared to the **codeHash the
   package publishes for the canonical deployment** — so a look-alike contract at the right address
   would fail;
3. where a package publishes no codeHash, the bytecode was compared byte-for-byte against the same
   address on an unrelated chain (Base mainnet);
4. functional identity was confirmed by calling the contract (`VERSION()`, `symbol()`, …).

Reproduce: `cd tools/circles && npm ci && npm run verify`, and
`cd contracts && FOUNDRY_PROFILE=circles forge test --match-path 'test/circles/*' --network monad`.

## Packages

| Package | Version resolved | Notes |
|---|---|---|
| `@safe-global/safe-deployments` | **1.37.63** | source of all Safe core addresses below |
| `@safe-global/safe-modules-deployments` | **3.0.10** | latest; ships **no** Allowance Module v1.0.0 |
| `@safe-global/protocol-kit` | **8.0.7** | used for independent hash + signature-encoding checks |
| `@safe-global/api-kit` | 5.0.3 (latest) | not yet wired in; Transaction Service is reachable |
| `viem` | 2.56.5 | RPC + keccak in the verification tooling |

## Safe core — Safe v1.4.1 on Monad testnet (chainId 10143)

Every codeHash below **matches** the canonical value published by `safe-deployments`, and the
deployed bytecode is byte-identical to the same address on Base mainnet.

| Name | Version | chainId | Address | codeHash (keccak256 of deployed bytecode) | Usable |
|---|---|---|---|---|---|
| Safe (singleton) | 1.4.1 | 10143 | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | `0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4` | **YES** |
| SafeL2 | 1.4.1 | 10143 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | `0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff` | YES (not used — see note) |
| SafeProxyFactory | 1.4.1 | 10143 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | `0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317` | **YES** |
| CompatibilityFallbackHandler | 1.4.1 | 10143 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | `0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9` | **YES** |
| MultiSend | 1.4.1 | 10143 | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` | `0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77` | YES |
| MultiSendCallOnly | 1.4.1 | 10143 | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | `0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939` | YES |
| SignMessageLib | 1.4.1 | 10143 | `0xd53cd0aB83D845Ac265BE939c57F53AD838012c9` | `0x525c754a46b79e05543a59bb61e8de3c9eee0d955a59352409cbe67ea1077528` | YES |
| CreateCall | 1.4.1 | 10143 | `0x9b35Af71d77eaf8d7e40252370304687390A1A52` | `0x2b3060c55fcb8275653e99ad511a71f67ba76934ed66a7d74d6e68b52afff889` | YES |
| SimulateTxAccessor | 1.4.1 | 10143 | `0x3d4BA2E0884aa488718476ca2FB8Efc291A46199` | `0x91f82615581fc73b190b83d72e883608b25e392f72322035df1b13d51766cf8d` | YES |

- `Safe(0x41675C…).VERSION()` returns **`"1.4.1"`** on Monad testnet — checked by call, not by address.
- Monad is registered in Safe's config service as **`l2: false`**, so the **`Safe`** singleton is the
  correct master copy for Circles, not `SafeL2`.
- The same nine addresses are listed for **Monad mainnet (143)**. They have **not** been
  code-verified here because Circles targets testnet today; re-run the audit before mainnet.

### Safe Transaction Service — Monad

| Item | Value | Status |
|---|---|---|
| Monad mainnet (143) tx service | `https://api.safe.global/tx-service/monad` | reachable, HTTP 200 |
| Monad testnet (10143) tx service | `https://api.safe.global/tx-service/monad-testnet` | reachable, HTTP 200 |
| Service version | Safe Transaction Service **6.10.1** | verified |
| Indexing state (testnet) | `synced: true`, `erc20Synced: true`, `masterCopiesSynced: true`, block 62,152,208 | **live and caught up** |

Safe's config service lists both Monad chains (`shortName` `monad` / `monad-testnet`, native
currency **MON**). Prism does **not** depend on this service for correctness — it is a convenience
for proposal storage, and the Circle's authority lives entirely in owner signatures on-chain.

### EIP-7951 / P-256 precompile (Monad native)

| Item | Value | Status |
|---|---|---|
| Precompile address | `0x0000000000000000000000000000000000000100` | **live** |
| `eth_getCode` | `0x` (correct — a precompile, not a contract) | expected |
| Known-good vector | returns `0x…01` | **verified on Monad testnet by `eth_call`** |
| Foundry support | requires **`--network monad`** (Foundry ≥1.8) | see caveat below |

Two findings worth carrying forward:

- **Foundry must be told the network.** Without `--network monad`, a call to `0x0100` returns
  *success with empty output*, which `P256Verifier.verify` correctly reads as "invalid". Every
  P-256 test silently becomes vacuous. `archive/erc4337-p256/test/MonadP256Live.t.sol` predates
  this flag.
- **Signatures are malleable.** The precompile accepts both `s` and `n − s` — it does **not**
  enforce low-s. Safe's nonce prevents replay of an executed transaction, so this is not
  exploitable on the Circles path, but **off-chain code must key proposals by `safeTxHash`, never
  by signature bytes**.

## Safe Allowance Module — NOT USABLE

This is the one dependency that fails the gate, and it fails for exactly the reason anticipated.

| Name | Version | chainId | Address | Released | Usable |
|---|---|---|---|---|---|
| AllowanceModule | **0.1.1** | 10143 | `0xAA46724893dedD72658219405185Fb0Fc91e091C` | yes (2024-09-11) | **NO — vulnerable** |
| AllowanceModule | **0.1.1** | 143 | `0xAA46724893dedD72658219405185Fb0Fc91e091C` | yes | **NO — vulnerable** |
| AllowanceModule | **0.1.0** | — | not deployed on Monad | yes | **NO — vulnerable** |
| AllowanceModule | **1.0.0** | — | **no deployment exists** | **yes — source released 2026-02-25** | **NO — undeployed** |

Findings:

- `allowances/v1.0.0` is a **real, non-prerelease** GitHub release of `safe-global/safe-modules`,
  published **2026-02-25**. Its notes state it *"fixes a security vulnerability that would allow
  delegate transfers to be replayed"* and that it is a breaking change incompatible with Safe
  v1.0.0. The premise behind the Circles spending-limit gate is correct.
- The latest official `@safe-global/safe-modules-deployments` (**3.0.10**) ships **no deployment
  record for v1.0.0 on any chain** — only v0.1.0 and v0.1.1.
- The only Allowance Module actually deployed on Monad is **v0.1.1**, the pre-fix version. Its
  bytecode on Monad testnet is byte-identical to the same address on Base
  (`keccak256 = 0x7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e`), so it is
  genuinely the vulnerable release and not a patched rebuild.

**Decision — no silent downgrade:**

```
CIRCLE_LIMITS_ENABLED = false
```

Prism Circles ships **threshold-only** spending. Per-member allowances stay off until a released
v1.0.0 is independently verifiable on the target network. Circles must not enable v0.1.1 merely
because a deployment happens to exist.

## Safe 4337 module — available, deliberately unused

| Name | Version | chainId | Address | keccak256(code) | Usable |
|---|---|---|---|---|---|
| Safe4337Module | 0.3.0 | 10143 | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` | `0x2aea997c4e3cf0e2f333025372e219abcfde81c21fc2f8fb066414a5685dd3e0` | deployed, **NOT ENABLED** |
| Safe4337Module | 0.2.0 | — | not deployed on Monad | — | n/a |

Circles uses Safe's ordinary `execTransaction` path. ERC-4337 adds an EntryPoint, a bundler, and a
paymaster to the trusted set and buys Circles nothing that a relayer does not already provide — see
`ZERO_MEMBER_MON_EXECUTION_PATH` in the Phase 3 results. Not enabled.

## USDC (Circle) — the Circle asset

Both addresses were already in this repository; both were **re-verified**, and the EIP-712 domain
separator was **recomputed from the on-chain `name`/`version`/`chainId`/`address` and compared to
the contract's own `DOMAIN_SEPARATOR()`**.

| Network | chainId | Address | name / symbol / version | decimals | Domain separator matches | Usable |
|---|---|---|---|---|---|---|
| Monad testnet | 10143 | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | USDC / USDC / 2 | 6 | **yes** (`0xf1090f5a…a0a48d`) | **YES** |
| Monad mainnet | 143 | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC / USDC / 2 | 6 | **yes** (`0xfe22123e…2c93c6`) | **YES** |

Total supply at audit: ~9.23bn (testnet), ~230.1m (mainnet). The addresses recorded in
`README.md`, `backend/src/config.js` and `deployments/monad-testnet.json` are **correct** and
unchanged by this work.

## Summary

| Dependency | Status |
|---|---|
| Safe v1.4.1 core on Monad testnet | **VERIFIED** — 9/9 codeHashes match canonical |
| Safe Transaction Service (Monad) | **VERIFIED** — live, synced |
| Monad EIP-7951 P-256 precompile | **VERIFIED** — live (needs Foundry `--network monad`) |
| USDC on both Monad networks | **VERIFIED** — incl. EIP-712 domain |
| Safe Allowance Module v1.0.0 | **UNAVAILABLE** — released but undeployed → limits disabled |
| Safe 4337 Module v0.3.0 | deployed, **deliberately not enabled** |
| Safe v1.4.1 core on Monad **mainnet** | **UNKNOWN** — addresses listed, not code-verified yet |
