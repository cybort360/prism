#!/usr/bin/env bash
# Verify Prism contracts on the Monad explorer after deployment.
#
# Reads addresses from the generated manifest (deployments/monad-<network>.json) — never from Swift.
# Requires: forge, jq, and the deployed addresses present in the manifest.
#
# Usage:
#   MONAD_VERIFIER_URL=<blockscout/sourcify verifier url> ./script/verify.sh testnet
#
# Monad's explorer supports Sourcify-style verification; set MONAD_VERIFIER_URL to the explorer's
# verification endpoint (e.g. https://testnet.monadexplorer.com/api or a Sourcify instance).
set -euo pipefail

NETWORK="${1:-testnet}"
MANIFEST="$(dirname "$0")/../../deployments/monad-${NETWORK}.json"
VERIFIER_URL="${MONAD_VERIFIER_URL:-https://sourcify.dev/server}"
VERIFIER="${MONAD_VERIFIER:-sourcify}"

if [ ! -f "$MANIFEST" ]; then echo "manifest not found: $MANIFEST"; exit 1; fi

USDC=$(jq -r .usdc "$MANIFEST")
ROUTER=$(jq -r .paymentRouter "$MANIFEST")
VAULT=$(jq -r .claimVault "$MANIFEST")
AUTHORIZER=$(jq -r .claimAuthorizer "$MANIFEST")
DEPLOYER=$(jq -r .deployer "$MANIFEST")
CHAIN_ID=$(jq -r .chainId "$MANIFEST")

if [ "$ROUTER" = "null" ] || [ "$VAULT" = "null" ]; then
  echo "manifest has no deployed addresses yet — run the deploy script first."; exit 1
fi

echo "Verifying PrismPaymentRouter @ $ROUTER"
forge verify-contract "$ROUTER" src/PrismPaymentRouter.sol:PrismPaymentRouter \
  --chain-id "$CHAIN_ID" --verifier "$VERIFIER" --verifier-url "$VERIFIER_URL" \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$USDC")" --watch

echo "Verifying PrismClaimVault @ $VAULT"
forge verify-contract "$VAULT" src/PrismClaimVault.sol:PrismClaimVault \
  --chain-id "$CHAIN_ID" --verifier "$VERIFIER" --verifier-url "$VERIFIER_URL" \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' "$DEPLOYER" "$USDC" "$AUTHORIZER")" --watch

echo "Verification submitted for both contracts."
