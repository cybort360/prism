# Prism Circles — Allowance Module security

Why per-member spending limits are **off**, what it would take to turn them on, and what was proven
about the module along the way.

Companion to [`CIRCLE_SPENDING_LIMITS.md`](CIRCLE_SPENDING_LIMITS.md), which is how the feature
works when it is on. This document is the gate in front of it.

> **Current status: `CIRCLE_LIMITS_ENABLED=false`.**
> An official Allowance Module **v1.0.0 exists and is deployed on other chains**, but **not on
> Monad** — and the only Allowance Module that *is* on Monad is the vulnerable v0.1.1. Circles runs
> threshold-only until that changes. Everything needed to change it is built and tested.

---

## 1. The rule

```
Allowance Module release >= v1.0.0, or no spending limits at all.
```

Not "prefer v1.0.0". Not "v0.1.1 with extra validation". The pre-1.0 releases carry a bug that no
amount of care on Prism's side can compensate for, so the only safe posture is refusal.

**v0.1.x is never a fallback.** This is worth stating flatly because the easy path leads straight to
it: the official deployments package resolves the newest release *it knows about*, and today that is
the vulnerable one.

```js
getAllowanceModuleDeployment({})                  // -> v0.1.1   ← silently vulnerable
getAllowanceModuleDeployment({ version: '1.0.0' }) // -> undefined
```

Prism's gate never makes that call. It asks for v1.0.0 by name and treats absence as failure.

---

## 2. What v1.0.0 actually fixed

From the upstream release notes for `allowances/v1.0.0` (2026-02-25, non-draft, non-prerelease):

> This is a new release of the Safe allowance module which fixes a security vulnerability that would
> allow delegate transfers to be replayed.

The mechanism, from the release `CHANGELOG.md`:

| Fix | What it was |
|---|---|
| **Prevent nonce overflow** (PR #520) | The per-delegate allowance nonce is a `uint16`. In v0.1.x it **wrapped**, and a wrapped nonce makes every previously-signed transfer valid again. v1.0.0 refuses to advance past `type(uint16).max` instead. |
| **Revert on failed token transfer** (#237) | An ERC-20 that returns `false` rather than reverting would leave the delegate's allowance debited for a transfer that never happened. Fixing it needs `execTransactionFromModuleReturnData`, which is why **v1.0.0 requires Safe v1.1.1+** and breaks Safe v1.0.0. |
| **Prevent delegate deletion on key collision** (#523) | The delegate index is `uint48(address)`. `removeDelegate` now reverts on a collision instead of removing the wrong delegate and orphaning allowances. |

The first of these is the one the gate exists for, and it is regression-tested directly:
`AllowanceModuleCompat.t.sol::testNonceExhaustionIsRefusedRatherThanWrapping` forces the stored nonce
to its ceiling and asserts the refusal. That is a *behavioural* check that the code under test is the
fixed release — independent of, and complementary to, the bytecode comparison.

---

## 3. What is actually deployed

Checked live by `eth_getCode` and `VERSION()`, 2026-09-13:

| Chain | v1.0.0 `0x691f5947…` | v0.1.1 `0xAA467248…` |
|---|---|---|
| **Monad testnet (10143)** | **no code** | 14,909 bytes — deployed, vulnerable |
| **Monad mainnet (143)** | **no code** | 14,909 bytes — deployed, vulnerable |
| Optimism | 15,504 bytes, `VERSION() == "1.0.0"` | — |
| Gnosis | 15,504 bytes, **byte-identical to Optimism** | — |

`@safe-global/safe-modules-deployments@3.0.10` (latest) ships **no deployment record for v1.0.0 on
any chain** — only v0.1.0 (15 chains) and v0.1.1 (53 chains). Safe published the source and deployed
it before the registry caught up, which is exactly the situation a gate has to handle without either
guessing or giving up.

Because v1.0.0 *is* deployed on two independent chains with identical bytecode, Prism has a
**canonical reference** to check against:

```
keccak256(runtime) = 0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657
```

captured in `contracts/vendor/safe-allowances-v1.0.0/canonical-runtime.hex`.

---

## 4. The gate

Two halves, both failing closed.

### Build time — `tools/circles/verify-allowance-module.mjs`

```
cd tools/circles && node verify-allowance-module.mjs --chain-id 10143
```

Seven checks, refusing at the first failure:

| # | Check | What it rules out |
|---|---|---|
| 1 | **release** | an official non-draft, non-prerelease tag >= v1.0.0 exists upstream |
| 2 | **registry** | asks the deployments package *by version*; reports what an unpinned call would have returned |
| 3 | **address** | a deployment on the target chain, from the registry or supplied by the operator |
| 4 | **bytecode** | `keccak256(eth_getCode)` equals the canonical codeHash, byte for byte |
| 5 | **abi** | all 19 canonical selectors present |
| 6 | **identity** | the contract itself answers `VERSION() == "1.0.0"`, `NAME() == "Allowance Module"` |
| 7 | **safe-compat** | the Safe is >= v1.1.1 |

A network failure at step 1 is treated as *unknown*, and unknown fails exactly like absent. The gate
never opens on missing evidence.

It is proven in all three directions, not merely observed to fail:

```
--chain-id 10   --module 0x691f5947…   PASS  (Optimism: v1.0.0 really is there)
--chain-id 10143                        FAIL  address  (Monad: no v1.0.0 deployment)
--chain-id 10143 --module 0xAA467248…   FAIL  bytecode (the vulnerable module, explicitly refused)
```

A gate that always fails is not a gate. The Optimism run is what makes the Monad failure meaningful.

### Run time — `AllowanceModuleGate`

The server does not trust a build-time check to describe the chain it is actually talking to. The
same verification runs at boot and again before any spend, with a five-minute cache on success and
**no caching of failure**.

It identifies a module by **code, not address**: a Prism-deployed copy at a novel address is fine if
its bytecode matches; the canonical address with different bytecode is not.
→ `circles-limits.test.js`: *the runtime gate identifies the module by CODE, not by address*.

And `assertCircleLimitsAreSafe` runs in **every** environment, not just production — a dev server
pointed at the vulnerable module would teach a spending model that can never ship.

---

## 5. Option A: deploying it ourselves

If Safe has not deployed v1.0.0 to Monad, Prism can — with the **exact upstream code**.

`contracts/script/DeployAllowanceModuleV1.s.sol` deploys the **canonical runtime bytecode verbatim**,
wrapped in twelve bytes of initcode that do nothing but return it. The result's `eth_getCode` is
*identical* to Safe's own deployment on Optimism and Gnosis.

This is sound because the module has **no constructor and no immutables** — all its state is mappings
that start empty — so a runtime-only deployment is behaviourally identical to a normal one. The
script asserts the vendored bytes are canonical *before* broadcasting, and reads the deployed code
back afterwards.

### Why not recompile and deploy that?

Because it would not be the same bytes, and we would rather say so than pretend otherwise.

Compiling the tagged source at upstream's stated settings (solc 0.7.6, optimizer off) yields:

| | canonical | our build |
|---|---|---|
| runtime size | 15,504 bytes | 15,552 bytes |
| ABI | 19 functions | **identical**, same selectors, no extras |
| dispatcher | 3 binary-search pivots | 6 pivots |

The whole 48-byte difference is the shape of the function dispatcher — a Hardhat-versus-Foundry
codegen artifact. Sweeping `evm_version` and the optimizer closed none of it. The identical ABI is
what rules out the alternative explanation (that the deployed contract has a different surface).

So nothing load-bearing depends on our recompilation. The gate checks the canonical codeHash; the
tests run the canonical runtime; the deploy script ships the canonical runtime. Our build earns its
place as an independent cross-check on the ABI and on the source matching the tag, and nothing more.

---

## 6. The execution-model question

**Does the module support the way a Prism member authorizes money?**

This mattered enough to test against the real bytecode rather than reason about, and the answer has
two halves.

### Answer: YES for Prism's shipping authority, via relayed EIP-712

A Circle member's authority is their **existing Mera passkey-derived secp256k1 address** — an
ordinary EOA (`CIRCLES_AUTHORITY_MODEL.md` §2). The member signs the module's EIP-712 transfer hash
off-chain; a Prism relayer submits it. The member holds **MON = 0**, exactly as everywhere else in
Prism.

→ `AllowanceModuleCompat.t.sol::testRelayedEoaDelegateSignatureWorks`.

### Answer: NO for a smart-account delegate — twice over

The brief anticipated `P256 user → PrismAccount UserOperation → PrismAccount.execute(…) →
AllowanceModule.executeAllowanceTransfer(…)`, with `msg.sender` as the delegate. That model does not
work here, for two independent reasons:

**1. v1.0.0 removed EIP-1271.** v0.1.1 accepted contract signatures; the fixed release reverts on
them outright:

```solidity
if (v == 0) {
    revert("Contract signatures are not supported by this module");
}
```

So a contract delegate can never authorize a transfer *by signature* — only by **being the caller**.
→ `testEip1271ContractSignaturesAreRejectedOutright`.

**2. `PrismP256Account` has no generic execute.** The caller path *does* work for a contract that can
make arbitrary calls — `recoverSignature` returns `msg.sender` for an empty signature, and
`testContractDelegateDirectCallWorks` proves it end to end. But Prism's P-256 account exposes only
`pay(token, recipient, amount, nonce, validBefore, r, s)`, which moves its **own** balance. It cannot
call the module at all.
→ `testAPrismP256AccountCannotReachTheModule`.

**This did not require stopping.** The brief's instruction — *if the module expects an EOA-only
signature path and this does not work safely, STOP and keep threshold-only payments* — is about not
faking limits when the authority model is incompatible. Prism's shipping authority **is** an EOA, and
the relayed path works with the member still holding no MON. The incompatibility is real but it is
with a model Prism does not use; it is recorded here so that adopting a contract authority later
confronts it deliberately rather than discovering it in production.

---

## 7. What a delegate can and cannot do

The module's **only** outward instruction to a Safe is a fixed-shape `transfer(address,uint256)` (or
a native send) that it assembles itself. A delegate never supplies calldata. So the four things a
delegate must not be able to do are structural facts, not validations that could be forgotten:

| Attempt | Result | Test |
|---|---|---|
| an arbitrary Safe call | no entry point takes calldata | *testADelegateCannotMakeAnArbitrarySafeCall* |
| change the owner set | the only lever is `token`, which names a `transfer` target | *testADelegateCannotChangeTheOwnerSet* |
| enable another module | spending cannot enable anything; `addDelegate` affects only the caller's own book | *testADelegateCannotEnableAnotherModule* |
| grant an unlimited approval | `approve` never appears in anything the module builds | *testADelegateCannotGrantAnUnlimitedTokenApproval* |

Positively stated and asserted: every call a delegate can cause is `to == the configured USDC`,
`value == 0`, `operation == Call`, and exactly 68 bytes of `transfer` calldata.
→ *testTheOnlyCallADelegateCanCauseIsAPlainTransfer*.

### Two behaviours worth knowing about

**Relayer payment comes out of the member's allowance.** The module can reimburse whoever submits the
transaction, from the *same* allowance, to `tx.origin`. Circles always sends `payment = 0` and
sponsors gas from the relayer instead. `testRelayerPaymentWouldBeChargedToTheMembersAllowance` pins
what the alternative would have cost, so that stays a decision rather than becoming an oversight.

**The reset comparison uses unchecked arithmetic.** `getAllowance` computes
`lastResetMin <= currentMin - resetTimeMin` in Solidity 0.7, where that subtraction does not revert
on underflow. On a chain whose timestamp is smaller than the reset window, every allowance reads as
permanently reset. Not reachable on Monad (timestamps are ~29M minutes), but it silently voids any
test suite that starts at `t = 1` — which is why the suite warps the clock first.

---

## 8. Turning limits on

1. Confirm no official deployment appeared: `node verify-allowance-module.mjs --chain-id 10143`
2. If none, deploy the exact upstream runtime:
   `forge script script/DeployAllowanceModuleV1.s.sol --rpc-url $MONAD_RPC_URL --broadcast`
3. Verify what you deployed: `node verify-allowance-module.mjs --module <address>` — must print
   `RESULT: usable`
4. Configure: `CIRCLE_ALLOWANCE_MODULE=<address>`, `CIRCLE_LIMITS_ENABLED=true`
5. Boot. The server re-verifies and logs `integrity.circleLimits`. In production a failure is fatal.

Each Circle then enables the module for itself through an ordinary threshold-approved transaction —
installing a module on someone's Safe is not something Prism can do on their behalf.

---

## 9. Tests

```
cd contracts && forge test --match-path 'test/AllowanceModuleCompat.t.sol'   # 23, vs REAL bytecode
cd backend   && node --test test/circles-limits.test.js                      # 22, the backend half
cd tools/circles && node verify-allowance-module.mjs                         # the gate itself
```

The division of labour is deliberate. The contract-level guarantees are proven against **Safe's
actual deployed bytecode**, `vm.etch`ed from the canonical capture — not against a recompilation and
not against a mock. The backend suite covers what is Prism's own responsibility: the gate, the
governance flow, the readback, freshness, and routing. Neither suite re-asserts the other's
territory against an imitation of it, which would prove only that the imitation agrees with itself.
