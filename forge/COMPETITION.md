# COMPETITION — positioning

How PRISM differs from the obvious alternatives in a Consumer Products & Payments track. The point is
the **mechanism**, not the surface.

## The category everyone builds
"Pay a phone number / username → we look up a wallet address → we send." This is the naive model.
PRISM's thesis is that this model is *unsafe as an identity system* even when it's convenient.

## Where the naive model breaks (and PRISM doesn't)

| Situation | Naive "phone → wallet" | PRISM (Prism Continuity) |
|---|---|---|
| Recipient changes phone number | mapping stale or lost; may point nowhere | same `PrismIdentity`/account → payment still works (INV-C1) |
| Old lookup cached | can send to a stale target | stale resolution rejected at settlement (INV-C2) |
| Number reassigned to a new person | **silently pays the wrong person** | blocked for review as a discontinuity (INV-C3) |
| Phone SIM-swapped / OTP phished | phone can move money | phone is reachability only; money needs the passkey account (INV-A1) |
| Privacy | often a public phone↔wallet map | no phone value on-chain, ever (INV-P1) |
| "Sent" feedback | often optimistic on submit | never terminal before a reconciled Monad receipt (INV-M1) |

## Differentiators
- **Continuity as a first-class, testable invariant**, not an afterthought.
- **Reachability decoupled from authority decoupled from money location** — a phone/handle/QR/link is
  only a way to be found.
- **Consumer-grade UX** (no addresses, no gas, no chain choice) over a **rigor-grade** proof surface
  (in-app Payment Proof; `/forge` control plane).
- **Gasless** (user holds MON = 0) and **send-before-signup** claims for real network effects.

## Honest weaknesses vs. competitors
- No live cold-user validation yet (UX-1 `UNTESTED`).
- Live on-chain e2e not re-verified this phase (CHAIN-2 `UNTESTED`).
- Cross-chain is preview-only (dependent on an external pre-release API).

See [`CORE_HYPOTHESIS.md`](CORE_HYPOTHESIS.md) for the falsifiable claim and
[`PROOF_LEDGER.md`](PROOF_LEDGER.md) for what's actually proven.
