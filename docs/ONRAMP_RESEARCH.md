# Add money: fiat on-ramp research

Date: 2026-09-22. Question: how should "Add money" let a normal user buy USDC with a card or
bank, delivered into their Prism account on Monad, without showing them a blockchain?

## Prism constraints that shape the choice
- Consumer app. No chain, token, or address shown to the user. Add money should feel like a top-up.
- **Nigerian user base. NGN (Naira) support is required.** The provider must take Naira via the rails
  Nigerians actually use: bank transfer and instant P2P transfer first, mobile money, then card.
- Balance asset is USDC. Account lives on Monad (testnet 10143 today, mainnet 143 in production).
- Passkey-first (Mera). A passkey-native provider fits the ethos.
- Money-safe: no fake success. The balance updates only after the deposit really settles.
- Save uses AUSD, so a provider that also handles AUSD on Monad is a bonus.

## Naira changes the answer
Naira is the deciding constraint. Ramp Network, MoonPay, and (largely) Transak are strong in
US/EU/UK but thin or absent in Nigeria, so they are not the answer for a Naira user base. What
matters in Nigeria is local rails: NGN bank transfer, instant P2P transfer, and mobile money.

**Best fit: Onramper + Yellow Card.** Yellow Card is Africa's leading stablecoin on/off-ramp (20
countries including Nigeria, 1.7M+ users). Onramper aggregates Yellow Card's local NGN payment
methods (bank transfer, mobile money, instant P2P) AND delivers into the Monad ecosystem, through a
single API. So one integration gives Naira in and USDC on Monad out. NGN to USDC via Yellow Card
rails runs around 1% and settles in hours.

**Naira-native alternatives (fewer middlemen, worth pricing against Onramper):**
- **Fonbnk** - server-to-server on-ramp API, mobile-first Africa, listed on Monad. Supports NGN.
- **Alchemy Pay** - NGN bank transfer on-ramp across major Nigerian banks.
- **Switch** - API, USDC on Monad, Africa coverage.
- **Paychant / HoneyCoin** - African stablecoin ramps (bank transfer, mobile money).
Local consumer apps (Roqqu, Quidax, Breet) take Naira but are not embeddable infrastructure.

## Key finding
Monad has real fiat on-ramp support now. Buying USDC on Monad with a card or bank is possible
today through several providers. This is different from the Save substrate gap: on-ramps deliver real
USDC on Monad mainnet.

## Blink (what your friend shared)
Blink is a crypto deposit SDK, not a fiat on-ramp. It lets users deposit existing crypto with
passkeys instead of addresses or chains, and it now has native USDC and MON routes on Monad
(136+ tokens, 45+ chains, worldwide). Useful for the crypto-deposit path (the flow currently behind
the Settings toggle), not for "buy with card." Keep it on the list for that separate path.

## Shortlist for the fiat on-ramp

| Provider | Fiat to USDC on Monad | Integration | Coverage | Notes |
|---|---|---|---|---|
| **Ramp Network** | Yes, USDC and AUSD | Widget + API/SDK | 150+ countries, US/EU/UK | Passkey-secured, one-time KYC, self-custodial. Closest ethos match; also covers AUSD (Save). |
| **Onramper** (aggregator) | Yes, routes to Monad ramps | One API over 30+ ramps | 190+ countries, 130+ methods | Best coverage and resilience; auto-routes to the best ramp per user. One integration, many providers. |
| **Coindisco** (aggregator) | Yes | Widget + white-label API | 240+ countries | Alternative aggregator. |
| **Transak** | Listed on Monad | Widget + API | 150+ countries | Major, well-documented developer toolkit. |
| **MoonPay** | Listed on Monad | Widget + API | US/EU/CA/LATAM/APAC/Africa | Card, Apple Pay, PayPal, Venmo. |
| **Calm** | Yes, settles USDC on Monad | Embeddable React | US/EU/UK | Bank rails (ACH/wire, SEPA, Faster Payments). |
| **Switch** | Yes, USDC + USDT0 | API | Europe, UK, Africa, APAC, India | Strong emerging-markets bank/mobile-money payout. |

Direct providers (Calm, Switch, Unifold) settle straight to USDC on Monad. Aggregators (Onramper,
Coindisco) give the widest coverage through one integration.

## The testnet reality (matters for the hackathon)
On-ramps deliver real USDC on Monad mainnet (143). Prism runs testnet (10143). So a real card
purchase cannot land on our current deployment. Two honest options:
1. Keep Add money as the announced "coming soon" teaser on testnet, and wire the real on-ramp when
   Prism runs mainnet.
2. For a live demo, use a provider sandbox (Ramp, Transak, MoonPay all have test modes with test
   cards) to show the full flow end to end, clearly labelled as sandbox, no real money.

## Cost reality: the aggregator subscription changes the pick
Onramper charges a fixed monthly SaaS fee ON TOP of the underlying ramps' per-transaction fees:
Essential $199/mo (six on-ramps, no off-ramp), Premium $599/mo (all on-ramps AND all off-ramps,
P2P, swaps), White Label by sales. So the two-way requirement forces the $599/mo tier, before a
single user transacts. For an early-stage app that is a lot of fixed cost.

Direct providers charge NO monthly platform fee - only per transaction, and some let you add your own
margin (revenue):
- **Transak**: ~1% per transaction plus an optional partner fee you configure (you can earn on it).
  160+ countries, the widest local rails (UPI, PIX, SEPA Instant, and more), on AND off ramp, widget
  + API, listed on Monad.
- **MoonPay**: ~1.99% bank / ~3.99% card, ~160 countries, on + off ramp, widget + API.
- **Yellow Card**: African on + off ramp via its Payments API, local NGN rails, roughly ~1%.

So the aggregator's value (one integration, routing, redundancy) costs $199-599/mo. At Prism's stage
that is not worth it yet. Go direct, keep per-transaction economics, and revisit an aggregator only
if scale justifies the subscription. The scaffold we built is provider-agnostic (a config-driven
widget URL + wallet binding), so switching from Onramper to a direct provider is a config change, not
a rewrite.

## Recommendation (global, two-way) - REVISED for cost
The requirement is global add-money AND cash-out for anyone, with Naira first-class - but WITHOUT a
$199-599/mo aggregator subscription at this stage. So go direct, per-transaction only.

- **Base: Transak (direct).** One provider covers most of the requirement: 160+ countries, widest
  local rails, on AND off ramp, ~1% per transaction with no monthly fee, an optional partner fee you
  can earn on, and it is listed on Monad. Widget for the fast path, API for depth.
- **Add Yellow Card (direct) for Naira depth** if Transak's Nigeria coverage is thin: African on + off
  ramp, strong local NGN rails, Payments API, ~1%. Prism's users are Nigerian, so first-class Naira
  matters; Transak + Yellow Card together cover global + strong NGN, both per-transaction, no SaaS fee.
- **MoonPay** as an alternative/second global rail if we want redundancy (higher card fees).
- **Aggregator (Onramper/Coindisco) is a LATER option**, not now - revisit when volume justifies the
  $199-599/mo for its routing and redundancy.
- Confirm with each direct provider: Naira on + off ramp, USDC-on-Monad delivery (and off-ramp), the
  exact widget/asset config, and the webhook events. The scaffold seam is provider-agnostic, so this
  is a config swap.

## Deep dive: the providers that could do Naira -> USDC on Monad

The real discriminator is doing BOTH at once: take Naira through local rails AND settle USDC on
Monad. Ranked by how well each does both today.

### 1. Onramper (aggregator) - strongest single integration
- **Integration:** hosted link (button opens Onramper checkout in a tab) OR embedded iframe widget OR
  full backend API. One API key from their dashboard. Open-source widget on GitHub.
- **Naira:** yes, via its Yellow Card integration - NGN bank transfer, instant P2P transfer, mobile
  money, across 20 African countries. Also 130+ payment methods, 190+ countries if Prism expands.
- **Monad + USDC:** yes. Onramper is in Monad's official on-ramp directory; the Monad-native HaHa
  Wallet onboards through Onramper. So one integration gives Naira in and USDC on Monad out.
- **KYC:** handled by the underlying ramp (Yellow Card etc.), not by Prism. Keeps Prism out of PII scope.
- **Fees:** aggregator surfaces each ramp's fee; Yellow Card's NGN->USDC runs ~1%, settles in hours.
- **Sandbox:** yes for UI/flow/KYC simulation, BUT no provider supports testnet on-chain settlement -
  you cannot verify real on-chain delivery in sandbox. Sandbox assets differ from production.
- **Verdict:** best fit for a Naira user base on Monad. One integration, local rails, resilient
  (routes around a ramp that is down or rejects a user). Trade-off: an extra margin layer, and you
  cannot prove on-chain settlement in sandbox.

### 2. Switch (direct API) - explicit Monad + Africa
- **Integration:** API.
- **Naira / Africa:** yes, coverage includes Africa (plus Europe, UK, APAC, India), local currency
  payout via bank transfer, mobile money, SWIFT.
- **Monad + USDC:** yes, explicitly "USDC and USDT0 on Monad" in Monad's directory.
- **Verdict:** the strongest DIRECT (non-aggregator) option that already names Monad + Africa. Fewer
  middlemen than Onramper, possibly better rates. Needs a direct conversation to confirm NGN specifics,
  fees, and embed model. Good primary or fallback to Onramper.

### 3. Fonbnk (direct API) - great NGN rails, Monad not live yet
- **Integration:** server-to-server API (requires merchant KYB first). Sandbox with test accounts.
- **Naira:** yes, strong - NGN bank transfer and mobile airtime, STK Push / USSD / manual transfer.
- **Monad + USDC:** NOT confirmed. Docs show USDC on Polygon; Monad is marked in-progress in the
  directory. Today you would land USDC on Polygon and bridge to Monad (extra hop), or wait.
- **KYC:** tiered and cheap for small amounts: $0-10 none, $10-50 basic ID, $50-100 doc + biometric
  (Smile Identity). Order range 1-100 USDC (~1,534-153,376 NGN); example showed ~0% fee.
- **Verdict:** excellent Naira rails and micro-amount UX, but not a Monad-delivery option yet. Revisit
  when Monad goes live there, or use only if we accept a Polygon->Monad bridge.

### 4. Alchemy Pay (direct) - solid NGN, Monad unconfirmed
- **Integration:** page redirect, API, and SDK. 173 countries.
- **Naira:** yes, NGN bank transfer across all major Nigerian banks, min ~11,300 NGN.
- **Monad + USDC:** not confirmed. Supports many chains; Monad not listed in what we found.
- **KYC:** basic unlocks $1k-5k/day, enhanced up to $50k/day and $200k/month (via BASIS ID).
- **Fees:** ~2.5-3.9% processing plus network. (A promotional zero-fee USDC ramp exists via a partner.)
- **Verdict:** strong Nigeria rails, but confirm Monad delivery before counting on it. Likely a
  Polygon/Base + bridge today.

### 5. Yellow Card (direct) - the NGN engine behind Onramper
- The local rails powering Onramper's Naira support. You could integrate Yellow Card directly for
  Africa-only, but then you lose the aggregator's redundancy and global reach, and you take on its
  API directly. For Prism, reaching Yellow Card THROUGH Onramper is the simpler path.

### Not the answer for Naira
- **Ramp Network, MoonPay, Transak:** best-in-class widgets and the cleanest passkey/USDC/AUSD fit
  (Ramp), but thin or absent in Nigeria. Keep Ramp as a possible secondary rail for non-Nigerian users.
- **Blink:** crypto DEPOSIT SDK (passkey deposits of existing crypto), now with native USDC/MON on
  Monad. Not a fiat on-ramp; relevant only to the separate crypto-deposit path.

## Global (anyone, anywhere) + two-way (cash out): the aggregator wins

The expanded requirement is: anyone using Prism, Nigerian or not, must be able to add money, and to
cash out to their local fiat. Two-way, global. This settles the architecture: use an **aggregator**,
not a stack of single-country providers. Wiring Yellow Card + Ramp + MoonPay + Fonbnk + N others by
hand, in both directions, per country, is a maintenance sink. An aggregator is one integration that
already spans the providers and both flows.

### Onramper does both directions in one integration
- **On-ramp:** 30+ ramps, 190+ countries, 130+ payment methods. Local rails per region (NGN via
  Yellow Card; cards/Apple Pay/PayPal/bank elsewhere via MoonPay, Transak, Banxa, etc.).
- **Off-ramp (cash out):** 8 off-ramps, "true global coverage," pay out to bank account, card, Apple
  Pay, PayPal, and more. Yellow Card provides the NGN off-ramp (sell USDC, receive Naira to bank).
  Same integration, same API key as the on-ramp.
- **Routing engine:** scores each user across 70+ factors and routes to the best (and lightest-KYC for
  small amounts) provider available in their country and for their payment method. If a country has
  on-ramp but not off-ramp (or a provider is down or rejects a user), it routes around it and shows
  only what is actually available. That graceful degradation is the whole point of an aggregator.
- **Integration:** widget (plug-and-play) or full API, for both directions.

### How off-ramp maps onto Prism (important, and a good fit)
Off-ramp needs the user to send USDC to the provider, then the provider pays out fiat. Onramper's
off-ramp offers a QR flow or a native "send" flow. Prism already signs payments from the user's Mera
account, so cash-out is: user picks amount + payout method -> Prism signs a USDC transfer from their
Monad account to the off-ramp deposit address -> provider pays fiat to their bank / mobile money.
This reuses the exact signing path we already have; nothing new on the crypto side.

### The one thing to confirm with Onramper before committing
On-ramp to USDC on Monad is confirmed. **Off-ramp of USDC FROM Monad needs explicit confirmation** -
on-ramp support for a chain does not guarantee off-ramp support for it, and the off-ramp product page
did not name Monad. Ask Onramper directly: "can a user sell USDC on Monad and receive NGN (and other
local fiats) via your off-ramp today?" Also confirm the off-ramp country list (off-ramp coverage is
usually narrower than on-ramp) and per-country payout methods. Coindisco is the backup aggregator if
Onramper's Monad off-ramp is not ready.

### Off-ramp caveats (true of any provider)
- Off-ramp is more regulated than on-ramp: heavier KYC for fiat payout, and country coverage is
  thinner. Delegate this KYC to the provider; Prism must not touch payout PII.
- Money-truth on cash-out: debit the user's balance only after the USDC transfer to the provider
  confirms on-chain, and surface the fiat payout status from the provider's webhook, never optimistically.

## Two hard realities that apply to ALL of them
1. **No Monad testnet on-ramp.** Every provider settles real USDC on Monad mainnet (143). Prism runs
   testnet (10143). So a real Naira purchase cannot land on the current build. For a demo, use a
   provider sandbox to show the UI + KYC flow (clearly labelled, no real money, no on-chain proof).
   The real feature ships when Prism runs mainnet. Same shape as the Save substrate gap.
2. **Money-truth still holds.** Whatever provider, Prism must credit the balance only from the
   on-chain USDC read after settlement, never optimistically from the widget's success callback. Use
   a provider webhook (or the existing balance refresh) to surface it.

## Nigeria payment-rail note
In Nigeria, bank transfer and instant transfer dominate; mobile money is growing; card penetration is
lower and card success rates are poor. So lead the Add money UX with bank/instant transfer, not card.
All the Naira providers above lead with bank transfer for exactly this reason.

## Decision path
- **Fastest to a working Naira -> USDC-on-Monad path: Onramper**, embedded widget, Yellow Card rails,
  KYC delegated. Ship this behind Add money when Prism is on mainnet; demo the flow in sandbox now.
- **If we want a direct integration and better economics: talk to Switch** (names Monad + Africa) and
  price it against Onramper.
- **Keep Fonbnk / Alchemy Pay warm** for their strong, cheap Naira rails; adopt when their Monad
  delivery is confirmed, or if we accept a bridge hop from Polygon/Base to Monad.

## Integration sketch (any provider)
1. User taps Add money, enters an amount. No chain or token shown.
2. Prism opens the provider widget preconfigured: asset USDC, network Monad, wallet = the user's
   Mera account address, amount prefilled.
3. Provider handles fiat collection and KYC. On settlement, USDC lands in the user's Monad account.
4. Prism reflects the new balance only from the on-chain balance read (money-truth, no optimistic
   credit). A webhook or the existing balance refresh surfaces it.

## Open items before building
- Confirm each provider's embeddable SDK terms, fees, and min/max, and whether the widget can be
  fully preconfigured (asset + network + wallet + amount) to keep the chain hidden.
- Decide testnet demo path (sandbox) vs waiting for Prism mainnet.
- Check KYC UX: provider-hosted KYC is simplest and keeps Prism out of PII scope.
- Confirm Ramp's partner/API access process (their page routes embedded integrations through sales).

## Sources
- Monad on-ramp directory: https://docs.monad.xyz/tooling-and-infra/onramps
- Monad on-ramp ecosystem: https://www.monad.xyz/blog/monad-onramp-ecosystem
- Ramp Network on Monad: https://rampnetwork.com/blog/monad-live-on-ramp-network
- Onramper: https://onramper.com/products/onramp
- Onramper x Yellow Card (Naira rails, 20 African countries): https://www.onramper.com/blog/yellow-card-partners-with-onramper-to-enhance-crypto-onboarding-in-africa
- Onramper payment methods / coverage: https://docs.onramper.com/docs/supported-payment-methods , https://onramper.com/coverage
- Fonbnk on-ramp API: https://docs.fonbnk.com/v1.5/on-ramp/server-to-server-integration
- Alchemy Pay Nigeria bank transfer on-ramp: https://alchemypay.medium.com/alchemy-pay-supports-nigeria-bank-transfer-for-fiat-crypto-on-ramp-7f2ef347ca38
- Blink deposit SDK: https://docs.blink.cash/introduction
- Onramper sandbox (no testnet on-chain settlement): https://docs.onramper.com/docs/testing-overview
- Onramper integration (widget/iframe/API): https://docs.onramper.com/docs/integration-steps
- Switch, Calm, Unifold, Fonbnk on Monad: https://docs.monad.xyz/tooling-and-infra/onramps
- Alchemy Pay Nigeria bank transfer on-ramp: https://alchemypay.org/news-and-press/alchemy-pay-supports-nigeria-bank-transfer-for-fiat-crypto-on-ramp
- Yellow Card Africa API docs: https://docs.yellowcard.engineering/v1.0.26/docs/africa
