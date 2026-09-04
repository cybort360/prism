/*
 * Envio HyperIndex handlers for Prism's on-chain payment surface on Monad.
 * Populates Payment, Claim, AccountActivity, RequestSettlement and VaultTransfer — the entities the
 * Prism backend consumes for reconciled historical activity. Generated types come from `envio codegen`.
 *
 * These handlers only project what the chain already emitted; they never invent financial state.
 */
import { PrismPaymentRouter, PrismClaimVault, AUSD, USDC } from "generated";

const ZERO32 = "0x" + "0".repeat(64);
const ROUTER = (process.env.PRISM_PAYMENT_ROUTER ?? "").toLowerCase();
const VAULT = (process.env.PRISM_CLAIM_VAULT ?? "").toLowerCase();

function activityId(event: { transaction: { hash: string }; logIndex: number }, account: string) {
  return `${event.transaction.hash}-${event.logIndex}-${account.toLowerCase()}`;
}

PrismPaymentRouter.PaymentSettled.handler(async ({ event, context }) => {
  const { paymentId, payer, recipient, token, amount, requestId, resolutionHash } = event.params;
  context.Payment.set({
    id: paymentId,
    payer,
    recipient,
    token,
    amount,
    requestId,
    resolutionHash,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  context.AccountActivity.set({
    id: activityId(event, payer), account: payer, counterparty: recipient, direction: "sent",
    kind: "payment", token, amount, ref: paymentId, txHash: event.transaction.hash,
    blockNumber: event.block.number, timestamp: event.block.timestamp,
  });
  context.AccountActivity.set({
    id: activityId(event, recipient), account: recipient, counterparty: payer, direction: "received",
    kind: "payment", token, amount, ref: paymentId, txHash: event.transaction.hash,
    blockNumber: event.block.number, timestamp: event.block.timestamp,
  });

  if (requestId !== ZERO32) {
    context.RequestSettlement.set({
      id: requestId, paymentId, payer, recipient, token, amount,
      txHash: event.transaction.hash, timestamp: event.block.timestamp,
    });
  }
});

PrismClaimVault.ClaimFunded.handler(async ({ event, context }) => {
  const { claimId, sender, token, amount, expiry, recipientReference } = event.params;
  context.Claim.set({
    id: claimId, status: "Funded", sender, recipient: undefined, token, amount,
    expiry: Number(expiry), recipientReference,
    fundedTx: event.transaction.hash, resolvedTx: undefined,
    fundedAt: event.block.timestamp, resolvedAt: undefined,
  });
  context.AccountActivity.set({
    id: activityId(event, sender), account: sender, counterparty: undefined, direction: "sent",
    kind: "claim_fund", token, amount, ref: claimId, txHash: event.transaction.hash,
    blockNumber: event.block.number, timestamp: event.block.timestamp,
  });
});

PrismClaimVault.ClaimCollected.handler(async ({ event, context }) => {
  const { claimId, recipient, token, amount } = event.params;
  const existing = await context.Claim.get(claimId);
  if (existing) {
    context.Claim.set({ ...existing, status: "Claimed", recipient, resolvedTx: event.transaction.hash, resolvedAt: event.block.timestamp });
  }
  context.AccountActivity.set({
    id: activityId(event, recipient), account: recipient, counterparty: existing?.sender, direction: "received",
    kind: "claim_collect", token, amount, ref: claimId, txHash: event.transaction.hash,
    blockNumber: event.block.number, timestamp: event.block.timestamp,
  });
});

PrismClaimVault.ClaimRefunded.handler(async ({ event, context }) => {
  const { claimId, sender, token, amount } = event.params;
  const existing = await context.Claim.get(claimId);
  if (existing) {
    context.Claim.set({ ...existing, status: "Refunded", resolvedTx: event.transaction.hash, resolvedAt: event.block.timestamp });
  }
  context.AccountActivity.set({
    id: activityId(event, sender), account: sender, counterparty: undefined, direction: "received",
    kind: "claim_refund", token, amount, ref: claimId, txHash: event.transaction.hash,
    blockNumber: event.block.number, timestamp: event.block.timestamp,
  });
});

async function recordVaultTransfer(event: any, context: any, token: string) {
  const from = event.params.from.toLowerCase();
  const to = event.params.to.toLowerCase();
  if (from !== ROUTER && to !== ROUTER && from !== VAULT && to !== VAULT) return;
  context.VaultTransfer.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    from: event.params.from, to: event.params.to, token, value: event.params.value,
    txHash: event.transaction.hash, timestamp: event.block.timestamp,
  });
}

// Only supported-token transfers touching the Prism router or vault.
AUSD.Transfer.handler(async ({ event, context }) => {
  await recordVaultTransfer(event, context, "AUSD");
});

USDC.Transfer.handler(async ({ event, context }) => {
  await recordVaultTransfer(event, context, "USDC");
});
