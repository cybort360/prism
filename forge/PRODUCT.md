# PRODUCT — PRISM

PRISM is an **iPhone-native consumer payments product on Monad**. You pay a person the way a normal
fintech app works — from Contacts, an `@handle`, a QR code, or a payment link — and the app hides
wallet addresses, gas, chain selection, and seed phrases.

## Consumer sentence

> **"Send money to people, not wallet addresses."**

This is the surface promise. It is **not** the load-bearing novelty anymore.

## The load-bearing mechanism: Prism Continuity

> **Human identifiers are mutable reachability *routes*, not financial identities or spending
> authority.**

```
HOW I AM FOUND          phone / @handle / QR / link
        ↓
WHO I AM                persistent PrismIdentity
        ↓
WHO MAY AUTHORIZE       device passkey → Mera-derived secp256k1 account
MY MONEY                (the device-backed credential is the root of authority)
        ↓
WHERE MY MONEY LIVES    a Monad account (that same account holds USDC)
```

Every layer is decoupled from the one above it. A phone number, a handle, a QR, or a link is only a
way to be *found*. None of them is a key, a spending authority, or an on-chain identifier.

## Critical invariant (the product's whole point)

**Reachability may change without silently changing recipient identity.**

- A **legitimate alias change** — e.g. the recipient rotates their phone — that still resolves to the
  **same PrismIdentity and account** must **preserve continuity**: the payer can keep paying them.
- An alias that now resolves to a **different PrismIdentity/account** must **never silently redirect**
  a payment. PRISM visibly **blocks and asks the payer to review** the identity discontinuity.

See [`INVARIANTS.md`](INVARIANTS.md) for where each half is enforced and tested.

## What PRISM is

- A consumer wallet-less payments app: person → amount → Face ID / PIN → sent.
- USDC on Monad, gasless for the user (a relayer pays MON; the user can hold MON = 0).
- Send-before-signup (claims), request payments, QR/links, and cross-chain receive/send (Aurora
  Intents, preview mode) — all projecting to one canonical payment model.
- **Prism Circles** — shared money, on the same model.

## Prism Circles

> **"A Prism Circle is a shared USDC account for people who manage money together."**

That is the whole public definition, and it is deliberately not "a joint bank account": a Circle has
no bank, no account number, no overdraft and no institution standing behind it. It is money several
people hold together, with the rule for moving it agreed in advance and enforced outside Prism.

What a Circle is for: a trip everyone is paying into, a household's shared costs, a group buying
something together, a small team with a float. The product question it answers is not "where is the
money" but **"who may move it, and who agreed"**.

- **Roles.** Admins agree how money moves. Spenders can be given a limit and spend inside it.
  Contributors can add money and propose. Viewers can see the Circle and nothing else.
- **Approval policy.** A Circle states how many admins must agree — "2 approvals" — and the number is
  not Prism's to change. Every payment out shows who asked and who agreed.
- **Spending limits.** A member can be given an amount per day, week or month that they spend on
  their own. Going over it is not a refusal: the same payment is offered to the Circle to approve.
- **Money in and out.** Adding money is an ordinary Prism payment whose recipient happens to be the
  Circle. Paying out is an ordinary Prism payment whose payer happens to be the Circle. Both produce
  the same receipt and the same proof as any other payment.
- **Closing.** A Circle ends as a lifecycle, not a delete: everything that happened in it stays
  readable. Prism never decides where a remaining balance goes — the members send it out first.

### What a Circle is NOT

- Not a bank product, and not a joint bank account.
- Not custodial: Prism cannot move a Circle's money, and a Circle survives Prism being gone. The
  people who hold the authority hold it directly.
- Not a place where Prism keeps a balance. A Circle's balance is read from the token contract every
  time it is shown, and reads as *unknown* rather than stale when it cannot be read.
- Not an account a phone number can take over. Being reachable at a number that used to reach an
  admin confers nothing.

The architecture beneath this — the shared-account contract, the approval mechanics, the module that
enforces limits — is technical documentation: `../docs/CIRCLES_ARCHITECTURE.md`,
`../docs/CIRCLES_AUTHORITY_MODEL.md`, `../docs/CIRCLE_PAYMENTS.md`,
`../docs/CIRCLE_SPENDING_LIMITS.md`, `../docs/CIRCLE_LIFECYCLE.md`, `../docs/CIRCLE_RECEIPTS.md`,
`../docs/CIRCLE_PROOF.md`.

## Prism Save

> **"Save turns dollars you already hold into dollars that earn — one approval, and you can take them
> back."**

Save is a bounded consumer savings product, not a DeFi console. The consumer sees only: USDC → Save →
amount → rate → approve → done. Underneath, approved USDC is converted to AUSD and deposited into the
**earnAUSD** vault (Upshift, curated by Gamma Research); a withdrawal redeems back to USDC. The
substrate is real, but it stays underneath the consumer experience — the primary screens never ask the
user to think about vaults, swaps or share prices.

- **What "optimized yield" means (V1).** Prism deposits into the ONE approved strategy (earnAUSD),
  whose curator reallocates within its own policy. Prism does **not** autonomously chase the
  numerically highest APY across arbitrary protocols, and does **not** auto-migrate existing funds.
  Consumer copy: *"Save once. The underlying strategy manages where your savings earn."*
- **Two kinds of dollars, kept separate.** Your Prism balance is USDC (spend/send). Your savings are a
  yield-bearing position (AUSD → earnAUSD). Saving and withdrawing move between them; nothing else does.
- **Variable yield, told truthfully.** The rate is variable and is shown only when it is fresh, with
  its source and window. A stale, zero or negative rate is labeled as what it is — never faked, never
  a promise. Monthly figures are labeled estimates derived from the current rate, never guarantees.
- **Position accounting from chain.** Shares and current value are read from the vault itself (the
  vault's own share→asset conversion); the backend store is a projection only. "Earned" needs a cost
  basis from history; without it the position still shows, and earned reads *unknown* rather than a guess.
- **Withdrawal lifecycle.** Instant (fee-bearing, subject to liquidity) or Standard (queued, up to
  ~72h). A queue running slower than an estimate is *pending*, not a failure. If shares redeem to AUSD
  but AUSD→USDC hasn't completed, the savings are safe with the user in an AUSD recovery state — never
  stranded.
- **Receipts & proof.** Every Save and withdrawal produces a consumer receipt and an evidence-backed
  `PrismSaveProof` (USDC debit, AUSD conversion, earnAUSD shares minted **to the user**, independent
  chain readback) — nothing is called VERIFIED without executed evidence.
- **Eligibility.** Upshift restricts some jurisdictions. Real-money Save requires a positive
  eligibility determination *and* a verified substrate; if eligibility cannot be established, Save is
  not silently enabled.
- **Failure recovery & custody.** If the backend is offline, the user still owns their earnAUSD — the
  position is proven from shares held by the user's own account, not by Prism.

### What Save is NOT

- Not a bank savings account, and not a deposit. Not insured, not FDIC-insured, not guaranteed, not
  risk-free, and not a fixed monthly income. Savings involve stablecoin, smart-contract and underlying
  strategy risk.
- Not a yield aggregator that hops protocols for the highest number. V1 uses one approved strategy.
- Not custodial over the savings position: the earnAUSD shares are owned by the user's account.

Future strategies are architected behind an allowlisted, governed `SaveStrategyRegistry` — added
disabled, enabled only by governance, compared on many factors (net APY, liquidity, withdrawal time,
smart-contract risk, concentration, stablecoin risk, capacity, execution cost) and **never ranked on
raw APY alone**. Nothing beyond earnAUSD is enabled in V1. Technical docs: `../docs/SAVE_MODEL.md`,
`../docs/SAVE_STRATEGY_REGISTRY.md`, `../docs/SAVE_ELIGIBILITY.md`, `../docs/SAVE_ROUTE_SECURITY.md`,
`../docs/SAVE_EXECUTION.md`, `../docs/SAVE_WITHDRAWALS.md`, `../docs/SAVE_ACCOUNTING.md`,
`../docs/SAVE_RECOVERY.md`, `../docs/SAVE_RECEIPTS.md`, `../docs/SAVE_PROOF.md`,
`../docs/SAVE_DEPENDENCY_AUDIT.md`, `SAVE_MATRIX.md`.

## What PRISM is NOT

- Not a "phone → wallet address" registry. There is no public `phone→wallet` or `SHA(phone)→wallet`
  map; no phone-derived value is emitted on-chain.
- Not custodial: the backend is never the canonical balance authority — Monad token state is.
- Not an app that treats "transaction submitted" as "payment delivered."
- **Prism does not expose a generalized DeFi interface. Save is a bounded consumer savings product that
  turns approved USDC into an explicitly approved yield-bearing position while keeping protocol
  complexity underneath the consumer experience.**
- Not (in this build) an ERC-4337 smart-account / raw-P256 signer — that path is archived. See
  [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Related docs (product surfaces)

`../docs/PAYMENT_MODEL.md`, `PAYMENT_LIFECYCLE.md`, `RECEIPTS.md`, `CLAIMS.md`, `PAYMENT_PROOF.md`,
`QR_AND_LINKS.md`, `AURORA_INTENTS.md`, `CIRCLES_PRODUCT.md`, `CIRCLE_RECEIPTS.md`,
`CIRCLE_LIFECYCLE.md`, `CIRCLE_PROOF.md`.

## How to talk about a Circle

| Say | Not |
|---|---|
| a shared USDC account | a joint bank account, a group wallet, a multisig |
| admins agree how money moves | signers, owners, keys, quorum |
| 2 approvals | 2-of-3 threshold, m-of-n |
| a spending limit | an allowance module, a delegate |
| the Circle's account | the Safe, the contract address |

The right-hand column is accurate and belongs in technical documentation and in the Payment Proof
screen, which exists precisely to show the machinery. It does not belong in the app's own words.
