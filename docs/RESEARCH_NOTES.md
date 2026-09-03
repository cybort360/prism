# Research decisions used by this build

Research snapshot: **2026-09-02**. Every external value below was verified against the live
source on that date. Contract addresses are additionally re-verified at runtime (see "Verify, don't
trust").

## Mera (Category Labs) — the consumer account/signing layer

- `@category-labs/mera` is a first-party TypeScript library that derives **32 secret bytes from a
  passkey via the WebAuthn PRF extension** and turns them into a **standard secp256k1 EVM account**
  (and an ed25519 Solana account). No seed phrase, no bundler, no MPC service, no backend custody.
- Because the derived account is a **standard EOA-style secp256k1 signer**, it produces ordinary
  ECDSA signatures — which is exactly what AUSD's ERC-3009 `ecrecover` path expects. No ERC-4337,
  smart-account, or EIP-1271 machinery is required for the payment primitive.
- Official API used by Prism's bridge: `createPasskeyWithPrfOutput`, `getPasskeyPrfOutput`,
  `getEvmAddress`, `createSecp256k1SigningSession` (returns a session holding a `SigningKey` whose
  `end()` zeros the warm key). The library is built on viem.
- Platform support: web, Chrome extensions, and React Native on iOS 18+/Android 9+. Native apps
  reuse the same passkeys through the platform's WebAuthn APIs. Prism keeps its native Swift app and
  runs the official library through the smallest legitimate bridge (an offscreen WKWebView), rather
  than rewriting in React Native. See `ios/MeraBridge/`.
- Source: <https://github.com/category-labs/mera>, <https://mera.category.xyz>,
  <https://www.monad.xyz/blog/introducing-mera>, Monad docs → Embedded Wallets.

## Agora AUSD — the payment asset

- AUSD implements ERC-20, EIP-712, **ERC-2612 permit**, **ERC-3009 gasless transfers**
  (`transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization`), and ERC-1271.
- Verified token addresses (Agora contract-deployments):
  - Monad **mainnet**: `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` (chainId 143)
  - Monad **testnet**: `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (chainId 10143)
- EIP-712 domain: name **"Agora Dollar"**, version **"1"**. Decimals: **6**.
- Prism's direct-payment primitive is ERC-3009 `receiveWithAuthorization`, pulled by
  `PrismPaymentRouter`, so a payer holding AUSD > 0 and MON = 0 can still pay.
- Source: <https://docs.agora.finance/developer/contract-deployments>,
  <https://docs.agora.finance/developer/advanced-erc-features>.

## Monad — the settlement chain

- Mainnet: chainId **143**, RPC `https://rpc.monad.xyz` (Alchemy alt `https://rpc1.monad.xyz`).
- Testnet: chainId **10143**, RPC `https://testnet-rpc.monad.xyz`.
- Native gas token: **MON**. EVM-equivalent L1.
- Source: <https://docs.monad.xyz/developer-essentials/network-information>.

## Alchemy — production infrastructure

- Alchemy provides Monad RPC endpoints (`https://monad-{mainnet,testnet}.g.alchemy.com/v2/<key>`),
  a **Gas Manager** for gas sponsorship, and Webhooks. Prism uses Alchemy as its production RPC and
  documents Gas Manager as the production alternative to the self-funded relayer.
- Source: <https://www.alchemy.com/rpc/monad>, <https://docs.monad.xyz/tooling-and-infra/rpc-providers>.

## Envio — indexing

- Envio HyperIndex + HyperSync support Monad with full trace history from block 0 (HyperIndex
  v2.15.0). Prism indexes AUSD transfers, `PrismPayment` router events, and `PrismClaimVault` events
  into the product's activity/reconciliation layer.
- Source: <https://docs.envio.dev/blog/how-to-index-monad-data-using-envio>,
  <https://docs.monad.xyz/guides/indexers/tg-bot-using-envio>.

## Apple

- WebAuthn/passkeys (incl. the PRF extension Mera relies on) are reused inside WKWebView through the
  platform authenticator; the app declares an Associated Domain for the relying party.
- `LAContext` (Face ID) and Keychain `ThisDeviceOnly` remain the local approval + secret-storage
  primitives. Twilio Verify is called only from the backend.

## Verify, don't trust

The listed AUSD addresses and EIP-712 domain are treated as *inputs to verify*, not facts to trust:
`backend/src/chain/eth.js#verifyAusdDomain` recomputes AUSD's EIP-712 domain separator and compares
it to the token's on-chain `DOMAIN_SEPARATOR()` before Prism will relay, failing closed on any
drift. Contract deploy scripts take the AUSD address as an explicit, comment-flagged input.
