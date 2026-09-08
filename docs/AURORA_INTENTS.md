# Aurora Intents — receive from any chain

Prism holds one asset on one network: USDC on Monad. That is deliberate — it is what lets the app
hide chains, gas, and token selection from the person using it. Aurora Intents is how value crosses
into and out of that without reintroducing any of it.

This document covers **Phase 1: receive from any chain**. Send/spend to any chain is designed but
not yet built; the closing section says what it will reuse.

## What Aurora is

[Aurora Intents](https://docs.intents.aurora.dev/) sits on top of NEAR Intents. You ask for a
destination — an asset on a chain, delivered to an address — and it gives you a **deposit address**.
Any supported token sent to that address is detected, routed, converted, and delivered. There is no
bridge contract to integrate, no liquidity to hold, and no custody on Prism's side.

Two products exist. Prism uses the first:

- **Intents Deposits** — live, permissionless, API keys issued immediately. This is what Phase 1 is
  built on.
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
authorization for Prism to give — which is why `AuroraService` never touches the Mera bridge and why
this phase needed no envelope, no contract change, and no new signing primitive.

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
cd backend && node --test test/aurora-receive.test.js test/aurora-privacy.test.js
```

`src/aurora/mockAuroraClient.js` is the substitutable fake, injected with
`setAuroraClient(makeMockAuroraClient())` and restored with `resetAuroraClient()` — the same
registry pattern as `setChainProvider` / `setEnvioIndexer`. Deposit addresses are derived
deterministically from their inputs, mirroring the real API's guarantee. Status never advances on
its own: a test that asserts a terminal state has to drive it there explicitly.

The iOS presentation logic (`AuroraDepositDisplay`) is a plain struct with no SwiftUI, covered by
`PrismTests/AuroraDepositDisplayTests.swift`.

## Phase 2 — send & spend to anywhere (designed, not built)

The mechanism needs **no contract change**. `PrismPaymentRouter.settle()` pulls USDC via ERC-3009
and forwards to `env.recipient`, and `env.resolutionHash` is an opaque `bytes32` the contract only
re-emits. So an outbound route is an ordinary Prism payment where:

- `env.recipient` = Aurora's quoted `depositAddress` (an EVM address on Monad)
- `env.resolutionHash` = a `routeHash` binding `{ routeId, depositAddress, destinationChain,
  destinationAssetId, destinationRecipient, minAmountOut, quoteDeadline }`

That extends key decision #10 across the bridge: the user's one signature authorizes "send N USDC to
this deposit address **for this exact route**", and a backend that swapped the destination after
signing produces a different hash and invalidates the envelope. Same relayer, same gasless path,
same `PaymentSettled` event the indexer already handles, and no indexer change for the outbound leg.
