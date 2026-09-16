# SAVE — Receipts & Activity

Save is inspectable through the same truth/evidence philosophy as Prism payments: the consumer receipt
stays in plain money terms, and the substrate lives under Technical details / Proof.

## Save receipt (consumer)

After a successful deposit:

```
SAVE RECEIPT
$500.00  Saved
From              Prism balance
Amount invested   $499.xx
Status            Active
Current value     $xxx.xx
Created           Sep 10, 2026
[ Save Proof ]
```

The normal receipt **never leads with** `USDC → AUSD → earnAUSD`. That conversion, the shares, the vault
and the transaction all live under **Technical details**:

```
Source asset      USDC
USDC spent        500.00
Conversion        USDC → AUSD
AUSD received     499.xx
Savings position  earnAUSD
Shares received   xxx.xxxxxx
Vault             0x…
Network           Monad
Transaction       0x…
```

## Activity

Save deposits and withdrawals are real money movements and appear as rows (`activityService`,
`sourceType: 'save'`):

```
Saved                 -$500.00   Completed
Withdrawal            $200.00     Processing
Savings withdrawal    +$199.xx    Available
```

**Yield accrual never creates rows.** Earnings are position appreciation (the share value rising), not a
daily Prism payment — so there are no daily "interest" transactions. Only actual `SAVE` / `WITHDRAW`
operations project into Activity.

## Source of truth

Every value on the receipt comes from the reconstructed position + the operation record — `Current value`
is the vault's own share→asset conversion, `Amount invested` is the **actual** AUSD deposited (not the
quote), and `Status` is the operation's real state. Nothing is shown as final until reconciled from chain
evidence. Full evidence lives in the [`SAVE_PROOF.md`](SAVE_PROOF.md) surface.

## Tests

`backend/test/save-proof.test.js`: the receipt fields come from a real operation; Activity projects a
deposit + a withdrawal row and **no** daily yield rows.
