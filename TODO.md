# Prism — Remaining Work

Status as of this checkpoint: audit **P0 and P1 are complete** (fixed, tested, pushed). What follows
is what's left. See `git log` for the P0/P1 commits and the hostile-audit findings they close.

## Done (for reference)
- **P0:** F-01 router bypass (receiveWithAuthorization→forward), F-03 split claim op IDs, F-04 OTP
  fail-closed, F-05 atomic idempotency, F-07 non-replayable bind challenge. (F-02 was already fixed.)
- **P1:** C-01 per-claim eligibility nonce + multi-claim isolation tests, C-02 Home shows all eligible
  claims + refresh after collection, webhook dedupe persisted/atomic.
- Test posture: backend 47/47, contracts 36/36 (incl. fuzz + invariants), iOS builds, onboarding E2E.

---

## P2 — Evidence tier (needs real infrastructure + secrets)
Blocked on external keys/funds; nothing here is a code defect.

- [x] **Deploy contracts to Monad testnet.** DONE — router `0x423a9Da2…62b7`, vault `0xBe3D0b04…Eae3`
      live on chainId 10143; `deployments/monad-testnet.json` populated. See `proof/TESTNET_DEPLOYMENT.md`.
- [x] **One real direct payment** settles on-chain. DONE — tx
      `0x254e8281…9c8f7`, block 60506783, payer USDC −1 / recipient +1, payer MON = 0 (gasless),
      `router.paymentUsed` = true. See `proof/TESTNET_DEPLOYMENT.md`.
- [x] **One real claim funding + collection** on-chain. DONE — fund tx `0x322a32da…`, collect tx
      `0xe6e8c97e…`; vault escrowed then released 2.00 USDC, recipient MON = 0. See proof doc.
- [x] **One refund** on-chain. DONE — after expiry, refund tx `0xe5d3a758…` (block 60559611),
      `ClaimRefunded`, USDC vault→sender 1.50, claim status Refunded, relayer paid gas.
- [ ] **Live Alchemy** as the Monad RPC — real `eth_call`/receipt readback; webhook delivery if available.
- [~] **Live Envio** indexing. Config now points at the deployed router/vault (`indexer/envio/config.yaml`,
      start_block 60506000) and codegen builds; the Hasura/Postgres stack runs. Local `envio start`
      is currently blocked by an ecosystem issue — TypeScript 7 (native preview) is tagged `latest`,
      so pnpm installs it as ts-node's peer in the generated project and ts-node 10.9.1 crashes on
      it (`ts.sys` undefined). Not a Prism defect. Options: deploy to Envio's hosted service, or pin
      TypeScript 5.x for the generated project.
- [ ] **Physical-device iPhone flows:** passkey create/recover, Face ID/PIN approval, Contacts, QR,
      universal links (can't run in simulator).
- [ ] **Latency numbers:** capture real P50/P95 from instrumented runs; don't publish figures until then.
- [ ] Point the proof surface (`GET /v1/proof/:id`, `GET /v1/metrics`) at the live deployment for the
      judge demo.

## Prism Circles — open decisions (architecture proven, product not built)

Phases 0-3 of the Circles architecture proof are complete and green; see
`docs/CIRCLES_ARCHITECTURE_PROOF.md` and `docs/CIRCLES_DEPENDENCY_AUDIT.md`. No Circle UI exists yet.

- [x] **Admin identity — DECIDED (2026-09-13).** A Circle admin's Safe owner is their existing Mera
      passkey-derived secp256k1 address. No new credential, no per-admin contract, no EIP-1271.
      `PrismP256SafeOwner` stays as proof the P-256 path is available but is not on the shipping path.
- [ ] **Threshold / "spare" guardrail — FOUNDER DECISION, needed before Circle creation ships.**
      Spare = `admins - threshold` = how many admins a Circle can lose and still move money. At
      spare = 0 (2-of-2, 3-of-3) one lost phone freezes the funds **permanently**: adding, removing
      or re-thresholding an owner each need the signature that was lost, so there is no repair path
      and no support override. Cheap to prevent at creation, impossible to fix afterwards. Open
      question for the founders: forbid spare = 0 outright, warn loudly, or allow it behind an
      explicit acknowledgement. Also decide how to handle admins who are not independent (two
      devices owned by one person, or by one household) — spare > 0 does not by itself mean the
      approvals are independent.
- [ ] **Full recovery strategy — BACKLOG.** Social recovery, a Prism-held backup owner, time-locked
      escape hatches. Safe already supplies the mechanism (`addOwnerWithThreshold`, `removeOwner`,
      `swapOwner` as ordinary threshold-approved Circle transactions), so this is product design,
      not contract work. Must land before real money sits in Circles.
- [ ] **Circle spending limits stay OFF.** `CIRCLE_LIMITS_ENABLED=false`, threshold-only. Safe's
      Allowance Module v1.0.0 fixed a delegate-transfer replay vulnerability and is deployed on no
      chain; the only module on Monad is the pre-fix v0.1.1. `backend/src/config.js` refuses to
      enable limits against that address. Revisit only when a v1.0.0 deployment is independently
      verifiable on the target network.
- [ ] **Live Circle Safe on Monad testnet.** All Circles proofs run against a testnet *fork*; no
      Circle Safe has been broadcast to live Monad (same funded-key constraint as the rest of P2).
- [ ] **Verify Safe v1.4.1 on Monad mainnet (chainId 143).** Safe lists the same addresses; their
      codehashes have not been checked on mainnet yet.

## Deferred (do when going to real deployment, not for the demo)
- [ ] **F-06 — transactional persistence.** Replace `JsonStore` with a transactional store
      (SQLite/Postgres) for operations, idempotency, claims, sessions/challenges, webhook dedupe,
      alias changes, rate limits. Rationale for deferring: the demo is single-process and
      `JsonStore.mutate` is synchronous (per-op atomicity), so idempotency/webhook reserves are already
      race-safe; the gaps (multi-process, crash-durability, isolation) are production concerns with no
      demo-visible effect and high regression cost. Pair this with the P2 deployment.
- [ ] **F-09 — Alchemy Gas Manager** sponsorship (currently MON-funded relayer only). Optional; the
      relayer path already gives users MON = 0.

## Nice-to-have / polish
- [ ] UI test for claim sibling visibility (audit Test F): eligible = [C1,C2,C3], claim C1, assert
      C2/C3 remain visible without a manual refresh. (Behavior is implemented in C-02; this adds an
      automated guard.)
- [ ] Backend integration test for the assembled Request Money HTTP lifecycle (draft → commit → pay →
      reconcile → PAID) to guard against dependency-wiring regressions.
- [ ] Address the known onboarding UI-test flakiness (WKWebView throttling under added Mera signing
      load) — currently passes on re-run.

## Repo hygiene notes
- Commits must carry **no Claude/Anthropic attribution** and **no co-author trailer** (project rule).
- Pushing requires the active `gh` account to be **cybort360** (it auto-reverts to another account;
  re-assert with `gh auth switch --user cybort360` before each push).
