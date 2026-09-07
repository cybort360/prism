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
- [ ] **One real claim funding + collection**, and **one refund**, on-chain.
- [ ] **Live Alchemy** as the Monad RPC — real `eth_call`/receipt readback; webhook delivery if available.
- [ ] **Live Envio** indexing real `PaymentSettled` / claim events; verify Activity reconciliation.
- [ ] **Physical-device iPhone flows:** passkey create/recover, Face ID/PIN approval, Contacts, QR,
      universal links (can't run in simulator).
- [ ] **Latency numbers:** capture real P50/P95 from instrumented runs; don't publish figures until then.
- [ ] Point the proof surface (`GET /v1/proof/:id`, `GET /v1/metrics`) at the live deployment for the
      judge demo.

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
