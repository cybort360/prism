#!/usr/bin/env bash
# Prints an xcodebuild -destination argument for an available iPhone simulator.
#
# Simulator device names differ across Xcode versions and CI runner images, so a hard-coded
# name (e.g. "iPhone 17 Pro") fails outright wherever that device is absent. Resolve one at
# run time instead. Override with IOS_DESTINATION to target a specific device.
set -euo pipefail

if [[ -n "${IOS_DESTINATION:-}" ]]; then
  printf '%s' "$IOS_DESTINATION"
  exit 0
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun not found — iOS builds require macOS with Xcode installed." >&2
  exit 1
fi

udid=$(xcrun simctl list devices available --json | python3 -c '
import json, sys

devices = json.load(sys.stdin)["devices"]
# Newest iOS runtime first, so a runner with several SDKs uses the most recent one.
for runtime in sorted((r for r in devices if "iOS" in r), reverse=True):
    for device in devices[runtime]:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("no available iPhone simulator found")
')

printf 'id=%s' "$udid"
