# Payment Proof

The one rule: **Payment Proof makes Prism's invisible architecture inspectable — it is not a
blockchain debugger.** A skeptical reviewer opens one payment and answers seven questions:

1. Did real value move?
2. Did Prism actually resolve a human identity?
3. Was the sensitive phone identifier exposed on-chain?
4. Did the user need MON?
5. Was the payment really confirmed on Monad?
6. Can I inspect the transaction myself?
7. Was this data independently read / indexed?

Every answer is backed by an **evidence mechanism at a recorded evidence level** — never by asserting
what the architecture *intends*. When a check has not actually run, the answer is **Unknown**, not a
convenient green badge.

## Surfaces

- **Entry** — `PaymentDetailsView` → "Payment Proof · See how Prism verified this payment →". A
  secondary evidence surface, deliberately kept out of the normal Home flow.
- **`PaymentProofView`** (iOS) — renders the canonical proof. It performs **no raw RPC**; it only
  reads the assembled proof from the backend.
- **`GET /v1/payments/:paymentId/proof`** — returns the canonical proof for an operation the
  authenticated caller owns/can see. The `paymentId` maps to a Prism operation; the endpoint never
  trusts an arbitrary user-supplied transaction hash.
- **`ProofService`** (backend) — assembles evidence from the persisted operation + Monad
  receipt/logs + an independent chain readback + the Envio index (if configured) + resolver evidence
  + the privacy detectors.

## What is proven

| Question | Mechanism | Evidence type |
|---|---|---|
| Value moved | Monad receipt status = success; recipient balance ≥ amount | `transactionReceipt`, `balanceDelta` |
| Human resolved | Signed resolver attestation (opaque, no phone), alias version | `resolutionAttestation` |
| Phone not on-chain | Prohibited-value scan of **actual** calldata + event fields; contract-source audit for storage | `privacyCalldataCheck`, `privacyEventCheck`, `contractSchemaCheck` |
| No MON needed | Relayer submitted the tx (`receipt.from == relayer`); sender MON = 0 | (gas section) |
| Confirmed on Monad | Mined receipt + block number | `transactionReceipt`, `blockConfirmation` |
| Inspectable | Public explorer link to the tx | (settlement section) |
| Independently read | Second chain read (Alchemy), Envio index, balance delta | `alchemyReadback`, `envioIndex`, `balanceDelta` |
| Request honoured | `requestId` hashed **inside** the signed settlement envelope | `requestBinding` |
| Claim lifecycle | Dual-signature eligibility, protection, delivery / refund-to-sender | `claimState` |

## What is NOT proven

- **Local approval method (Face ID vs PIN)** is a device-side gate the backend never observes; the
  proof reports the method honestly as unknown-to-server and the app fills it from the device setting.
- **Event privacy at runtime without logs**: when no on-chain logs are available to scan, the event
  check is **Unknown**, and the "no sensitive identifier on-chain" answer rests on the calldata scan
  plus the contract-source audit — never on runtime event evidence that wasn't gathered.
- **Envio indexing** is a non-blocking projection. `not_configured` and `pending` are distinct from
  `indexed`; a delivered payment is never downgraded because Envio is behind.
- Anything at **E4/E5** — Payment Proof never auto-claims independent reproduction or mainnet
  verification.

## Privacy methodology (identifier privacy)

The sensitive value is the recipient's (and sender's) **phone number** and its **phone-derived
deterministic key** (`phoneLookupKey = HMAC(pepper, E.164)`). The detector:

1. Builds the **prohibited set** from the actual identities: each side's raw phone (decrypted **only**
   to search, never returned) and its `phoneLookupKey`, plus the claim's `recipientPhoneLookupKey`.
2. Reconstructs the **actual calldata field values** for the allowlisted contract call
   (`settle` / `fundClaim` / `claim` / `refund`) and scans every field for any prohibited value.
3. Scans the **event fields** (topics + data) of the confirmed receipt's logs when available.
4. Records `contractSchemaCheck` from the audited router/vault source: they emit and store only
   `{id, addresses, amount, opaque refs}` — no phone-derived field.

Outcomes:

- `calldata`/`event` check ∈ `pass | fail | unknown`. A match ⇒ **fail**.
- Consumer answer **"Sensitive identifier on-chain: No"** only when the calldata scan passed **and**
  either the event scan passed **or** the schema audit substantiates the (absent) logs. Otherwise
  **Unknown**. A match anywhere ⇒ **Yes**.

Regression guarantee: if a phone number or phone-derived hash ever appears in a calldata or event
field (e.g. a `resolutionHash` accidentally derived from the phone), the scan **fails** and the proof
status can never read Verified. This is enforced by tests, including one that injects a real phone
into a calldata field and asserts failure.

## Evidence levels

| Level | Meaning | When Prism assigns it |
|---|---|---|
| E0 | Unverified claim | No confirmed transaction |
| E1 | UI / demo fixture | iOS demo/preview data (`demo: true`) — capped here, never a live badge |
| E2 | Local reproducible test | Confirmed tx, no independent readback |
| E3 | Testnet transaction + independent readback | Confirmed receipt **and** an independent read/index/delta passed |
| E4 | Repeated / independently reproduced | **Never auto-assigned** |
| E5 | Production / mainnet independent verification | **Never auto-assigned** |

Local unit tests are **not** live evidence and never raise the level above E2.

## Proof status

`verified` requires: state completed **and** Monad receipt pass **and** calldata clean
(`sensitiveOnchain == no`) **and** at least one independent readback pass. `partially_verified` when
the receipt or the privacy scan holds but not all three. `pending` before completion. `unknown` on a
failed/reverted operation or when the core checks could not run. `demo` for fixtures.

## Trust boundaries

- The endpoint authorizes by **operation ownership** (`senderPrismId` / `recipientPrismId`); one user
  can never read another's proof (enforced by test).
- The backend is the single source of truth for status/level; the app only renders.
- Spending authority is the **Mera passkey account signature** verified server-side. An OTP or an
  alias **never** authorizes spending (`otpForSpending: no`), and the proof says so.
- Gas is paid by the **relayer**; funds in a refund always return to the **original sender** — both
  contract-enforced, not chosen by any caller.

## Share proof

`Share proof` exports a plain-text summary: paymentId, network/chain, asset, amount, tx hash, block,
explorer URL, proof status, evidence level, and the list of evidence `type: status [level]`. It
**never** contains a phone, OTP, PIN, resolution secret, private key, or passkey material (enforced
by test).
