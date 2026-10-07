# Deploying the Prism backend (Fly.io)

A public **https** backend so a device/TestFlight build works — including Apple's Beta App Review for
external testers. This host also serves the Apple App Site Association, so **one domain** covers the
API, device passkeys, and `/pay/*` links.

> This is a **demo/review** backend on **Monad testnet**. It runs outside `NODE_ENV=production` so the
> dev OTP (`123456`) works for the reviewer without Twilio. Do not put real user money through it.

## Architecture (one domain)

```
app.<your-domain>  ──►  Fly app (this backend)
   ├─ /v1/*                                 the API the iOS app calls (PRISM_API_BASE_URL)
   └─ /.well-known/apple-app-site-association   served when APPLE_APP_ID is set (passkeys + links)
```

Point your custom domain at the Fly app and use it for **all three**: `PRISM_API_BASE_URL`, the
`webcredentials:`/`applinks:` entitlement, and the AASA host.

## 1. Install flyctl and sign in

```bash
brew install flyctl    # or: curl -L https://fly.io/install.sh | sh
fly auth login
```

## 2. Launch the app (from this directory)

```bash
cd backend
fly launch --no-deploy        # detects fly.toml + Dockerfile; pick a unique app name + region
fly volumes create prism_data --size 1 --region <your-region>   # durable JSON store at /data
```

## 3. Set secrets

Non-secret config is already in `fly.toml` (`PORT`, `STORE_PATH`, `NODE_ENV=development`,
`MONAD_CHAIN_ID`). Everything below is a secret — set with `fly secrets set` (never commit these):

```bash
fly secrets set \
  RELAYER_PRIVATE_KEY=0x...            # funded with a little MON on Monad testnet (submits gasless txs) \
  CLAIM_AUTHORIZER_PRIVATE_KEY=0x...   # authorizes pre-user claim collection \
  PRISM_PAYMENT_ROUTER=0x...           # your deployed PrismPaymentRouter (Monad testnet) \
  PRISM_CLAIM_VAULT=0x...              # your deployed PrismClaimVault \
  SESSION_SECRET=$(openssl rand -hex 32) \
  RESOLVER_PEPPER=$(openssl rand -hex 32) \
  DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  SERVICE_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  APPLE_APP_ID=TEAMID.com.prism.mobile   # your 10-char Apple Team ID + the app's bundle id
```

Optional, depending on what you want live:
`MONAD_RPC_URL` (defaults to the public node), `AURORA_MODE` + `AURORA_APP_KEY` (cross-chain),
`SAVE_MODE`, `ENVIO_GRAPHQL_URL`.

> The router/vault/authorizer are **not** required to boot in `development`, but payments won't work
> without them — set them so the reviewer sees a functional app. Find your deployed addresses in your
> contract deployment records (`contracts/broadcast/`).

### Required / optional env reference

| Variable | Secret? | Purpose |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | yes | MON-funded relayer that submits gasless ERC-3009 transfers |
| `CLAIM_AUTHORIZER_PRIVATE_KEY` | yes | Signs claim eligibility (send-before-signup) |
| `PRISM_PAYMENT_ROUTER` / `PRISM_CLAIM_VAULT` | yes | Your deployed Monad-testnet contracts |
| `SESSION_SECRET`, `RESOLVER_PEPPER` | yes | 32-byte hex; auth tokens + phone-lookup pepper |
| `DATA_ENCRYPTION_KEY`, `SERVICE_KEY_ENCRYPTION_KEY` | yes | 32-byte hex; at-rest encryption |
| `APPLE_APP_ID` | yes-ish | `<TeamID>.com.prism.mobile`; enables the AASA route |
| `MONAD_CHAIN_ID` | no (in fly.toml) | `10143` (testnet) |
| `NODE_ENV` | no (in fly.toml) | `development` → dev OTP works, no Twilio |
| `MONAD_RPC_URL` | optional | Defaults to the public Monad testnet RPC |
| `AURORA_MODE` / `AURORA_APP_KEY` | optional | Cross-chain routing |

## 4. Deploy

```bash
fly deploy
fly open                       # https://<app>.fly.dev
curl -s https://<app>.fly.dev/health      # {"ok":true,"chainId":"10143"}
```

## 5. Attach your custom domain (for passkeys)

Device passkeys need a domain you control (a `*.fly.dev` host works for the API but a custom domain is
the clean passkey RP). 

```bash
fly certs add app.<your-domain>
# then add the DNS records fly prints (A/AAAA or CNAME) at your registrar
fly certs show app.<your-domain>        # wait until it says the cert is issued
```

Verify the AASA is live and correct:

```bash
curl -s https://app.<your-domain>/.well-known/apple-app-site-association
# webcredentials.apps and applinks...appIDs must equal your APPLE_APP_ID
```

## 6. Wire the iOS app to this backend

In `ios/project.yml`:

- `settings.base.PRISM_API_BASE_URL: "https://app.<your-domain>"`
- Re-add the Associated Domains entitlement pointing at the same domain (see `docs/TESTFLIGHT.md`
  §"Passkeys" — turning this back on is required for external review):
  ```yaml
  entitlements:
    path: Prism/Prism.entitlements
    properties:
      com.apple.developer.associated-domains:
        - webcredentials:app.<your-domain>
        - applinks:app.<your-domain>
  ```

Then `cd ios && ./bootstrap.sh`, archive, and upload.

## App Review notes (paste into App Store Connect → TestFlight → Test Information)

> Prism is a USDC payments demo on the Monad **testnet**. No real funds.
> To sign in: enter any phone number, then the verification code **123456** (test code for this beta).
> Account creation uses a device passkey (Face ID). All balances are testnet USDC.

## Operations

```bash
fly logs                       # tail
fly secrets list               # names only
fly status                     # machines + health
fly ssh console                # shell; the store is at /data/store.json
```
