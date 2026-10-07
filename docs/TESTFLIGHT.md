# Shipping Prism to TestFlight

How to take a fresh clone of this repo to a TestFlight build you can hand to testers. Written for
the person who owns the Apple Developer account and does the upload.

Two things in this repo are **generated build artifacts, deliberately not committed**, so a fresh
clone cannot be opened in Xcode until you run the bootstrap step:

- `ios/Prism.xcodeproj` — generated from `ios/project.yml` by [XcodeGen](https://github.com/yonaskolb/XcodeGen).
- `ios/Prism/Resources/MeraWeb/mera-bridge.js` — the passkey/signing WebView bundle, built from
  `ios/MeraBridge/web` with esbuild. Without it the app builds but cannot create or use a passkey.

`./ios/bootstrap.sh` produces both.

---

## 1. Prerequisites (one time)

- **macOS + Xcode** (16 or newer; the project targets iOS 18, Swift 6). Launch Xcode once and let it
  install components.
- **Homebrew**, then the two code generators:
  ```bash
  brew install xcodegen node
  ```
- An **Apple Developer Program** membership (paid) with access to **App Store Connect**. TestFlight
  distribution is not possible with a free account.

## 2. Build the project from a clone

```bash
git clone <repo-url>
cd prism-v1/ios
./bootstrap.sh --open      # builds the Mera bridge, generates Prism.xcodeproj, opens Xcode
```

If `bootstrap.sh` complains a tool is missing, install it (`brew install xcodegen` / `brew install node`)
and re-run. Re-run bootstrap any time you change `project.yml` or the Mera bridge source.

## 3. Set signing (in Xcode)

Nothing team-specific is committed, so you point the app at **your** Apple team:

1. Select the **Prism** project → **Prism** target → **Signing & Capabilities**.
2. Check **Automatically manage signing**.
3. Choose your **Team**. Xcode creates the provisioning profile for you.
4. **Bundle Identifier** defaults to `com.prism.mobile`. If App Store Connect reports it is taken (or
   you want it under your org), change it to a unique reverse-domain id, e.g. `com.yourorg.prism`.
   Change it in **`ios/project.yml`** (`PRODUCT_BUNDLE_IDENTIFIER`) and re-run `./bootstrap.sh` so the
   change survives project regeneration — editing only in Xcode is lost on the next bootstrap.
5. Register the matching app record in **App Store Connect → Apps → +** (same bundle id).

## 4. Point the app at a reachable backend (important)

Prism is a thin client; it talks to the Node backend in `backend/`. The app reads its base URL from
the `PRISM_API_BASE_URL` build setting (wired through `Info.plist`). It is already configured:

- **Debug** (simulator / local dev) → `http://127.0.0.1:8787`
- **Release** (Archive / TestFlight) → `https://app.getprism.xyz`

So an archive automatically targets the deployed backend — **you just have to deploy it there**. Follow
[`../backend/DEPLOY.md`](../backend/DEPLOY.md) to put the backend on `app.getprism.xyz` (Fly.io), then
`fly certs add app.getprism.xyz`. App Transport Security requires https for any non-local host (the
local-networking exception in `Info.plist` does not relax TLS for remote hosts), which `app.getprism.xyz`
satisfies once its cert is issued. To use a different domain, change it in `ios/project.yml`
(`settings.configs.Release.PRISM_API_BASE_URL` **and** the associated-domains), then re-run `./bootstrap.sh`.

## 5. Archive and upload

### Option A — Xcode Organizer (simplest)

1. Toolbar device selector → **Any iOS Device (arm64)** (not a simulator).
2. **Product → Archive**. When it finishes the Organizer opens.
3. Select the archive → **Distribute App → App Store Connect → Upload** → accept the defaults.
4. After processing (a few minutes), the build appears in **App Store Connect → your app → TestFlight**.

### Option B — command line (for scripting/CI)

```bash
cd ios
xcodebuild -project Prism.xcodeproj -scheme Prism \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Prism.xcarchive archive

# Fill in your Team ID in ios/ExportOptions.plist first (App Store Connect > Membership).
xcodebuild -exportArchive -archivePath build/Prism.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export
```

Upload `build/export/Prism.ipa` with the **Transporter** app (Mac App Store) or
`xcrun altool --upload-app`.

## 6. Add testers

In **App Store Connect → TestFlight**: add **Internal Testers** (members of your team, no review
needed) or create an **External** group and invite by email (first external build needs a short Beta
App Review). Testers install the **TestFlight** app and redeem your invite.

---

## Passkeys and universal links (required for external review)

The app is configured for the relying-party domain **`app.getprism.xyz`**: `ios/project.yml` declares
the Associated Domains entitlement (`webcredentials:` + `applinks:`), and the backend serves the
matching AASA. **External Beta App Review needs device passkeys to work**, so all of this must be live
before you submit to external testers:

1. **Deploy the backend** to `app.getprism.xyz` with `APPLE_APP_ID=<TeamID>.com.prism.mobile` set —
   the backend then serves `https://app.getprism.xyz/.well-known/apple-app-site-association` with your
   Team ID baked in. See [`../backend/DEPLOY.md`](../backend/DEPLOY.md).
2. **Enable the Associated Domains capability** on the App ID in the Apple Developer portal
   (Certificates, Identifiers & Profiles → your App ID). With Automatic signing, Xcode syncs it.
3. **Verify** `curl https://app.getprism.xyz/.well-known/apple-app-site-association` returns your
   `APPLE_APP_ID` in `webcredentials.apps` and `applinks…appIDs`.

To use a different domain, change it in `ios/project.yml` (associated-domains **and** the Release
`PRISM_API_BASE_URL`) and in the backend's `APPLE_APP_ID` host, then re-run `./bootstrap.sh`.
Remember: a passkey is bound to the domain it was created on — pick one and keep it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `xcodegen: command not found` / `node: command not found` | `brew install xcodegen node`, re-run bootstrap. |
| App builds but can't create a passkey | The Mera bridge wasn't built — re-run `./ios/bootstrap.sh`. |
| Every screen is empty / network errors on device | `PRISM_API_BASE_URL` still points at localhost — set a reachable https backend (§4). |
| "Failed to register bundle identifier" | The id is taken; change `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` to a unique one and re-run bootstrap. |
| Signing error about Associated Domains | You re-enabled the entitlement without the capability/domain — either finish §"Passkeys" or remove the `entitlements:` block again. |
| Xcode changes vanish after bootstrap | Project is generated from `project.yml`; make target/signing/bundle changes there, not only in Xcode. |
