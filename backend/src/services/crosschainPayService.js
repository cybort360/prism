import { getAddress, isAddress } from 'viem';
import { auroraApiClient } from '../aurora/index.js';
import { knownChain, resolveAsset } from '../aurora/assets.js';
import { mintUsdcTo } from '../chain/eth.js';

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
}
