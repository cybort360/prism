# Safe Allowance Module v1.0.0 — provenance

Vendored so that Prism's spending-limit gate checks against something it can name exactly, rather
than against "whatever the package resolves to today". Nothing in this directory is Prism code.

## Source

| Field | Value |
|---|---|
| Repository | `safe-global/safe-modules` (now served as `safe-fndn/safe-modules`) |
| Release tag | **`allowances/v1.0.0`** |
| Tag commit | `c95f03900bff99be090dadb9de1c74b162365485` |
| Published | **2026-02-25T09:46:26Z** — non-draft, non-prerelease |
| Path in repo | `modules/allowances/contracts/` |
| Captured | 2026-09-13 |

```
sha256  a5e1c3490ebf9607c2631dca6e14ce96f0df2ecd6aaecf1a2b4608b81734f2cf  AllowanceModule.sol
sha256  3a2623c96b876a14d6eb75bf30a39ec72c8e8756ddbe5983b34d38798673af4c  Enum.sol
sha256  72e0e37aba7f62a6de6b6a08235cc00c8a3a0524d47e59e9d47bdbf0f803d17a  SignatureDecoder.sol
```

Re-fetch and re-hash:

```
curl -sSL "https://raw.githubusercontent.com/safe-fndn/safe-modules/allowances%2Fv1.0.0/modules/allowances/contracts/AllowanceModule.sol" | sha256sum
```

## Why this version and no earlier one

The upstream release notes for `allowances/v1.0.0`:

> This is a new release of the Safe allowance module which fixes a security vulnerability that would
> allow delegate transfers to be replayed.

`CHANGELOG.md` in this directory names the mechanism: the allowance nonce is a `uint16`, and in
v0.1.x it **wrapped**. A wrapped nonce makes every previously-signed transfer valid again. v1.0.0
refuses to advance past `type(uint16).max` instead:

```solidity
require(allowance.nonce != type(uint16).max, "allowance.nonce != type(uint16).max (use different delegate)");
```

`AllowanceModuleCompat.t.sol::testNonceExhaustionIsRefusedRatherThanWrapping` forces the stored
nonce to its ceiling and asserts that refusal — a behavioural check that the code under test is the
fixed release, independent of the bytecode comparison below.

v1.0.0 also fixes allowance accounting for ERC-20s that return `false` instead of reverting, and a
delegate-key collision in `removeDelegate`. The first of those is why v1.0.0 **requires Safe
v1.1.1+**: it needs `execTransactionFromModuleReturnData`.

## Compiler

Upstream `CHANGELOG.md` records:

- Solidity **0.7.6**
- optimizer **disabled**
- expected address **`0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`**

Reproduced here as `[profile.allowances]` in `contracts/foundry.toml`:

```
forge build --profile allowances
```

## Bytecode: what reproduces and what does not

**Canonical deployment.** `0x691f59471Bfd2B7d639DCF74671a2d648ED1E331` carries the same 15,504-byte
runtime on **Optimism** and **Gnosis**, byte-identical, and answers `VERSION() == "1.0.0"`,
`NAME() == "Allowance Module"`. That capture is `canonical-runtime.hex`:

```
keccak256 = 0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657
```

**Our recompilation does NOT reproduce it byte-for-byte, and this is recorded rather than glossed.**
Building the tagged source with Foundry at upstream's stated settings gives:

| | canonical | our build |
|---|---|---|
| runtime size | 15,504 bytes | 15,552 bytes |
| ABI | 19 functions | **identical 19 functions**, same selectors, no extras |
| dispatcher | 3 binary-search pivots | 6 pivots |

The entire 48-byte difference is the shape of the function dispatcher. Sweeping `evm_version`
(istanbul / berlin / london) and the optimizer (off, and on at 200/1k/10k/1M runs) closed none of
it; the difference is a codegen artifact of upstream's Hardhat toolchain versus Foundry, not a
difference in what the contract does. The ABI check is what rules out the alternative explanation
that the deployed contract has a different surface.

**What this means in practice.** Prism does not rely on its own recompilation for anything
load-bearing:

- the **gate** (`tools/circles/verify-allowance-module.mjs`) verifies a deployment against the
  *canonical codeHash*, not against our build;
- the **tests** (`contracts/test/AllowanceModuleCompat.t.sol`) `vm.etch` the *canonical runtime*, so
  the security matrix runs against Safe's actual bytes;
- the **deploy script** (`script/DeployAllowanceModuleV1.s.sol`) deploys the *canonical runtime*
  verbatim, so a Prism-deployed module is byte-identical to Safe's own.

Our recompilation earns its place as an independent cross-check on the ABI and on the source
matching the tag. It is not the thing anything trusts.

Deploying the runtime directly is sound because the module has **no constructor and no immutables** —
every piece of its state is a mapping that starts empty — so runtime-only deployment is
behaviourally identical to a normal one. Both facts are asserted in the deploy script before it
broadcasts and again after, read back from the chain.

## Deployment status on Monad

Checked live, 2026-09-13, by `eth_getCode`:

| Chain | v1.0.0 `0x691f5947…` | v0.1.1 `0xAA467248…` |
|---|---|---|
| Monad testnet (10143) | **no code** | 14,909 bytes — deployed, **vulnerable** |
| Monad mainnet (143) | **no code** | 14,909 bytes — deployed, **vulnerable** |

The official `@safe-global/safe-modules-deployments` package (latest, **3.0.10**) ships **no
deployment record for v1.0.0 on any chain**. Its unpinned resolution returns **v0.1.1** — the
vulnerable release — which is exactly the accident the gate exists to prevent.
