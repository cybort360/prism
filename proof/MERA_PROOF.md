# MERA PROOF

Claim: Prism's consumer signing layer is a Mera passkey-derived secp256k1 account, running the
**official** `@category-labs/mera` library rather than a reimplementation.

## Verified

**The library is real and current.** npm registry readback:

| Field | Value |
|---|---|
| Package | `@category-labs/mera` |
| Published versions | `0.1.0`, `0.2.0` |
| `dist-tags.latest` | `0.2.0` |
| Last modified | 2026-08-12T17:50:04Z |
| Description | "Accounts on any chain and platform, from a passkey" |

`ios/MeraBridge/web/package.json` depends on `^0.2.0` — the current published version.

**Prism does not reimplement derivation or signing.** `ios/MeraBridge/web/src/bridge.js` imports
and calls only official entry points:

| Entry point | Used for |
|---|---|
| `createPasskeyWithPrfOutput` | account creation |
| `getPasskeyPrfOutput` | restore on a returning device |
| `getEvmAddress` | deterministic EVM address from the PRF output |
| `createSecp256k1SigningSession` | warm signing session, zeroed by `end()` |

There is no local key-derivation code on the device path. The archived Secure-Enclave-P256 /
ERC-4337 implementation is under `archive/` and is not imported by the app.

**The dev signer is compile-time excluded from device builds.** This is the claim most worth
attacking, because a runtime flag would mean a shippable build could sign with a seeded key instead
of a passkey. It is not a runtime flag:

- `WKWebViewMeraBridge.swift:50` — `#if targetEnvironment(simulator)` guards injection of
  `window.PRISM_MERA_DEV` and `window.PRISM_DEV_SEED`.
- `WKWebViewMeraBridge.swift:94` — `#if targetEnvironment(simulator)` guards `params["devPk"]`.
- `bridge.js:isDev(params)` returns true only if `params.devPk` or `window.PRISM_MERA_DEV` is set.

On a device build neither symbol is compiled in, so `isDev` is false and the real passkey path runs.

**The passkey root never leaves the WebView.** The bridge posts back only addresses and signatures;
the PRF output and the session key stay in the web context. No private key crosses to Swift or to
the backend on the device path. Asserted by inspection of the full bridge protocol.

**Signature shape is compatible.** A Mera account produces standard secp256k1 ECDSA. The backend
verifies with viem's `recoverTypedDataAddress` / `recoverMessageAddress`, and the contracts use
`ecrecover` with EIP-2 low-`s` enforcement (`PrismEIP712.recover` returns `address(0)` on high-`s`
or bad `v`, and every caller fails closed). The test suite exercises this through viem-signed
payloads end to end.

## NOT verified — and it is the important half

**No Mera code has ever been executed in this audit.** There is no macOS, no Xcode, no simulator,
and no physical iPhone in this environment (Linux/WSL2). Specifically unproven:

| Item | Status |
|---|---|
| Real passkey creation on device | **never run** |
| PRF output → EVM address derivation on device | **never run** |
| Face ID gate before signing | **never run** |
| A real Mera signature verifying against the router / AUSD | **never run** |
| `mera-bridge.js` bundle even builds | **PROVEN by CI** — see below |
| WKWebView bridge round-trip | **never run** |

### Resolved by CI (GitHub Actions run 33850618242, macos-15)

The audit originally flagged that the bundle compiling against
`@category-labs/mera@0.2.0`'s *actual* exported API was an assumption, not a result — if any of the
four entry points had been renamed between versions it would fail at build time.

**It builds.** The `Build Mera bridge bundle` step (`npm ci && npm run build`) succeeded, as did
XcodeGen, and the job proceeded to Swift compilation. So the four official entry points named above
exist in the published package and esbuild resolves them. That assumption is now a result.

The same run also exposed that **the Swift app itself did not compile** — five Swift 6 strict
concurrency errors in `PrismHaptics.swift`, `PaymentCoordinator.swift` and `OnboardingFlow.swift`,
meaning the Face ID gate and the MUT-15 `.sent` binding reviewed in this audit were sitting in
files that did not build. Fixed in this branch; see `SECURITY_PROOF.md` → Finding 7.

## To prove it

```bash
cd ios/MeraBridge/web && npm ci && npm run build   # proves the API surface matches
cd ../.. && ./bootstrap.sh                          # xcodegen
# then, on a physical iPhone with the RP domain hosting web/.well-known/apple-app-site-association:
#   create account -> passkey sheet appears -> Face ID -> address returned
#   pay -> signature verifies on-chain -> PaymentSettled
```
