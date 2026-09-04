import { config, supportedToken } from '../config.js';
import { tokenBalanceOf, monBalanceOf } from '../chain/eth.js';
import { chainProvider } from '../providers/index.js';
import { envioIndexer } from '../indexers/index.js';

const ZERO32 = `0x${'00'.repeat(32)}`;

/**
 * Developer/judge proof surface for a single payment. Combines live chain reads (Alchemy) with the
 * Envio index and the operation's recorded timings, so a judge can independently see: which network,
 * the token, the Mera account, payer MON balance, payment id, transaction hash, timestamps,
 * Envio proof, recipient token balances, and the
 * request binding. Not exposed to normal consumers.
 */
export class ProofService {
  constructor({ paymentService }) {
    this.paymentService = paymentService;
  }

  async build(paymentId, actorPrismId) {
    const op = await this.paymentService.proofFor(paymentId, actorPrismId);
    const env = op.env;
    const token = supportedToken(env.token);
    const [senderMon, senderToken, recipientToken] = await Promise.all([
      monBalanceOf(env.payer).catch(() => null),
      tokenBalanceOf(token.symbol, env.payer).catch(() => null),
      tokenBalanceOf(token.symbol, env.recipient).catch(() => null)
    ]);
    const useEnvio = envioIndexer().available();
    const envioProof = useEnvio ? await envioIndexer().getPayment(paymentId) : null;
    const hasRequest = env.requestId && env.requestId !== ZERO32;
    const requestSettlement = useEnvio && hasRequest ? await envioIndexer().getRequestSettlement(env.requestId) : null;

    // The recipient's prior token balance is derivable after a confirmed exact transfer.
    const completed = op.state === 'completed';
    const recipientBefore = completed && recipientToken != null ? recipientToken - BigInt(env.amount) : null;

    return {
      network: { chainId: config.chain.chainId.toString(), rpcHost: chainProvider().rpcHost, provider: chainProvider().name },
      token: token.address,
      tokenSymbol: token.symbol,
      meraAccount: env.payer,
      recipient: env.recipient,
      amountAtomic: env.amount,
      senderMonBalance: str(senderMon),
      senderTokenBalance: str(senderToken),
      recipientTokenBefore: str(recipientBefore),
      recipientTokenAfter: str(recipientToken),
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
