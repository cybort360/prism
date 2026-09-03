import { config } from '../config.js';
import { ausdBalanceOf, monBalanceOf } from '../chain/eth.js';
import { chainProvider } from '../providers/index.js';
import { envioIndexer } from '../indexers/index.js';

const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * Developer/judge proof surface for a single payment. Combines live chain reads (Alchemy) with the
 * Envio index and the operation's recorded timings, so a judge can independently see: which network,
 * the AUSD token, the Mera account, that the payer can pay with MON = 0, the payment id, the tx hash,
 * submitted/confirmed/indexed times, the Envio proof, the recipient's AUSD before/after, and the
 * request binding. Not exposed to normal consumers.
 */
export class ProofService {
  constructor({ paymentService }) {
    this.paymentService = paymentService;
  }

  async build(paymentId, actorPrismId) {
    const op = await this.paymentService.proofFor(paymentId, actorPrismId);
    const env = op.env;
    const [senderMon, senderAusd, recipientAusd] = await Promise.all([
      monBalanceOf(env.payer).catch(() => null),
      ausdBalanceOf(env.payer).catch(() => null),
      ausdBalanceOf(env.recipient).catch(() => null)
    ]);
    const useEnvio = envioIndexer().available();
    const envioProof = useEnvio ? await envioIndexer().getPayment(paymentId) : null;
    const hasRequest = env.requestId && env.requestId !== ZERO32;
    const requestSettlement = useEnvio && hasRequest ? await envioIndexer().getRequestSettlement(env.requestId) : null;

    // recipient AUSD "before" is derivable once the payment is confirmed (it credited exactly amount).
    const completed = op.state === 'completed';
    const recipientBefore = completed && recipientAusd != null ? recipientAusd - BigInt(env.amount) : null;

    return {
      network: { chainId: config.chain.chainId.toString(), rpcHost: chainProvider().rpcHost, provider: chainProvider().name },
      ausd: config.chain.ausd,
      meraAccount: env.payer,
      recipient: env.recipient,
      amountAtomic: env.amount,
      senderMonBalance: str(senderMon),
      senderAusdBalance: str(senderAusd),
      recipientAusdBefore: str(recipientBefore),
      recipientAusdAfter: str(recipientAusd),
      paymentId,
      txHash: op.transactionHash ?? op.txHash ?? null,
      blockNumber: op.blockNumber ?? null,
      state: op.state,
      submittedAt: op.submittedAt ?? null,
      confirmedAt: op.completedAt ?? null,
      indexedAt: op.indexedAt ?? null,
      indexed: op.indexed ?? false,
      envioProof,
      requestId: hasRequest ? env.requestId : null,
      requestSettlement
    };
  }
}

function str(v) { return v == null ? null : v.toString(); }
