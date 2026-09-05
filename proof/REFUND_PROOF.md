# REFUND / EXPIRY PROOF

**Status: BLOCKED on testnet.** The short-expiry TEST claim and its refund have not been executed
on Monad. No tx hash exists. See `TESTNET_DEPLOYMENT.md`.

## What is proven locally

`contracts/test/PrismClaimVault.t.sol`:

### `testRefundAfterExpirySucceeds`

| | Value |
|---|---|
| Claim expiry | `block.timestamp + 7 days` |
| Time advanced to | `expiry + 1` (`vm.warp`) |
| Sender USDC before funding | `1_000e6` |
| Sender USDC after refund | `1_000e6` — **made whole** |
| Caller | permissionless |

### Ordering and destination

| Test | Asserts |
|---|---|
| `testRefundBeforeExpiryFails` | reverts `NotYetExpired` (MUT-12) |
| `testDoubleRefundFails` | status is `Refunded`, second call reverts `NotFunded` |
| `testClaimAfterRefundFails` | a refunded claim can never be collected (MUT-11) |
| `testRefundDestinationCannotBeChanged` | `refund()` is permissionless but pays only `c.sender` — the caller can never redirect funds |
| `testExpiredEligibilityFails` | an eligibility authorization past its own expiry is refused |

`refund` reads `c.sender` from storage and takes no destination argument, so permissionless calling
is safe by construction: anyone may *trigger* the refund, nobody may *aim* it.

Expiry bounds are enforced at creation: `ClaimService.createPending` clamps `expirySeconds` to
`[3600, 14 days]`, so a "short-expiry TEST claim" can be created at the 1-hour floor but not shorter
— worth knowing before designing the live expiry demo, since it means the refund test cannot be
compressed below an hour without a code change.
