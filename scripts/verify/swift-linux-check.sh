#!/usr/bin/env bash
# Swift verification without macOS.
#
# `make test-ios` needs Xcode. This script gets as far as a Linux Swift toolchain honestly can, which
# is further than "untested":
#
#   1. PARSE      every .swift file in ios/ (syntax, all 98 files — views included).
#   2. TYPECHECK  the Foundation-only model/display layer (no SwiftUI, no Combine).
#   3. TEST       the XCTest suites that only need that layer, actually executed.
#
# What it does NOT do, and cannot: compile or run anything that imports SwiftUI, UIKit, Combine,
# CryptoKit, Security, Contacts or WebKit — the views, the coordinators, the keychain and the Mera
# bridge. Those still need `make test-ios` on macOS. Do not read a pass here as "the iOS app builds".
#
# Usage:  SWIFT_HOME=/path/to/swift-6.x-RELEASE-ubuntu24.04 scripts/verify/swift-linux-check.sh
#         (or have `swiftc` on PATH)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${SWIFT_CHECK_WORKDIR:-$(mktemp -d)}"

if [[ -n "${SWIFT_HOME:-}" ]]; then
  export PATH="$SWIFT_HOME/usr/bin:$PATH"
  # The official toolchain links against libncurses.so.6; Ubuntu 24.04 ships libncursesw.so.6.
  if ! ldconfig -p | grep -q 'libncurses\.so\.6'; then
    mkdir -p "$WORK/shim"
    ln -sf /usr/lib/x86_64-linux-gnu/libncursesw.so.6 "$WORK/shim/libncurses.so.6"
    export LD_LIBRARY_PATH="$WORK/shim:${LD_LIBRARY_PATH:-}"
  fi
fi
command -v swiftc >/dev/null || { echo "no swiftc on PATH; set SWIFT_HOME=<toolchain>"; exit 2; }
echo "== toolchain: $(swiftc --version | head -1)"

# --- 1. parse everything ------------------------------------------------------
echo "== parse (all iOS sources)"
parsed=0; failed=0
while IFS= read -r file; do
  parsed=$((parsed + 1))
  if ! out="$(swiftc -parse -swift-version 5 "$file" 2>&1)" || [[ -n "$out" ]]; then
    failed=$((failed + 1)); echo "--- $file"; echo "$out" | head -8
  fi
done < <(find "$ROOT/ios" -name '*.swift' | sort)
echo "   parsed $parsed file(s), $failed with diagnostics"
[[ $failed -eq 0 ]] || exit 1

# --- 2 & 3. typecheck + run the platform-independent layer --------------------
# Excluded: anything importing an Apple UI/crypto/platform framework, anything using Combine's
# ObservableObject/@Published, PrismAPI (Keychain + Contacts) and APIClient (URLSession lives in
# FoundationNetworking on Linux).
PKG="$WORK/PrismTestPkg"
rm -rf "$PKG"; mkdir -p "$PKG/Sources/Prism" "$PKG/Tests/PrismTests"

while IFS= read -r file; do
  grep -qE "^import (SwiftUI|UIKit|Combine|WebKit|LocalAuthentication|CryptoKit|Security|AuthenticationServices|Contacts|CoreImage|AVFoundation|CoreText|OSLog)" "$file" && continue
  grep -qE "ObservableObject|@Published" "$file" && continue
  [[ "$file" =~ Services/PrismAPI|Networking/APIClient ]] && continue
  cp "$file" "$PKG/Sources/Prism/"
done < <(find "$ROOT/ios/Prism" -name '*.swift')

# The proof model's only SwiftUI dependency is a tone -> Color mapping no test exercises.
python3 - "$ROOT" "$PKG" <<'PY'
import sys
root, pkg = sys.argv[1], sys.argv[2]
src = open(f'{root}/ios/Prism/Models/PrismProofModel.swift').read().replace('import SwiftUI', 'import Foundation')
start = src.index('extension ProofTone {\n  var color: Color {')
end = src.index('#if DEBUG', start)
open(f'{pkg}/Sources/Prism/PrismProofModel.swift', 'w').write(
    src[:start] + '// [linux-check] ProofTone.color (SwiftUI) omitted.\n\n' + src[end:])
PY

# Two design-system declarations the model layer refers to, copied verbatim from their SwiftUI files.
cat > "$PKG/Sources/Prism/LinuxDesignShim.swift" <<'EOF'
// Verbatim from ios/Prism/DesignSystem/PrismComponents.swift and Features/Circles/CircleStates.swift,
// whose remaining contents are SwiftUI. Cases only — the Color mappings are not needed here.
enum PrismStatusTone { case positive, pending, danger, neutral }
enum CircleTone: Equatable { case positive, waiting, attention, neutral }
EOF

for suite in CircleReceiptTests CircleApprovalWireTests CircleSafeTxHashTests CircleSafeTxVectorsFixture \
             PaymentDetailsModelTests PaymentProofTests PrismCanonicalModelTests PrismContinuityTests \
             ClaimDisplayTests MoneyTests AuroraRouteDisplayTests AuroraDepositDisplayTests; do
  cp "$ROOT/ios/PrismTests/$suite.swift" "$PKG/Tests/PrismTests/" 2>/dev/null || true
done

cat > "$PKG/Package.swift" <<'EOF'
// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "Prism", targets: [
  .target(name: "Prism", path: "Sources/Prism"),
  .testTarget(name: "PrismTests", dependencies: ["Prism"], path: "Tests/PrismTests")
])
EOF

echo "== typecheck + test ($(ls "$PKG/Sources/Prism" | wc -l) sources, $(ls "$PKG/Tests/PrismTests" | wc -l) test files)"
cd "$PKG" && swift test 2>&1 | tail -5
