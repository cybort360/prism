# Mera bridge web bundle

Prism is a native Swift/SwiftUI app. Mera (`@category-labs/mera`) is a first-party TypeScript
library with no pure-Swift API, so Prism runs the **official** library inside a tiny offscreen
WKWebView and exposes only a narrow command channel to Swift (`MeraAccountService`). This is the
smallest legitimate bridge around the official implementation — Prism never re-derives accounts or
re-implements signing.

## Build

```bash
cd ios/MeraBridge/web
npm install
npm run build      # → ios/Prism/Resources/MeraWeb/mera-bridge.js (esbuild bundle, git-ignored)
npm test           # device-branch SDK integration tests with a test WebAuthn boundary
```

`ios/Prism/Resources/MeraWeb/mera-bridge.html` (committed) loads the bundle. XcodeGen ships the whole
`MeraWeb/` folder as an app resource.

## What the bundle does

`src/bridge.js` wires the official Mera exports:

| Prism command      | Mera call                                                    |
|--------------------|-------------------------------------------------------------|
| `createAccount`    | `createPasskeyWithPrfOutput({ rp, user: { name, displayName } })` → `prfOutput` → `createSecp256k1SigningSession({ privateKey: prfOutput })` → `toViemAccount` |
| `restoreAccount`   | `getPasskeyPrfOutput({ rpId })` → `prfOutput` → the same session/adapter |
| `signMessage`      | official viem adapter `signMessage` (EIP-191)               |
| `signTypedData`    | official viem adapter `signTypedData` (EIP-712, USDC ERC-3009) |
| `revokeSession`    | session `end()` (zeros the warm key)                        |

These are the installed Mera 0.2.0 interfaces. `getEvmAddress` accepts a secp256k1 public key,
not PRF bytes or a passkey result object. `toViemAccount` from `@category-labs/mera/viem` derives
the address from the session public key and supplies EIP-191/712 signing. The raw Mera session
only exposes `signDigest`. Temporary PRF bytes are zeroed after Mera copies them into the session.

Run `npm test` after SDK or bridge updates. The tests execute the bundled production branch
with the real SDK, verify recovered signature addresses, and cover PRF fallback and errors.
They replace only the platform credential API and do not prove physical iPhone passkey support.

After changing `src/bridge.js`, run `npm run build` before archiving in Xcode. The JavaScript
bundle is an app resource. An existing TestFlight installation needs a new uploaded build to
receive bridge fixes. A backend redeploy does not replace this resource.

## Relying-party domain (device passkeys)

WebAuthn passkeys need an associated https relying-party domain. Configure it exactly as Mera's
"relying-party domain association" guide describes and set the app's Associated Domains
capability (`webcredentials:<your-domain>`). The bundle reads `location.hostname` as the RP id.

WebKit also requires `document.hasFocus()` for both creation and assertion. Attaching a tiny
WKWebView to a window is insufficient. `WKWebViewMeraBridge` enables interaction, acquires
first-responder focus before dispatch (including signing that restores a session), and releases
focus after completion. The JavaScript checks focus before contacting the credential API.
`MeraWebViewFocusTests` exercises this boundary in real iOS WebKit. Without native focus handling,
the document is unfocused and WebKit rejects before showing an Apple passkey sheet.

New-user onboarding explicitly creates an account. `ensureAccount` only restores or reuses an
account. A failed or dismissed restore never silently creates a replacement account.

## Simulator / testnet demo (no passkey)

Set `window.PRISM_MERA_DEV = true` (WKWebViewMeraBridge injects this on the simulator) to use a
dev-seeded signer: a real viem secp256k1 account with its seed persisted in native Keychain and
supplied on each bridge call. It is a genuine EVM
account (real signatures the backend accepts), just not passkey-derived — for demos only.
