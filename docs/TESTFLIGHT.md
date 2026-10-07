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
the `PRISM_API_BASE_URL` build setting (wired through `Info.plist`). **If you leave it unset, the app
falls back to `http://127.0.0.1:8787`, which a tester's device cannot reach** — the UI launches but
every network call fails.

Before archiving, set it to a backend your testers can hit over **https**:

- Edit `ios/project.yml` → `settings.base.PRISM_API_BASE_URL: "https://your-backend.example"`, then
  re-run `./bootstrap.sh`.
- Host the backend somewhere public (the demo backend is HTTP/loopback only; a TestFlight build needs
  a real https deployment). App Transport Security requires https for any non-local host — the local
  networking exception in `Info.plist` does **not** relax TLS for remote hosts.

> First upload just to confirm the pipeline? You can ship with the localhost fallback — the app
> installs and launches, backend-dependent screens just won't load. Set a real URL before giving it to
> anyone who will actually use it.

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

## Passkeys and universal links (deferred — off in the first build)

To keep the first upload frictionless, **Associated Domains are intentionally omitted** (see the note
in `ios/project.yml` and the commented template in `ios/Prism/Prism.entitlements`). The app works
without them; Mera passkey autofill and `prism.app/pay/...` universal links stay off until you wire a
real domain. To enable later:

1. Re-add an `entitlements:` block to the Prism target in `ios/project.yml` pointing at
   `Prism/Prism.entitlements`, and put your domain in the `associated-domains` array
   (`webcredentials:<domain>` + `applinks:<domain>`).
2. Host the AASA file with your **real 10-character Team ID** at
   `https://<domain>/.well-known/apple-app-site-association` (the repo's `web/.well-known/...` still
   has a `TEAMID` placeholder — replace it). See [`PASSKEY_SETUP.md`](PASSKEY_SETUP.md).
3. Re-run `./bootstrap.sh`, re-archive, re-upload.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `xcodegen: command not found` / `node: command not found` | `brew install xcodegen node`, re-run bootstrap. |
| App builds but can't create a passkey | The Mera bridge wasn't built — re-run `./ios/bootstrap.sh`. |
| Every screen is empty / network errors on device | `PRISM_API_BASE_URL` still points at localhost — set a reachable https backend (§4). |
| "Failed to register bundle identifier" | The id is taken; change `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` to a unique one and re-run bootstrap. |
| Signing error about Associated Domains | You re-enabled the entitlement without the capability/domain — either finish §"Passkeys" or remove the `entitlements:` block again. |
| Xcode changes vanish after bootstrap | Project is generated from `project.yml`; make target/signing/bundle changes there, not only in Xcode. |
