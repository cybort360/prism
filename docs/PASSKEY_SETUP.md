# Passkey & Associated Domains Setup

Device passkeys (WebAuthn) and Prism universal links both require an Associated Domain that you
control. This is the one piece that needs your real Apple Team ID, bundle identifier, and deployment
domain.

## Placeholders to replace

| Placeholder | Where | Value to use |
|---|---|---|
| `TEAMID` | `web/.well-known/apple-app-site-association` | your 10-character Apple Developer Team ID |
| `com.prism.mobile` | AASA + `ios/project.yml` (`PRODUCT_BUNDLE_IDENTIFIER`) | your bundle identifier |
| `prism.example` | `ios/project.yml` (`entitlements.com.apple.developer.associated-domains`) | your deployment domain, e.g. `app.prism.money` |
| `DEVELOPMENT_TEAM` | `ios/project.yml` (currently empty) | your Team ID (for signing) |

## 1. Entitlement (already wired)

`ios/project.yml` declares the Associated Domains entitlement; XcodeGen writes
`ios/Prism/Prism.entitlements`:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
  <string>webcredentials:prism.example</string>
  <string>applinks:prism.example</string>
</array>
```

Replace `prism.example` with your domain, run `xcodegen generate`, and enable the **Associated
Domains** capability on the App ID in the Apple Developer portal.

## 2. Host the AASA file

Serve `web/.well-known/apple-app-site-association` at:

```
https://<your-domain>/.well-known/apple-app-site-association
```

Requirements:
- served over HTTPS, `Content-Type: application/json`, **no** `.json` extension, no redirects;
- the `apps` / `appIDs` entries must be `TEAMID.com.prism.mobile` with your real values.

`webcredentials` associates the domain for passkeys; `applinks` handles Prism payment links
(`/pay/*`), which resolve to a Prism identity — never a raw address.

## 3. Relying-party domain in the Mera bridge

The Mera WebView derives the passkey against `location.hostname`. Host the bridge assets (or the
associated web app) under the same domain declared in `webcredentials:` so the platform authenticator
recognizes the relying party. See `ios/MeraBridge/web/BUILD.md`.

## 4. Verify

- Apple's CDN caches AASA; after deploying, validate with
  `https://app-site-association.cdn-apple.com/a/v1/<your-domain>`.
- On device: create an account in onboarding → the system passkey sheet should present for
  `<your-domain>`; a universal link `https://<your-domain>/pay/<prismId>` should open Prism.

## Notes

- Simulator builds do not require a provisioning profile with the entitlement; device builds do.
- No font binary, private key, or passkey secret is ever committed. The F5.6 font hook falls back to
  a system face until you add your licensed copy under `ios/Prism/Resources/Fonts/`.
