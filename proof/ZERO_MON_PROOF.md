# ZERO-MON PROOF

The claim: a user can hold AUSD > 0 and MON = 0 and still pay, because a MON-funded relayer submits
the transaction.

**Status: proven in the local EVM; NOT yet proven on Monad testnet** (no deployment, no relayer —
see `TESTNET_DEPLOYMENT.md`).

## Local proof

`contracts/test/PrismPaymentRouter.t.sol::testPayerOwnsZeroMon`:

```solidity
function testPayerOwnsZeroMon() public {
    assertEq(payer.balance, 0, "payer holds no MON");
    _settle(_env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(2))));
    assertEq(ausd.balanceOf(recipient), 25e6);
}
```

| | Before | After |
|---|---|---|
| Payer native MON | `0` | `0` (never touched) |
| Payer AUSD | `1_000e6` | `975e6` |
| Recipient AUSD | `0` | `25e6` |
| Gas paid by | `relayer` (`vm.prank(relayer)`) | |

The payer's native balance is asserted to be exactly zero *before* settlement, and the settlement
still succeeds — the payer never signs a transaction, only two EIP-712 payloads. The same holds on
the claim path: `PrismClaimVault.fundClaim` is funded via ERC-3009 `receiveWithAuthorization`, so a
sender with zero MON can escrow money for someone who has not joined yet.

## Why the architecture supports it

- `PrismPaymentRouter.settle` is `external` and takes the payer's signatures as arguments. `msg.sender`
  is the relayer and is never compared to `env.payer`.
- The relayer is confined: `backend/src/chain/relay.js` allows only `settle`, `fundClaim`, `claim`,
  and `refund` on an allowlisted router/vault with an allowlisted token, with fixed argument shapes.
  It cannot be steered into arbitrary calldata or an arbitrary destination.
- Alchemy Gas Manager is the documented production alternative to the self-funded relayer.

## What is not proven

Nothing has been submitted to Monad. `RELAYER_PRIVATE_KEY` is empty and unfunded. To prove this
live, read `eth_getBalance(payer)` = `0` and `AUSD.balanceOf(payer)` > `0` immediately before the
settle tx, then re-read both plus the recipient's balance from an independent RPC after the receipt.
