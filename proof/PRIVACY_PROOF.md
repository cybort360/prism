# PRIVACY PROOF

Prism's first stated principle is that a phone number is a private reachability alias — not a key,
not an on-chain identifier. This audit searched every surface named in the FORGE brief and found
**one real leak, now fixed**, and left behind automated scanners so it cannot come back.

## Surfaces searched

| Surface | Method | Result |
|---|---|---|
| Contract calldata | `PrismPrivacyTest` builds the exact `settle` / `fundClaim` / `claim` calldata and byte-scans it | clean |
| Contract events | `vm.recordLogs()` → every topic and data blob of a settled payment and a full claim lifecycle | clean |
| Contract storage | `vm.record()` → every written slot key *and* value, on router, vault, and token | clean |
| Backend database | drive OTP + onboarding + resolve + claim, then regex the persisted `store.json` | **leak found — fixed** |
| Backend logs | intercept `console.log`/`console.error` across the same paths | clean |
| iOS logging | `grep` for `print(`, `NSLog`, `os_log`, `Logger(` | zero occurrences |
| Analytics / crash reporting | `grep` for Sentry, Crashlytics, Firebase, Amplitude, Mixpanel, Analytics; `ios/project.yml` package list | **no telemetry SDK exists** — no leak surface |

## The leak that was found

`OtpService.start` throttled per-number using the raw E.164 as the rate-limit key:

```js
consumeRateLimit(this.store, `otp-phone:${phone}`, { limit: 5, windowMs: 60 * 60_000 });
```

`consumeRateLimit` writes `data.rateLimits[key]` and `JsonStore.write` persists it, so every number
that ever requested an OTP was written to disk in plaintext — including numbers belonging to people
who never completed onboarding and are not users. It was the single place in the codebase where the
pepper was not applied; identity records store the phone AES-256-GCM encrypted, and the lookup index
is `HMAC-SHA256(pepper, E164)`.

Reproduced before the fix:

```
persisted store E.164 matches: ["+2348012345678"]
rateLimit keys: ["otp-start:203.0.113.9","otp-phone:+2348012345678","otp-check:203.0.113.9"]
```

After the fix (key derived with `phoneLookupKey`):

```
persisted store E.164 matches: []
rateLimit keys: ["otp-start:203.0.113.9","otp-phone:0x23d4ee4d09ae0b5509077c4f6bcb059b433b5dcd7b387530a88d0d7255fad53a","otp-check:203.0.113.9"]
```

## Automated leak checks (`backend/test/privacy-leak.test.js`)

| ID | Asserts |
|---|---|
| LEAK-01 | After OTP start/check for two numbers, onboarding, two resolves and a claim, **no E.164 appears anywhere** in the persisted store; every `phoneIndex` key is a 32-byte hex HMAC; no rate-limit key contains a phone. |
| LEAK-02 | The stored phone is an AES-GCM envelope (`iv`/`ciphertext`/`tag`), not plaintext; `phoneLookupKey ≠ sha256(phone)`; changing only the pepper changes the key, proving it is keyed rather than a bare digest (MUT-02). |
| LEAK-03 | Across OTP + onboarding + resolve, the captured log stream contains no phone, no OTP code, no PIN, and no private-key material. |
| LEAK-04 | A resolver attestation returned to a requester contains neither the phone nor the lookup key — the latter would be an offline-enumeration oracle. |
| LEAK-05 | No PEM private key is readable in the store; the resolver's public view carries no key material. |
| LEAK-06 | `publicView` masks rather than returns the phone, and the mask reveals strictly fewer digits than the number. |

`contracts/test/PrismPrivacy.t.sol` is the on-chain half, including
`testScannerDetectsPhoneDerivedValue`, which proves the scanner reverts on a blob that *does* carry
`sha256(phone)` or the raw ASCII — without it, a broken scanner would pass everything silently.

**LEAK-01 was verified non-vacuous** by reintroducing the exact leak and re-running:

```
not ok 1 - LEAK-01 no raw phone number is ever persisted to the datastore
    raw E.164 numbers found at rest in the datastore: +2348031234567, +447700900123
```

## OTP, PIN, and passkey material

- **OTP codes** are never persisted. Twilio Verify holds verification state; `OtpService.check`
  returns only `{approved}`. The dev adapter compares against `DEV_OTP_CODE` from config and stores
  nothing. LEAK-03 asserts the code never reaches logs.
- **PINs** never leave the device. There is no PIN field in any request body, route, or store key —
  `PINService.verify` runs locally in `PaymentCoordinator.localApproval` *before* any network call.
- **Passkey root / PRF output** never leaves the WKWebView. `ios/MeraBridge/web/src/bridge.js` posts
  back only addresses and signatures; `createSecp256k1SigningSession` keeps the derived key inside
  the web context and `revokeSession()` zeroes it. Nothing in the bridge protocol carries a private
  key to Swift or to the backend on the device path.

## Residual privacy risks (not fixed, stated plainly)

1. **The pepper lives beside the data it protects.** `phoneIndex` is `HMAC-SHA256(pepper, E164)`
   with `RESOLVER_PEPPER` in the backend's own environment. E.164 is a ~10¹⁰ space and HMAC is fast,
   so an attacker who takes both the datastore and the pepper can enumerate every user's number
   offline in minutes. Mitigation is a slow KDF or holding the pepper in an HSM so the index cannot
   be recomputed offline. Today the whole scheme rests on the pepper not leaking with the database.
2. **The dev-mode private key crosses the Swift↔JS boundary.** On the simulator a raw 32-byte key is
   injected into the WebView on every call (`WKWebViewMeraBridge.swift:94`). It is compile-time
   excluded from device builds by `#if targetEnvironment(simulator)` — the correct gate, not a
   runtime flag — but the simulator seed is a real key held in the Keychain and should never be
   funded with anything of value.
3. **`maskPhone` reveals the country code plus up to 5 leading digits and the last 2**
   (`+234803 ••• ••67`). For a known country and carrier prefix that is a meaningful narrowing of
   the search space when combined with any other identifier.
