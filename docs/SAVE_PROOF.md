# SAVE — Proof

`PrismSaveProof` is the evidence-backed, judge-inspectable record for one Save operation — the Save analog
of the canonical Payment Proof. Built in `backend/src/lib/saveProof.js` (`buildSaveProof`), served at
`GET /v1/save/operations/:id/proof` for an operation the caller owns.

## PrismSaveProof fields

`operationId · positionId · network · ownerAccount · inputAsset · inputAmount · conversionProvider ·
quotedAUSD · actualAUSD · minimumAUSD · vault · shareToken · sharesQuoted · sharesActual · minimumShares ·
sharePriceAtDeposit · transactionHash · blockNumber · gasSponsored · stateReadback · txCorrelates ·
evidence[] · verification[] · complete`

`quotedAUSD`/`sharesQuoted` are recorded next to `actualAUSD`/`sharesActual` so the quote can be compared
to what actually executed — but verification only ever uses the **actual** observed values.

## Proof screen

```
SAVE PROOF
SOURCE            $500.00 USDC
CONVERSION        USDC → AUSD · Route [actual provider] · AUSD received $499.xx
SAVINGS POSITION  earnAUSD · Shares received xxx.xxxxxx · Owned by Your Prism account
SETTLEMENT        Monad · Transaction 0x… ↗ · Status Confirmed
VERIFICATION      USDC debit          Verified
                  AUSD conversion     Verified
                  earnAUSD shares     Verified
                  Share ownership     Verified
                  Independent readback Verified / unavailable
```

## Verification — never Verified without evidence

Each check is `verified` (evidence proves it), `failed` (evidence contradicts it), or `unavailable` (the
evidence needed hasn't been observed). The rules:

- **usdc_debit** — the tx succeeded and USDC was debited.
- **ausd_conversion** — AUSD received ≥ `minimumAUSD`.
- **earnausd_shares** — shares minted ≥ `minimumShares`.
- **share_ownership** — the shares were minted to the **owner's** account.
- **independent_readback** — an independent chain read shows the shares (see canonicality below).

**Correlation:** if the evidence's transaction hash doesn't match the operation's (`txCorrelates: false`),
the whole proof is `failed` — a proof must be about the operation it claims. A proof is `complete` only
when the tx succeeded, correlates, and every evidence-backed check (excluding the readback) is `verified`.
With **no evidence**, everything is `unavailable` and `complete` is false — acceptance of a quote is never
proof.

## Yield proof (Savings Details)

`POSITION VALUE`: shares, current share value, current AUSD-equivalent value, principal, earned, the
source of the current rate (Upshift/Agora) and an `observed` timestamp. The variable APY is shown with its
window and is **never** presented as a promise (see `SAVE_ACCOUNTING.md`).

## Canonicality

Envio (if used) helps **query history** — it does not *determine* share ownership, position value, or
withdrawal completion. Those facts are canonical only when backed by an indexed canonical event/state, and
a **direct chain read remains available for verification** (`stateReadback`, the vault's own share/value
read). The proof's `independent_readback` uses that direct read, never the indexer as the source of truth.

### Envio indexing (pending ABI verification)

Extending the Envio indexer to track Save events (USDC Transfer, AUSD Transfer, earnAUSD Deposit/Withdraw,
WithdrawalRequested/Processed, earnAUSD share-token Transfer) requires the **exact live earnAUSD event
signatures** — which are **not yet verified** (the vault's ABI is unverified and mainnet-only; see
`SAVE_DEPENDENCY_AUDIT.md`). Per the "do not assume generic ABI signatures" rule, the indexer is **not**
extended against assumed signatures; it lands once the real event signatures are confirmed. Until then the
canonical readback is the direct chain read above.

## Tests

`backend/test/save-proof.test.js`: real operation → complete/verified proof; quote≠actual (both shown,
actual used); wrong tx hash → correlation fails; wrong owner → share_ownership fails; below-minimum →
fails; **no evidence → nothing verified**; delayed readback → unavailable but evidence-backed facts stay
verified; identical reconstruction after restart; service ownership + 404.
