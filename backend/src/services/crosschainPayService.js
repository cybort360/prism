import { getAddress, isAddress } from 'viem';
import { auroraApiClient } from '../aurora/index.js';
import { knownChain, resolveAsset } from '../aurora/assets.js';
import { verifyAccountMessage, mintUsdcTo } from '../chain/eth.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

export class CrossChainPayService {
  constructor({ store, config, requestService, sweepService, auroraClient = auroraApiClient, mint = mintUsdcTo }) {
    this.store = store; this.config = config; this.requests = requestService; this.sweeps = sweepService;
    this.aurora = auroraClient; this.mint = mint;
  }

  _openRequest(requestId) {
    const view = this.requests.getPublicView(requestId); // throws 404 if not a public request
    if (view.status !== 'OPEN') throw httpError(409, 'this request is not open');
    if (!view.requesterAccount || !isAddress(view.requesterAccount)) throw httpError(409, 'this request has no payable account');
    return view;
  }

  async quote({ requestId, payerAddress, sourceChain, sourceAsset }) {
    const view = this._openRequest(requestId);
    if (!isAddress(String(payerAddress ?? ''))) throw httpError(400, 'a valid payer address is required');
    const chain = String(sourceChain ?? '').trim().toLowerCase();
    if (!knownChain(chain)) throw httpError(400, `unsupported source chain '${chain}'`);

    const origin = await resolveAsset(chain, sourceAsset || 'USDC');
    if (!origin.ok) throw httpError(400, origin.reason, origin.options);
    const destChain = this.config.aurora.destinationChain; // monad
    const destination = await resolveAsset(destChain, 'USDC');
    if (!destination.ok) throw httpError(503, `cannot resolve USDC on ${destChain}: ${destination.reason}`);

    // Always a real DRY quote — the active client is the demo stub in demo mode and returns null.
    const quoted = await this.aurora.quote({
      dry: true, swapType: 'EXACT_OUTPUT', depositType: 'ORIGIN_CHAIN',
      amount: String(view.amountAtomic),
      originAsset: origin.asset.assetId, destinationAsset: destination.asset.assetId,
      recipient: getAddress(view.requesterAccount), recipientType: 'DESTINATION_CHAIN',
      refundTo: getAddress(payerAddress), refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 5 * 60_000).toISOString()
    });
    if (!quoted?.quote) throw httpError(502, 'Aurora could not quote this route');

    return {
      requestId, amountAtomic: view.amountAtomic, destinationChain: destChain,
      requester: { handle: view.requesterHandle, account: view.requesterAccount },
      route: quoted.quote,
      preview: this.config.aurora.mode !== 'demo' // demo → will settle (mint); else quote-only
    };
  }

  paymentMessage(view, payerAddress) {
    // Human-readable, and binds the exact request + amount + both parties so a captured signature
    // cannot be reused for another request (and the OPEN→PAID transition blocks re-use of this one).
    return `Prism cross-chain payment\nRequest: ${view.requestId}\nAmount: ${view.amountAtomic} ${view.token}\nTo: ${getAddress(view.requesterAccount)}\nFrom: ${getAddress(payerAddress)}`;
  }

  async _verify(payerAddress, message, signature) {
    return verifyAccountMessage(payerAddress, message, signature);
  }

  async fulfill({ requestId, payerAddress, sourceChain, signature }) {
    const view = this._openRequest(requestId);
    // strict:false — well-formed hex address only; we don't require EIP-55 checksum casing from callers.
    if (!isAddress(String(payerAddress ?? ''), { strict: false })) throw httpError(400, 'a valid payer address is required');
    const chain = String(sourceChain ?? '').trim().toLowerCase();
    if (!knownChain(chain)) throw httpError(400, `unsupported source chain '${chain}'`);

    const ok = await this._verify(payerAddress, this.paymentMessage(view, payerAddress), signature);
    if (!ok) throw httpError(400, 'payment signature does not match the connected wallet');

    if (this.config.aurora.mode !== 'demo') {
      // preview: real quote shown, but this build cannot settle (Aurora carries Monad mainnet only).
      throw httpError(409, 'settlement is not available on this deployment (AURORA_MODE must be demo)');
    }

    // Single-flight claim BEFORE the mint: a synchronous OPEN→settling transition so two concurrent
    // fulfillments of the same request can't both pass the OPEN check and both credit the requester
    // (TOCTOU double-spend). The claim throws 409 if another fulfillment already holds it or the
    // request is no longer OPEN — the authoritative check, re-validated atomically here rather than at
    // the earlier _openRequest read (which is only an early-out and the source of `view`).
    this.requests.claimForCrossChainSettlement(requestId);

    let deliveryTxHash;
    try {
      // Simulated Aurora delivery = a real on-chain USDC mint to the requester (money-truth credit).
      deliveryTxHash = await this.mint(view.requesterAccount, view.amountAtomic);
    } catch (err) {
      // The credit never happened — release the claim so the request is payable again, never stuck.
      this.requests.releaseCrossChainSettlement(requestId);
      throw err;
    }

    // Mark PAID with the cross-chain payer (also clears the claim), then relay the pre-signed sweep.
    this.requests.markPaid(requestId, null, deliveryTxHash, { payerAddress: getAddress(payerAddress), sourceChain: chain });
    const sweep = await this.sweeps.executeFor(requestId).catch(() => ({ state: 'FAILED' }));

    return { status: 'PAID', deliveryTxHash, destination: view.destination, sweep };
  }
}
