# Save — Eligibility

Upshift (the earnAUSD provider) restricts access for users in some jurisdictions. Save must therefore be
able to say whether a user may use it **before** any real-money deposit — and must fail safe when it
can't. Source: `backend/src/services/saveEligibilityService.js`; tests: `backend/test/save-strategy.test.js`.

## The four states

`SaveEligibilityService.check(prismId)` returns one of:

| State | Meaning |
|---|---|
| `ELIGIBLE` | A determination was made and the user may use real-money Save. |
| `INELIGIBLE` | A determination was made and the user may not. Surfaced as-is, never overridden. |
| `UNKNOWN` | The provider could not determine a result for this user. |
| `SERVICE_UNAVAILABLE` | The compliance check itself is not configured or not reachable. |

## Two rules that must never be broken

1. **No guessing countries.** Eligibility is not a hardcoded country list inferred from a phone prefix
   or an IP. It comes from the accepted upstream compliance mechanism (`provider`), or it is
   `SERVICE_UNAVAILABLE`. Before production, a real provider must be wired.
2. **Silence is never consent.** Real-money Save requires a *positive* `ELIGIBLE` determination.
   `UNKNOWN` and `SERVICE_UNAVAILABLE` both leave real-money Save **off**.

The gate:

```
realSaveEnabled({ substrateVerified, eligibility })
  === (substrateVerified === true && eligibility === 'ELIGIBLE')
```

Both conditions are required. A verified substrate with no eligibility determination does not enable
real deposits; an ELIGIBLE user on an unverified substrate does not either.

## This deployment

No compliance provider is wired here, so `check()` returns `SERVICE_UNAVAILABLE` and the Save home
surface reports it. This is deliberate — the service returns the honest state rather than fabricating an
`ELIGIBLE`. Combined with `substrateVerified = false`, real-money Save is doubly gated off; the announced
preview flow still works end to end.

## Endpoint

`GET /v1/save/eligibility` → `{ status, reason }`. `GET /v1/save/state` also carries an `eligibility`
snapshot and a `realMoneyEnabled` flag computed from the gate above.

## Wiring a real provider

Supply `{ available(): boolean, check(prismId): Promise<'ELIGIBLE'|'INELIGIBLE'|'UNKNOWN'> }`. A provider
that throws or returns an unrecognized value degrades to `SERVICE_UNAVAILABLE` / `UNKNOWN` respectively —
it can only ever make Save *more* restrictive, never fabricate access.
