#!/usr/bin/env bash
# Push the backend's secrets to Fly from your local .env, then deploy. Run from backend/.
#   ./deploy-fly.sh                 # set secrets + deploy
#   ./deploy-fly.sh --secrets-only  # set secrets, skip deploy
#
# Reads backend/.env (gitignored). Secret VALUES are never printed — only names. The 4 crypto
# secrets (SESSION_SECRET, RESOLVER_PEPPER, DATA_ENCRYPTION_KEY, SERVICE_KEY_ENCRYPTION_KEY) are
# generated as strong random values if they are missing or still the dev defaults. APPLE_APP_ID
# (<TeamID>.com.prism.mobile) must be set in .env or exported — it is required so the backend serves
# the passkey AASA. See DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")"

command -v fly >/dev/null 2>&1 || { echo "flyctl not found. brew install flyctl" >&2; exit 1; }
[[ -f .env ]] || { echo ".env not found in $(pwd)" >&2; exit 1; }

# Load .env without exporting it into child processes we don't control.
set -a; . ./.env; set +a

gen() { openssl rand -hex 32; }
is_dev_or_empty() { local v="${1:-}"; [[ -z "$v" || "$v" == dev-* || "$v" == "$(printf '11%.0s' {1..32})" || "$v" == "$(printf '22%.0s' {1..32})" ]]; }

# Strong random crypto secrets where the local value is empty or a dev default.
is_dev_or_empty "${SESSION_SECRET:-}"            && SESSION_SECRET="$(gen)"
is_dev_or_empty "${RESOLVER_PEPPER:-}"           && RESOLVER_PEPPER="$(gen)"
is_dev_or_empty "${DATA_ENCRYPTION_KEY:-}"       && DATA_ENCRYPTION_KEY="$(gen)"
is_dev_or_empty "${SERVICE_KEY_ENCRYPTION_KEY:-}" && SERVICE_KEY_ENCRYPTION_KEY="$(gen)"

# Required from .env / env.
: "${RELAYER_PRIVATE_KEY:?set RELAYER_PRIVATE_KEY in .env (MON-funded relayer)}"
: "${CLAIM_AUTHORIZER_PRIVATE_KEY:?set CLAIM_AUTHORIZER_PRIVATE_KEY in .env}"
: "${PRISM_PAYMENT_ROUTER:?set PRISM_PAYMENT_ROUTER in .env}"
: "${PRISM_CLAIM_VAULT:?set PRISM_CLAIM_VAULT in .env}"
# APPLE_APP_ID is OPTIONAL: without it the backend simply does not serve the passkey AASA (fine for a
# backend smoke deploy). Set it (=<TeamID>.com.prism.mobile) once you have an Apple Team ID, so device
# passkeys and external TestFlight review work.
if [[ -z "${APPLE_APP_ID:-}" ]]; then
  echo "note: APPLE_APP_ID unset — deploying without the passkey AASA (set it later for TestFlight)."
fi

echo "Setting Fly secrets (values hidden):"
printf '  %s\n' SESSION_SECRET RESOLVER_PEPPER DATA_ENCRYPTION_KEY SERVICE_KEY_ENCRYPTION_KEY \
  RELAYER_PRIVATE_KEY CLAIM_AUTHORIZER_PRIVATE_KEY PRISM_PAYMENT_ROUTER PRISM_CLAIM_VAULT \
  ${APPLE_APP_ID:+APPLE_APP_ID}

fly secrets set --stage \
  SESSION_SECRET="$SESSION_SECRET" \
  RESOLVER_PEPPER="$RESOLVER_PEPPER" \
  DATA_ENCRYPTION_KEY="$DATA_ENCRYPTION_KEY" \
  SERVICE_KEY_ENCRYPTION_KEY="$SERVICE_KEY_ENCRYPTION_KEY" \
  RELAYER_PRIVATE_KEY="$RELAYER_PRIVATE_KEY" \
  CLAIM_AUTHORIZER_PRIVATE_KEY="$CLAIM_AUTHORIZER_PRIVATE_KEY" \
  PRISM_PAYMENT_ROUTER="$PRISM_PAYMENT_ROUTER" \
  PRISM_CLAIM_VAULT="$PRISM_CLAIM_VAULT" \
  ${APPLE_APP_ID:+APPLE_APP_ID="$APPLE_APP_ID"} \
  ${MONAD_RPC_URL:+MONAD_RPC_URL="$MONAD_RPC_URL"} \
  ${AURORA_MODE:+AURORA_MODE="$AURORA_MODE"} \
  ${AURORA_APP_KEY:+AURORA_APP_KEY="$AURORA_APP_KEY"}

if [[ "${1:-}" == "--secrets-only" ]]; then
  echo "Secrets staged. Run 'fly deploy' when ready."
  exit 0
fi
fly deploy
echo "Deployed. Verify (use your fly.dev host, or app.getprism.xyz once certs are attached):"
echo "  fly open /health"
echo "  curl -s https://\$(fly info --json | jq -r .Hostname)/health"
