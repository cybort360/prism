import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useConnect, useChainId, useSignMessage } from 'wagmi';
import { getAddress } from 'viem';
import { getPublicRequest, quote as quoteApi, fulfill as fulfillApi, type PublicRequest, type QuoteResult, type FulfillResult } from './api';
import { CHAIN_SLUG } from './wagmi';

const usd = (atomic: string) => `$${(Number(atomic) / 1e6).toFixed(2)}`;

// Canonical message the payer signs. MUST match the backend's crossChainPayService.paymentMessage
// byte-for-byte (same field order, same `getAddress` checksums), or signature verification fails.
function paymentMessage(req: PublicRequest, requesterAccount: string, payer: string) {
  return `Prism cross-chain payment\nRequest: ${req.requestId}\nAmount: ${req.amountAtomic} ${req.token}\nTo: ${getAddress(requesterAccount)}\nFrom: ${getAddress(payer)}`;
}

const NOTICE = 'Demo: the Aurora route is real; settlement is simulated on testnet.';

export function PayPage() {
  const { requestId = '' } = useParams();
  const [req, setReq] = useState<PublicRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [route, setRoute] = useState<QuoteResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<FulfillResult | null>(null);

  useEffect(() => {
    getPublicRequest(requestId)
      .then(setReq)
      .catch(() => setLoadError('This request link is invalid, expired, or already paid.'));
  }, [requestId]);

  async function getQuote() {
    setActionError(null);
    setBusy(true);
    try {
      const slug = CHAIN_SLUG[chainId];
      if (!slug) { setActionError('Switch your wallet to Base, Arbitrum, or Ethereum.'); return; }
      setRoute(await quoteApi(requestId, { payerAddress: address!, sourceChain: slug, sourceAsset: 'USDC' }));
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!req || !route || !address) return;
    setActionError(null);
    setBusy(true);
    try {
      const slug = CHAIN_SLUG[chainId];
      if (!slug) { setActionError('Switch your wallet to a supported chain.'); return; }
      const signature = await signMessageAsync({ message: paymentMessage(req, route.requester.account, address) });
      setDone(await fulfillApi(requestId, { payerAddress: address, sourceChain: slug, signature }));
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <main className="card"><p className="error">{loadError}</p></main>;
  if (!req) return <main className="card"><p className="muted">Loading…</p></main>;
  if (req.status !== 'OPEN' && !done) return <main className="card"><p className="muted">This request is {req.status.toLowerCase()}.</p></main>;

  const who = req.requesterDisplayName ?? (req.requesterHandle ? `@${req.requesterHandle}` : 'Someone');

  if (done) {
    return (
      <main className="card">
        <div className="check">✓</div>
        <h1>Paid</h1>
        <p className="lead">{who} received {usd(req.amountAtomic)}{req.destination !== 'PRIMARY' ? ` in their ${req.destination.toLowerCase()}` : ''}.</p>
        <p className="notice">{NOTICE}</p>
      </main>
    );
  }

  const slugKnown = Boolean(CHAIN_SLUG[chainId]);

  return (
    <main className="card">
      <p className="eyebrow">Payment request</p>
      <h1>{who} requests {usd(req.amountAtomic)}</h1>
      {req.memo && <p className="memo">“{req.memo}”</p>}
      {req.destination !== 'PRIMARY' && <p className="dest">Lands in their {req.destination.toLowerCase()}</p>}

      {!isConnected ? (
        <div className="stack">
          <p className="lead">Connect a wallet to pay from any chain.</p>
          {connectors.map((c) => (
            <button key={c.uid} className="btn" onClick={() => connect({ connector: c })}>Connect {c.name}</button>
          ))}
        </div>
      ) : (
        <div className="stack">
          <p className="addr">Connected {address?.slice(0, 6)}…{address?.slice(-4)}{slugKnown ? ` · ${CHAIN_SLUG[chainId]}` : ''}</p>

          {!route ? (
            <button className="btn" onClick={getQuote} disabled={busy}>{busy ? 'Getting quote…' : 'Get quote'}</button>
          ) : (
            <div className="route">
              <p>Pay ~{route.route.amountInFormatted ?? usd(route.amountAtomic)} USDC on {CHAIN_SLUG[chainId]}</p>
              <p className="muted">Aurora routes it → {who} receives {usd(req.amountAtomic)} on Monad{route.route.timeEstimate ? ` · ~${route.route.timeEstimate}s` : ''}</p>
              <button className="btn primary" onClick={pay} disabled={busy}>{busy ? 'Completing payment…' : `Pay ${usd(req.amountAtomic)}`}</button>
            </div>
          )}
        </div>
      )}

      {actionError && <p className="error">{actionError}</p>}
      <p className="notice">{NOTICE}</p>
    </main>
  );
}
