# Aurora Intents — send, spend and receive from any chain

Prism holds one asset on one network: USDC on Monad. That is deliberate — it is what lets the app
hide chains, gas, and token selection from the person using it. Aurora Intents is how value crosses
into and out of that without reintroducing any of it.

This document covers both directions: **receive from any chain** (any token, any network → USDC on
Monad) and **send/spend to any chain** (USDC on Monad → any token on any network, to any address).

## What Aurora is

[Aurora Intents](https://docs.intents.aurora.dev/) sits on top of NEAR Intents. You ask for a
destination — an asset on a chain, delivered to an address — and it gives you a **deposit address**.
Any supported token sent to that address is detected, routed, converted, and delivered. There is no
bridge contract to integrate, no liquidity to hold, and no custody on Prism's side.

Two products exist. Prism uses the first:

- **Intents Deposits** — live, permissionless, API keys issued immediately. Despite the name it is a
  general bidirectional swap router, so it carries both directions on its own.
- **Intents Connect** — richer (contract calls on the destination chain via intermediary accounts,
  which is what "deposit into a pool on Arbitrum and take the yield back on Monad" would need). Its
  API is pre-release and access is email-gated at contact@aurora.dev. **Deliberately not integrated
  — no adapter, no stub.** Revisit with access.

## The constraint that shapes everything

NEAR Intents carries **Monad mainnet (chainId 143)**. It does not carry Monad testnet.

Verified against the live token list:

```
assetId         nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx
blockchain      monad
symbol          USDC
decimals        6
contractAddress 0x754704bc059f8c67012fed69bc8a327a5aafb603
```

That contract address is the one `README.md` lists as Monad **mainnet** USDC. Prism's router and
vault are deployed on **testnet 10143** against testnet USDC `0x534b2f3A…`.

So a route that Aurora quotes cannot settle against this deployment, and a deposit address routes to
the user's account on mainnet rather than to the balance this build reads. `AURORA_MODE` exists to
keep that fact visible rather than papered over.

### `AURORA_MODE`

| | `preview` (default) | `live` |
|---|---|---|
| Quotes | `dry: true` — real routes and pricing, no deposit address | `dry: false` |
| Receive address | real (see below) | real |
| Status polling | real | real |
| UI | every surface carries an explicit unsettled notice | no notice |

`assertSafeConfig()` refuses to boot a production process with `AURORA_MODE=live` and no
`AURORA_APP_KEY`, the same way it refuses a production boot on the dev OTP adapter.

**Why receive addresses are real even in preview.** Generating one is free and idempotent, and the
address routes to *the user's own Mera account* — the same passkey-derived EVM address on mainnet as
on testnet. The funds are genuinely theirs and are not at risk. What it will not do is move the
testnet balance the app displays, so `AuroraService._previewNotice()` says exactly that, naming the
configured chain id, and the app renders it verbatim. The backend owns that wording so it can never
drift from the configuration that produced it.

## API surface (verified against the live service)

Base `https://intents-api.aurora.dev`.

| Call | Endpoint |
|---|---|
| Token list | `GET /api/tokens/{appKey}` |
| Quote | `POST /api/quote/{appKey}` |
| Notify deposit tx | `POST /api/deposit/submit/{appKey}` |
| Status | `GET /api/status/{appKey}?depositAddress=…&depositMemo=…` |
| Persistent address | `POST /api/persistent-deposit-address/{appKey}` |

Persistent address request `{ recipient, sender, depositChain, destinationChain, destinationAsset }`
→ `{ depositAddress, alreadyExists, memo?, correlationId? }`. Deterministic: the same inputs always
return the same address. All EVM chains share one address.

The `appKey` is public by Aurora's own documentation, but Prism keeps it server-side anyway — it
carries the integrator fee configuration, and leaking it lets anyone bill routes against this
account. `test/aurora-privacy.test.js` asserts it never appears in a response body.

**Asset ids are never hardcoded.** They are resolved at runtime from the token list and cached for
60s (`src/aurora/assets.js`). The single pinned fallback is USDC on Monad, because it is Prism's own
asset and sits on one end of every route; anything else fails closed rather than guessing.

## How receiving works

```
any chain / any token
  -> Aurora persistent deposit address        (derived from the user's Mera account)
  -> NEAR Intents routing + conversion
  -> USDC on Monad, at the user's account     (no Prism contract involved)
  -> Envio UsdcTransfer                       (attribution)
```

Prism signs nothing. The deposit address is derived from the user's own account, so there is no
authorization for Prism to give — which is why the inbound path never touches the Mera bridge and
needs no envelope and no signature at all.

### Attribution and the indexer

A routed deposit lands as an ordinary USDC `Transfer` straight to the user's account. It touches
neither `PrismPaymentRouter` nor `PrismClaimVault`, so the existing router/vault transfer filter
cannot see it and there is no Prism event to key off.

`indexer/envio/` therefore gained a `UsdcTransfer` entity that records **every** Monad USDC transfer.
Testnet volume is low and full-token indexing is what HyperSync is for. The existing `VaultTransfer`
filter is untouched. The backend queries it by `to` (`envioIndexer.getIncomingTransfers`).

`GET /v1/aurora/arrivals` returns `indexed: false` when the index is unavailable. That means "we
cannot say what arrived" — never "nothing arrived". The balance shown in the app still comes from an
on-chain read, so it is correct either way.

## Route lifecycle

The routed leg is a **separate** state machine from the Monad payment machine, in
`src/lib/lifecycle.js` as `AURORA_TRANSITIONS`. It is separate on purpose: `ALLOWED_TRANSITIONS`
is audited, and widening it for a different subsystem's states would put that audit at risk.

```
quoted -> funding -> funded -> routing -> delivered
                                       \-> refunding -> refunded
                                        \-> route_failed
quoted/funding -> expired
```

Aurora status → Prism state:

| Aurora | Prism |
|---|---|
| `PENDING_DEPOSIT` | `funding` |
| `KNOWN_DEPOSIT_TX` | `funded` |
| `PROCESSING` | `routing` |
| `SUCCESS` | `delivered` |
| `REFUNDED` | `refunded` |
| `FAILED` | `route_failed` |
| `INCOMPLETE_DEPOSIT` | `requires_attention` |

`INCOMPLETE_DEPOSIT` is deliberately not a failure: the funds are there, just short of the quoted
amount, and a person has to decide what to do.

**Progress is polled, so states are routinely skipped** — a fast route can be observed as `quoted`
and then `delivered` with nothing in between. The guard therefore enforces "never backwards, never
out of a terminal state", not "one step at a time". The app's timeline marks a step reached only
from observed history, so a skipped step is shown as unreached rather than assumed.

An unreachable status service returns `statusKnown: false` and leaves the stored state alone. The UI
then shows "Status unavailable" rather than presenting a stale reading as current.

## Endpoints

All require a session.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/aurora/chains` | routable chains + assets, and whether routes can settle |
| `POST` | `/v1/aurora/deposits/address` | create-or-return a persistent address for a source chain |
| `GET` | `/v1/aurora/deposits` | the caller's addresses |
| `GET` | `/v1/aurora/deposits/:address` | refresh one address against live status |
| `GET` | `/v1/aurora/arrivals` | indexed USDC arrivals at the caller's account |

Every one returns `503` with an explicit message when no `AURORA_APP_KEY` is configured — the same
fail-closed posture as the Envio consumer. None of them ever fabricate a quote, an address, or a
status.

## Privacy

Prism's rule that a phone number is a private alias, and that no phone-derived value is emitted,
holds across the Aurora boundary too. The `sender` field sent to Aurora is the user's **EVM account
address** — never a phone number, never a phone-derived hash, never a Prism identifier.

`test/aurora-privacy.test.js` scans every byte Prism sends to Aurora for the phone number and for
every hash of it an attacker could precompute (sha256/sha1/md5 of four normalizations, base64, and
the peppered lookup key), in the same spirit as `contracts/test/PrismPrivacy.t.sol`. It includes a
self-test that the scanner can actually fail, so it cannot silently match nothing forever.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `AURORA_APP_KEY` | — | public appKey; absent ⇒ every route 503s |
| `AURORA_API_BASE_URL` | `https://intents-api.aurora.dev` | override for testing |
| `AURORA_MODE` | `preview` | `preview` ⇒ dry quotes + unsettled labelling |
| `AURORA_INTEGRATOR_FEE_BPS` | `0` | integrator fee, 0–100; validated at boot |
| `AURORA_DESTINATION_CHAIN` | `monad` | where inbound deposits are delivered |

Fees split 60/40 with Aurora, with a floor: `Aurora fee = max(2bps, 40% of integrator fee)`.

## Testing

```bash
cd backend && node --test test/aurora-*.test.js
cd contracts && forge test --match-path 'test/PrismRouterExternalRecipient.t.sol'
```

`src/aurora/mockAuroraClient.js` is the substitutable fake, injected with
`setAuroraClient(makeMockAuroraClient())` and restored with `resetAuroraClient()` — the same
registry pattern as `setChainProvider` / `setEnvioIndexer`. Deposit addresses are derived
deterministically from their inputs, mirroring the real API's guarantee. Status never advances on
its own: a test that asserts a terminal state has to drive it there explicitly.

The iOS presentation logic (`AuroraDepositDisplay`) is a plain struct with no SwiftUI, covered by
`PrismTests/AuroraDepositDisplayTests.swift`.

## Sending and spending

Send and Spend are **one engine, two framings** — paying a person or paying a merchant differ only
in how the screen reads, so there is one flow, one service, one set of tests.

### How it works

```
USDC on Monad
  -> POST /api/quote           (originAsset = Monad USDC, destinationAsset = <token>@<chain>)
  -> quote.depositAddress      an ordinary EVM address ON MONAD
  -> PrismPaymentRouter.settle(recipient = depositAddress)   the existing gasless path
  -> Aurora converts and delivers on the destination chain
```

Because `depositType: ORIGIN_CHAIN` and the origin asset is on Monad, Aurora hands back a Monad
address. Paying it is an ordinary Prism settlement — so **no Solidity was added for this feature**.
The money leg reuses `submitPayment`, the relayer, `reconcile`, ambiguous-broadcast recovery, and
idempotency exactly as a direct payment does. `paymentService.prepareExternalSend` is the only new
primitive, and it exists because there is no Prism identity on the far side to resolve.

`refundTo` is the sender's own Prism account, so a failed route returns their USDC to the balance
they already have rather than somewhere they have to go and retrieve it.

### `routeHash` — the binding that makes it safe

On its own the envelope would bind only "send N USDC to this address", which says nothing about
where the money is ultimately going. `routeHash` (in `src/chain/eth.js`, beside `resolutionHash`)
folds the rest of the promise into the same opaque envelope slot:

```
{ routeId, depositAddress, destinationChain, destinationAssetId,
  destinationRecipient, minAmountOut, quoteDeadline }
```

The payer's one Face ID approval therefore authorizes the whole deal. If the backend — or anyone who
compromised it — rewrote the destination chain, the token, the recipient, or the guaranteed minimum
after the user signed, the recomputed hash differs, `ecrecover` returns a different signer, and
`settle()` reverts. This is decision #10 extended across the bridge rather than weakened for it, and
`contracts/test/PrismRouterExternalRecipient.t.sol` pins it at the contract level.

Every string field is hashed, so no destination address, chain name, or asset id reaches the chain in
the clear. The address is lowercased before hashing, so the casing a user happened to paste cannot
change the binding.

The residual trust is that `depositAddress` really came from Aurora, which cannot be proven on-chain.
Aurora's quote `signature` and `correlationId` are stored on the route and exposed, so "this address
came from this signed quote" is checkable after the fact rather than asserted.

### Two independent legs

A confirmed Monad transaction is **not** delivery. The payment operation and the route are separate
records with separate state machines, and neither derives its state from the other:
`reconcileRoute` reconciles the Monad leg from chain truth, then asks Aurora about the routed leg,
and advances the route only on what Aurora actually reports.

### Guards worth knowing about

- **The quote deadline is re-checked at submit**, not only at prepare. A user can sit on the approval
  sheet; funding a lapsed quote would send real money into a route Aurora may no longer honour at the
  price they were shown. A stale quote is refused and the route marked `expired` — never silently
  re-quoted.
- **Preparing twice resumes the same payment.** A second prepare would otherwise mint a second
  signable envelope against one quote, and only one of them is the payment anyone is tracking.
- **The destination address is validated before quoting**, so a malformed address is caught while it
  is still cheap to fix rather than after a signature exists. Chains Prism cannot fully verify report
  `addressVerified: false`, and the app warns rather than implying the address was proven good.
- **In preview mode a route is priced but not fundable.** `dry: true` means Aurora issues no deposit
  address, so `prepareSend` refuses with that reason and no payment operation is created. The app
  shows the real price with approval blocked and the reason named.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/aurora/quote` | price a route; commits nothing |
| `POST` | `/v1/aurora/send/prepare` | freeze the quote into signable payloads |
| `POST` | `/v1/aurora/send/submit` | verify both signatures, relay the Monad leg |
| `GET` | `/v1/aurora/routes` | the caller's routes |
| `GET` | `/v1/aurora/routes/:id` | reconcile both legs |

No indexer change was needed for the outbound leg: it emits the same `PaymentSettled` event, already
indexed as a `Payment` and an `AccountActivity` row.

### In the app

`SendToAnywhereView`, reached from the send picker — paying someone on another network is still
"send money", so it is not hidden behind a separate entry point. `PaymentCoordinator.sendCrossChain`
mirrors `pay` state-for-state, so `OperationStateOverlay` works unchanged, and
`MeraAccountService` needed **no change**: `signTypedData` is already generic EIP-712 and the domain
is Monad's either way.

The user is always shown `minAmountOut` ("At least 0.0199 ETH on Arbitrum"), never the `amountOut`
forecast. `AuroraRouteDisplay.blockedReason` names every reason approval is unavailable, so the
button is never merely disabled.
