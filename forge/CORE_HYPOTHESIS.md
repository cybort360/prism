# CORE HYPOTHESIS

> **Human identifiers are useful payment *routes* but unsafe financial *identities*. If PRISM can let
> users pay contacts like a normal fintech app while preserving the *intended recipient identity*
> across alias / device / account changes — and refusing payment when identity continuity breaks —
> then PRISM provides a safer human-addressed payment model than a simple phone-to-wallet mapping.**

The naive model ("map a phone number to a wallet address") fails the moment the phone number moves,
the device changes, or the number is reassigned to a new person. PRISM's claim is that separating
**reachability** from **identity** from **spending authority** from **money location** makes
human-addressed payments both usable *and* safe.

## Explicit thesis-failure conditions

The hypothesis is **falsified** if any of the following is true. Each maps to an invariant in
[`INVARIANTS.md`](INVARIANTS.md) and to evidence in [`PROOF_LEDGER.md`](PROOF_LEDGER.md).

| # | The thesis fails if… | Guarded by |
|---|---|---|
| 1 | the user must understand wallet addresses to pay | consumer UI never surfaces a raw address for a person-payment |
| 2 | the user needs MON to make a supported payment | relayer-sponsored ERC-3009; user holds MON = 0 |
| 3 | phone ownership can independently control money | authority is the Mera passkey account, not the alias/OTP |
| 4 | a raw or deterministic phone-derived mapping becomes public on-chain | no phone value in calldata/events/storage/proof/logs |
| 5 | an alias reassignment silently redirects a payment | discontinuity is visibly blocked/reviewed |
| 6 | a stale resolution stays usable after rotation/revocation | resolution re-verified (aliasVersion + account) at settlement |
| 7 | a mutation after authorization succeeds | recipient/amount/route bound in the signed authorization |
| 8 | a replay succeeds | single-use ERC-3009 nonce; consumed-nonce reconciliation |
| 9 | the frontend marks success before confirmed/reconciled Monad state | UI-terminal only after a reconciled receipt |
| 10 | the backend becomes the canonical balance authority | Monad token state is canonical; backend is a projection |
| 11 | continuity cannot survive a legitimate alias change | same PrismIdentity/account → payment proceeds |
| 12 | a cold user cannot complete a normal payment without coaching | onboarding → pay flow is self-explanatory |

## Status of the hypothesis

**Not yet proven end to end.** The mechanisms for 1–11 exist and most are tested at the unit/contract
level (see [`PROOF_LEDGER.md`](PROOF_LEDGER.md)); #12 (cold-user comprehension) is a UX claim with no
executed evidence yet. Nothing here is `VERIFIED` on the strength of code existing.
