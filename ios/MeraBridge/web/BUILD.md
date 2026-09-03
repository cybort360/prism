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
```

`ios/Prism/Resources/MeraWeb/mera-bridge.html` (committed) loads the bundle. XcodeGen ships the whole
`MeraWeb/` folder as an app resource.

## What the bundle does

`src/bridge.js` wires the official Mera exports:

| Prism command      | Mera call                                                    |
|--------------------|-------------------------------------------------------------|
| `createAccount`    | `createPasskeyWithPrfOutput` → `getEvmAddress` → `createSecp256k1SigningSession` |
| `restoreAccount`   | `getPasskeyPrfOutput` → `getEvmAddress` → `createSecp256k1SigningSession`        |
| `signMessage`      | session `signMessage` (EIP-191)                             |
| `signTypedData`    | session `signTypedData` (EIP-712, AUSD ERC-3009)           |
| `revokeSession`    | session `end()` (zeros the warm key)                        |

Confirm the exact option shapes against the current Mera API reference at
<https://mera.category.xyz>; the entry points above are stable, their argument objects are the only
integration detail to verify when you install the package.

## Relying-party domain (device passkeys)

WebAuthn passkeys need an associated https relying-party domain. Configure it exactly as Mera's
"relying-party domain association" guide describes and set the app's Associated Domains
capability (`webcredentials:<your-domain>`). The bundle reads `location.hostname` as the RP id.

## Simulator / testnet demo (no passkey)

Set `window.PRISM_MERA_DEV = true` (WKWebViewMeraBridge injects this on the simulator) to use a
dev-seeded signer: a real viem secp256k1 account persisted in `localStorage`. It is a genuine EVM
account (real signatures the backend accepts), just not passkey-derived — for demos only.
