#!/usr/bin/env bash
# One-command setup for a fresh clone: build the Mera bridge, then generate the Xcode project.
# Both outputs are gitignored build artifacts, so this must run before opening Prism.xcodeproj.
#   ./bootstrap.sh          generate only
#   ./bootstrap.sh --open   generate, then open in Xcode
set -euo pipefail
cd "$(dirname "$0")"

# 1. Build the Mera bridge (the passkey/signing WebView bundle the app loads). esbuild writes
#    Prism/Resources/MeraWeb/mera-bridge.js — a gitignored artifact, absent on a fresh clone, that
#    the app needs at runtime. Without it, the app builds but cannot create or use a passkey.
if ! command -v node >/dev/null 2>&1; then
  echo "node is required to build the Mera bridge. Install with: brew install node" >&2
  exit 1
fi
echo "Building the Mera bridge (ios/MeraBridge/web)…"
( cd MeraBridge/web && npm install --no-audit --no-fund --silent && npm run build )

# 2. Generate Prism.xcodeproj from project.yml.
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install with: brew install xcodegen" >&2
  exit 1
fi
xcodegen generate
printf '\nGenerated: %s/Prism.xcodeproj\n' "$PWD"
printf 'Next: open it, set your signing Team under Signing & Capabilities, then Product > Archive.\n'
printf 'See docs/TESTFLIGHT.md for the full path to TestFlight.\n'

if [[ "${1:-}" == "--open" ]]; then
  open Prism.xcodeproj
fi
