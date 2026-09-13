.PHONY: test test-backend test-contracts test-ios test-circles audit zip

test: test-backend test-contracts test-ios

test-backend:
	cd backend && npm install --silent && node --test test/*.test.js

# The Circles suite is excluded here: it forks Monad and needs `--network monad` plus ffi.
# Run it with `make test-circles`.
test-contracts:
	cd contracts && forge install foundry-rs/forge-std --no-git >/dev/null 2>&1 || true; \
	forge test -vvv --no-match-path 'test/circles/*'

# Prism Circles architecture proof (Phases 1-3). Needs network access: the suite runs against the
# real Safe v1.4.1 deployment on a Monad testnet fork, the real EIP-7951 P-256 precompile, and the
# real USDC contract. `--network monad` is required or the precompile silently returns nothing.
test-circles:
	cd contracts && forge install foundry-rs/forge-std --no-git >/dev/null 2>&1 || true; \
	FOUNDRY_PROFILE=circles forge test --match-path 'test/circles/*' --network monad -vv
	cd tools/circles && npm install --silent && npm run verify

# Requires macOS with Xcode. Override the simulator with IOS_DESTINATION=...
test-ios:
	cd ios && xcodegen generate && \
	xcodebuild -project Prism.xcodeproj -scheme Prism -sdk iphonesimulator \
	  -destination "$$(../scripts/ios-destination.sh)" test

# Hostile-audit checks: the privacy leak scanners and the mutation suite (see proof/).
audit:
	cd contracts && forge test --match-path 'test/PrismPrivacy.t.sol' -vv
	cd backend && node --test test/privacy-leak.test.js test/mutation-audit.test.js

zip:
	cd .. && zip -r prism-v1.zip prism-v1 -x '*/.git/*' '*/node_modules/*' '*/out/*' '*/cache/*' '*/DerivedData/*'
