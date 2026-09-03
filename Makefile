.PHONY: test test-backend test-contracts test-ios lint zip

test: test-backend test-contracts test-ios

test-backend:
	cd backend && npm install --silent && node --test test/*.test.js

test-contracts:
	cd contracts && forge install foundry-rs/forge-std --no-git >/dev/null 2>&1 || true; forge test -vvv

test-ios:
	cd ios && xcodegen generate && \
	xcodebuild -project Prism.xcodeproj -scheme Prism -sdk iphonesimulator \
	  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test

zip:
	cd .. && zip -r prism-v1.zip prism-v1 -x '*/.git/*' '*/node_modules/*' '*/out/*' '*/cache/*' '*/DerivedData/*'
