# Circle Payment Proof

The same proof surface every Prism payment has, with one more section. `GET /v1/payments/:id/proof`
serves a Circle payment exactly as it serves a personal one — a skeptic inspecting a payment should
not have to know which kind it is.

What changes for a shared account is not the standard of evidence. It is *where the evidence comes
from*, and the split below is the whole point of this document.

---

## 1. Canonical evidence

| Question | Authoritative source | **Not** |
|---|---|---|
| Does the proposal exist, and who signed it? | Safe Transaction Service — **coordination only** | — |
| Who are the admins, and how many approvals does it take? | the **Safe contract** (`getOwners`, `getThreshold`) | Prism's mirror |
| What is in the Circle? | the **USDC contract** on Monad (`balanceOf`) | a number Prism kept |
| Did the payment happen? | the **Monad receipt** + the USDC `Transfer` log inside it | a successful submission |
| Did the Safe run *this* transaction? | the Safe's own `ExecutionSuccess` for this digest | `receipt.status == success` |
| What is a member's limit? | the **Allowance Module** (`getTokenAllowance`) | Prism's activity, summed |
| Who is the human recipient? | **Prism resolution** (the Protected Alias Resolver) | an address someone typed |
| Is it indexed? | the existing Prism evidence pipeline (Envio) | — |

### The Safe Transaction Service is never execution evidence

It carries a proposal between phones and collects signatures. It is a coordination service, and it
can be wrong, stale, or unavailable without any of that changing what happened on Monad. So it
appears in the proof's evidence list **by name**, with its own status:

```
proposalCoordination   status: "coordination"   source: "safe transaction service"
  "used to share the proposal and collect signatures; never treated as evidence of execution"
```

`coordination` is a distinct status precisely so a reader can see that the distinction was made,
rather than having to trust that it was. The same discipline runs in the code: `_collectApprovals`
treats a Transaction Service confirmation and a locally stored approval **identically** — both are
signature *claims* until `verifyApproval` recovers them against the Safe's live owner set.

### A second honest status: `not_applicable`

A Safe transfer is not a router `PaymentSettled` event, so Prism's Envio index has no row for it.
Reporting `pending` would imply a row that is late; reporting `fail` would imply one that is missing.
The truthful answer is that this evidence pipeline does not cover this transaction:

```
envioIndex: "not_applicable"
```

---

## 2. The SHARED ACCOUNT section

```
CIRCLE            Lagos Trip
SHARED ACCOUNT    0x1BEc…623D
ASSET             USDC
AUTHORITY         Shared                       (Delegated for a limit spend)
POLICY            2 of 3 admins                (read from the Safe; absent if it could not be read)
PROPOSER          Octane
APPROVALS         Octane · Verified
                  Tobi · Verified
SAFE TX HASH      0x…
SAFE NONCE        3
BALANCE BEFORE    $800.00
BALANCE AFTER     $320.00
USDC TRANSFERRED  $480.00
RECIPIENT         0x…                          (the resolved Prism recipient's account)
MONAD TX          0x…
BLOCK             38,420,119
USER GAS          $0.00                        only when sponsorship was proven; otherwise "Unknown"
SETTLEMENT        Confirmed
PRIVACY           Raw phone on-chain: No       (or Unknown — never assumed)
```

Field by field, where each comes from:

| Field | Source | If it cannot be read |
|---|---|---|
| `policy`, `owners`, `threshold` | Safe contract at proof time | `policySource: "unavailable"`, `policy: null` |
| `balance.before` / `.after` | USDC contract, recorded either side of execution | null |
| `balance.current` | USDC contract, at proof time | null |
| `transfer` | the `Transfer` log in the execution receipt | null |
| `approvals` | signatures verified against the digest; on a settled payment, the set the **Safe itself accepted** at execution | `[]` |
| `allowance` | the Allowance Module (limit spends) | null |
| `binding` | the digest re-derived from the stored fields | `ok: false`, with reasons |

A **contribution's** proof is the ordinary payment proof — it settles through the Prism router, so
its evidence is the router operation's — with the Circle section added. Building a second evidence
path for it would be exactly the duplication this design refuses.

---

## 3. Verification

| Check | Establishes | Source |
|---|---|---|
| `monadReceipt` | the transaction was mined and succeeded | Monad |
| `blockConfirmation` | the block it landed in | Monad |
| `safeExecution` | the Safe emitted `ExecutionSuccess` **for this digest** | the Safe |
| `usdcTransfer` | a `Transfer` from the Circle to the reviewed recipient, for the exact amount | the USDC contract |
| `ownersReadback` | the admin set on the proof is the Safe's | the Safe |
| `thresholdReadback` | the approvals rule on the proof is the Safe's | the Safe |
| `balanceReadback` | the balance on the proof is the token's | the USDC contract |
| `allowanceReadback` | the limit on the proof is the module's | the Allowance Module |
| `envioIndex` | — | `not_applicable` (see above) |

`safeExecution` matters because Safe swallows a failing inner call: the outer transaction succeeds
and the Safe emits `ExecutionFailure`. A backend that trusted `receipt.status` would report a payment
that never happened. `reconcilePayment` refuses to reach `RECONCILED` without all three of receipt,
`ExecutionSuccess`, and the matching `Transfer`.

`proofStatus` reaches `verified` only when the receipt succeeded, the privacy detector **proved**
there is no prohibited identifier on-chain, and at least one independent readback passed. With no
phone bound to either party there is nothing to search for, so the detector honestly reports
`unknown` and the proof stops at `partially_verified` — absence cannot be proven for a value that
does not exist.

---

## 4. Identifier privacy

The same real detector the personal proof runs, over the **Safe transaction's own fields**:

```
safe · to · value · data · operation · nonce · safeTxHash · recipient · amount
```

plus every topic and data word of every log in the execution receipt. The prohibited values are
built from the actual identities involved — the recipient's and the proposer's raw phone (decrypted
only to search for it, never returned) and their phone-derived lookup keys.

`rawPhoneInCalldata: "no"` is reported only when a scan actually ran against at least one prohibited
value and found nothing. Otherwise: `unknown`.

Proven in `circles-evidence.test.js` (*PROOF 7*), which binds real phones to both parties and then
searches the Safe transaction, the execution receipt's logs, the canonical payment, the receipt and
the proof for the number, its digits and its lookup key.

---

## 5. The ten proofs

Every one is an assertion that a number Prism **shows** equals the same number read independently
from the chain's own state — never against another Prism value.

| # | Claim | Test |
|---|---|---|
| 1 | displayed balance == `USDC.balanceOf(safe)` | *PROOF 1-3* |
| 2 | displayed owners == on-chain owners | *PROOF 1-3* |
| 3 | displayed threshold == on-chain threshold | *PROOF 1-3* |
| 4 | displayed allowance == the module's allowance | *PROOF 4* |
| 5 | the Safe transaction was executed (`ExecutionSuccess` for this digest) | *PROOF 5-6* |
| 6 | the USDC `Transfer` names the right recipient and amount | *PROOF 5-6* |
| 7 | no phone or phone-derived key in public transaction data, receipt or proof | *PROOF 7* |
| 8 | every approval recovers to an address that is an owner **right now** | *PROOF 8-9* |
| 9 | a removed admin's signature stops counting, with nobody telling Prism | *PROOF 8-9* |
| 10 | the receipt references the execution that actually happened, and cannot be forged | *PROOF 10* |

All ten run against `circles-harness.js` — an in-memory Monad that implements Safe's real
`execTransaction` rules (digest recomputed from the arguments it was handed, every signature
recovered, ascending owner order, current ownership, its own nonce) over a single USDC ledger shared
with the Prism router. Prism's Safe encoding is never used to check Prism's Safe encoding.

**Not claimed:** no Circle payment has been broadcast to live Monad. These are harness results, not
mainnet or testnet results — see `forge/PROOF_LEDGER.md` for what is and is not proven on a real
chain.

## 6. Where the code is

| Piece | File |
|---|---|
| Circle proof assembly | `backend/src/services/proofService.js` (`_canonicalCircle`, `_circleSection`) |
| The evidence bundle | `backend/src/services/circleService.js` (`evidenceFor`) |
| Execution evidence | `backend/src/circles/safeCircleAdapter.js` (`verifyExecutionEvidence`) |
| iOS proof model | `ios/Prism/Models/PrismProofModel.swift` (`CircleProof`) |
| iOS proof section | `ios/Prism/Features/Receipts/PaymentProofView.swift` (`sharedAccount`) |
