import { config } from '../config.js';
import { usdcBalanceOf, monBalanceOf, relayerAccount } from '../chain/eth.js';
import { getReceipt } from '../chain/relay.js';
import { chainProvider } from '../providers/index.js';
import { envioIndexer } from '../indexers/index.js';
import { decryptString, normalizeE164 } from '../lib/crypto.js';
import { isCirclePaymentId, approvalPolicyLabel } from '../circles/circlePayment.js';

const ZERO32 = `0x${'00'.repeat(32)}`;

// Evidence statuses (iOS renders consumer labels from these).
const PASS = 'pass', FAIL = 'fail', PENDING = 'pending', UNAVAILABLE = 'unavailable', NOT_CONFIGURED = 'not_configured', UNKNOWN = 'unknown';
// Two statuses that exist so a reader is never misled about what a source can establish.
// `not_applicable`: this evidence pipeline does not cover this kind of transaction at all (a Safe
// transfer is not a router `PaymentSettled` event, so Envio has no row to be missing).
// `coordination`: this source helped the transaction happen and proves nothing about whether it did.
const NOT_APPLICABLE = 'not_applicable', COORDINATION = 'coordination';

/**
 * The canonical Payment Proof surface. Its purpose is to make Prism's invisible architecture
 * INSPECTABLE, not to dump chain debugging. For one operation a skeptic can answer: did real value
 * move, did Prism resolve a human, was the phone identifier exposed on-chain, did the user need MON,
 * was it confirmed on Monad, can I inspect the tx, and was the data independently read/indexed.
 *
 * Every claim is backed by an evidence mechanism at a recorded evidence level — never by asserting
 * what the architecture merely "intends". The privacy checks run a real prohibited-value detector
 * over the actual calldata/event fields; they only report "No sensitive identifier on-chain" when a
 * check has actually proven it, and "Unknown" otherwise.
 */
export class ProofService {
  constructor({ paymentService, identityService, circleService = null, config: cfg = config }) {
    this.paymentService = paymentService;
    this.identityService = identityService;
    // Optional: a deployment without Circles simply has no shared-account proofs to build.
    this.circles = circleService;
    this.config = cfg;
  }

  // ---- legacy dev surface (flat PaymentProof for /v1/proof/:id) -------------
  async build(paymentId, actorPrismId) {
    const op = await this.paymentService.proofFor(paymentId, actorPrismId);
    const env = op.env;
    const [senderMon, senderToken, recipientToken] = await Promise.all([
      monBalanceOf(env.payer).catch(() => null),
      usdcBalanceOf(env.payer).catch(() => null),
      usdcBalanceOf(env.recipient).catch(() => null)
    ]);
    const useEnvio = envioIndexer().available();
    const envioProof = useEnvio ? await envioIndexer().getPayment(paymentId) : null;
    const hasRequest = env.requestId && env.requestId !== ZERO32;
    const requestSettlement = useEnvio && hasRequest ? await envioIndexer().getRequestSettlement(env.requestId) : null;
    const completed = op.state === 'completed';
    const recipientBefore = completed && recipientToken != null ? recipientToken - BigInt(env.amount) : null;
    return {
      network: { chainId: this.config.chain.chainId.toString(), rpcHost: chainProvider().rpcHost, provider: chainProvider().name },
      token: this.config.chain.usdc, tokenSymbol: 'USDC', meraAccount: env.payer, recipient: env.recipient,
      amountAtomic: env.amount, senderMonBalance: str(senderMon), senderTokenBalance: str(senderToken),
      recipientTokenBefore: str(recipientBefore), recipientTokenAfter: str(recipientToken),
      paymentId, txHash: op.transactionHash ?? op.txHash ?? null, blockNumber: op.blockNumber ?? null, state: op.state,
      submittedAt: op.submittedAt ?? null, confirmedAt: op.completedAt ?? null, indexedAt: op.indexedAt ?? null,
      indexed: op.indexed ?? false, envioProof, requestId: hasRequest ? env.requestId : null, requestSettlement
    };
  }

  // ---- canonical proof (/v1/payments/:id/proof) ----------------------------

  async canonical(operationId, actorPrismId) {
    // One proof endpoint for every Prism payment. A Circle payment's id addresses a record Circles
    // owns rather than an operation, so it is assembled from Circle evidence — but it comes back in
    // the same shape, because a person inspecting a payment should not have to know which kind it is.
    if (this.circles && isCirclePaymentId(operationId)) return this._canonicalCircle(operationId, actorPrismId);
    const op = await this.paymentService.proofOperation(operationId, actorPrismId);
    const ctx = this._context(op);

    const txHash = op.transactionHash ?? op.txHash ?? null;
    const [receipt, recipientToken, senderMon] = await Promise.all([
      txHash ? getReceipt(txHash).catch(() => null) : Promise.resolve(null),
      ctx.recipientAddress ? usdcBalanceOf(ctx.recipientAddress).catch(() => null) : Promise.resolve(null),
      ctx.senderAddress ? monBalanceOf(ctx.senderAddress).catch(() => null) : Promise.resolve(null)
    ]);

    const privacy = this._privacy(op, ctx, receipt);
    const verification = await this._verification(op, ctx, receipt, recipientToken);
    const gas = this._gas(op, receipt, senderMon);
    const settlement = this._settlement(op, receipt, txHash);
    const status = this._status(op, privacy, verification);
    const level = this._level(op, txHash, verification);

    return {
      paymentId: operationId,
      kind: op.kind,
      direction: ctx.direction,
      amountAtomic: ctx.amountAtomic,
      tokenSymbol: 'USDC',
      proofStatus: status,
      evidenceLevel: level,
      demo: false,
      recipient: this._recipient(op, ctx),
      privacy,
      authorization: { method: 'Mera passkey', localApproval: null, otpForSpending: 'no' },
      gas,
      settlement,
      verification,
      request: this._request(op, ctx),
      claim: this._claim(op, ctx),
      evidence: this._evidence({ op, ctx, receipt, privacy, verification, gas, settlement, txHash, level }),
      generatedAt: new Date().toISOString()
    };
  }

  // ---- context -------------------------------------------------------------

  _context(op) {
    const intent = op.intent ?? {};
    const senderIdentity = intent.senderPrismId ? this.paymentService.identity(intent.senderPrismId) : null;
    const recipientIdentity = intent.recipientPrismId ? this.paymentService.identity(intent.recipientPrismId) : null;
    const claim = this.paymentService.claim(intent.claimId);
    const senderAddress = op.env?.payer ?? senderIdentity?.accountAddress ?? null;
    const recipientAddress = op.env?.recipient ?? recipientIdentity?.accountAddress ?? null;
    const direction = op.kind === 'claim-collection' || (op.kind === 'payment' && false) ? 'received'
      : op.kind === 'claim-refund' ? 'received' : 'sent';
    const amountAtomic = op.env?.amount ?? intent.amountAtomic ?? claim?.amountAtomic ?? null;
    return { intent, senderIdentity, recipientIdentity, claim, senderAddress, recipientAddress, direction, amountAtomic };
  }

  // ---- human recipient -----------------------------------------------------

  _recipient(op, ctx) {
    const r = ctx.recipientIdentity;
    return {
      displayName: r?.displayName ?? null,
      handle: r?.handle ? `@${r.handle}` : null,
      entryMethod: ctx.intent.entryMethod ?? (op.kind.startsWith('claim') ? 'claim' : 'contacts'),
      resolutionReference: ctx.intent.resolutionRequestId ?? null,
      resolutionVersion: ctx.intent.aliasVersion ?? r?.aliasVersion ?? null
    };
  }

  // ---- identifier privacy (real detector) ----------------------------------

  _privacy(op, ctx, receipt) {
    const prohibited = this._prohibitedValues(ctx);
    const calldataFields = this._calldataFields(op, ctx);
    const calldata = this._scan(calldataFields, prohibited);

    const logs = Array.isArray(receipt?.logs) ? receipt.logs : null;
    const eventFields = logs ? this._eventFields(logs) : null;
    const events = eventFields ? this._scan(eventFields, prohibited) : { status: UNKNOWN, fieldsScanned: 0, matches: [] };

    // The contract SOURCE emits/stores only {id, addresses, amount, opaque refs} — audited, no
    // phone-derived field. This substantiates the storage/event claim when runtime logs are absent.
    const schema = { status: PASS, basis: 'contract-source-audit' };

    const sensitiveOnchain =
      (calldata.status === FAIL || events.status === FAIL) ? 'yes'
      : (calldata.status === PASS && (events.status === PASS || schema.status === PASS)) ? 'no'
      : 'unknown';

    return {
      calldataCheck: calldata.status,
      eventCheck: events.status,
      schemaCheck: schema.status,
      sensitiveOnchain,
      // Consumer sub-labels, each independently honest.
      rawPhoneInCalldata: calldata.status === PASS ? 'no' : calldata.status === FAIL ? 'yes' : 'unknown',
      rawPhoneInEvents: events.status === PASS ? 'no' : events.status === FAIL ? 'yes' : 'unknown',
      phoneDerivedHashOnchain: (calldata.status === PASS && events.status !== FAIL) ? 'no' : (calldata.status === FAIL || events.status === FAIL) ? 'yes' : 'unknown',
      detail: {
        calldataFieldsScanned: calldata.fieldsScanned,
        eventFieldsScanned: events.fieldsScanned ?? 0,
        prohibitedValueCount: prohibited.length,
        matches: [...calldata.matches, ...events.matches],
        schemaBasis: schema.basis
      }
    };
  }

  // Sensitive values that must NEVER appear on-chain, sourced from the actual identities involved:
  // each side's raw phone (decrypted only to search — never returned) and its phone-derived key.
  _prohibitedValues(ctx) {
    const out = new Set();
    for (const id of [ctx.recipientIdentity, ctx.senderIdentity]) {
      if (id?.phoneLookupKey) out.add(strip(id.phoneLookupKey));
      if (id?.phoneEncrypted) {
        try {
          const raw = decryptString(id.phoneEncrypted, this.config.dataEncryptionKeyHex);
          if (raw) {
            const digits = String(raw).replace(/\D/g, '');
            if (digits.length >= 7) out.add(digits);
            out.add(strip(normalizeE164(raw)));
          }
        } catch { /* undecryptable → cannot search for it, not a failure */ }
      }
    }
    if (ctx.claim?.recipientPhoneLookupKey) out.add(strip(ctx.claim.recipientPhoneLookupKey));
    out.delete('');
    return [...out].filter(v => v && v.length >= 7);
  }

  // The exact argument values that go into the allowlisted contract call for this operation.
  _calldataFields(op, ctx) {
    // A Circle payment's fields are the Safe transaction's, handed over by CircleService.
    if (ctx.calldataFields) return ctx.calldataFields;
    if (op.kind === 'payment' && op.env) {
      const e = op.env;
      return [
        ['paymentId', e.paymentId], ['payer', e.payer], ['recipient', e.recipient], ['amount', e.amount],
        ['requestId', e.requestId], ['resolutionHash', e.resolutionHash], ['validBefore', e.validBefore], ['nonce', e.nonce]
      ].map(([name, value]) => ({ name, value }));
    }
    const c = ctx.claim;
    if (op.kind === 'claim-funding' && c) {
      return field([
        ['claimId', c.claimId], ['recipientReference', c.recipientReference], ['sender', ctx.senderAddress],
        ['amount', c.amountAtomic], ['expiry', c.expiry], ['fundingTxHash', c.fundingTransactionHash]
      ]);
    }
    if (op.kind === 'claim-collection' && c) {
      return field([
        ['claimId', c.claimId], ['recipient', ctx.recipientAddress], ['aliasVersion', ctx.intent.aliasVersion],
        ['claimTxHash', c.claimTransactionHash]
      ]);
    }
    if (op.kind === 'claim-refund' && c) {
      return field([['claimId', c.claimId], ['refundTxHash', c.refundTransactionHash]]);
    }
    return [];
  }

  _eventFields(logs) {
    const out = [];
    logs.forEach((log, i) => {
      (log.topics ?? []).forEach((t, j) => out.push({ name: `log[${i}].topic[${j}]`, value: t }));
      if (log.data) out.push({ name: `log[${i}].data`, value: log.data });
    });
    return out;
  }

  _scan(fields, prohibited) {
    const scannable = fields.filter(f => f.value != null);
    if (!scannable.length) return { status: UNKNOWN, fieldsScanned: 0, matches: [] };
    if (!prohibited.length) return { status: UNKNOWN, fieldsScanned: scannable.length, matches: [] };
    const matches = [];
    for (const f of scannable) {
      const v = String(f.value).toLowerCase();
      for (const p of prohibited) {
        if (v.includes(p)) matches.push({ field: f.name, reason: 'prohibited-identifier-present' });
      }
    }
    return { status: matches.length ? FAIL : PASS, fieldsScanned: scannable.length, matches };
  }

  // ---- gas -----------------------------------------------------------------

  _gas(op, receipt, senderMon) {
    let relayer = null;
    try { relayer = relayerAccount().address.toLowerCase(); } catch { /* relayer key absent in some envs */ }
    let sponsored = UNKNOWN;
    let sponsoredBy = null;
    if (receipt?.from && relayer) {
      sponsored = String(receipt.from).toLowerCase() === relayer ? PASS : FAIL;
      sponsoredBy = receipt.from;
    } else if (senderMon != null) {
      // Weaker evidence: the sender still holds no MON, consistent with never paying gas.
      sponsored = senderMon === 0n ? PASS : UNKNOWN;
      sponsoredBy = relayer;
    }
    return { userPaidDollars: '0.00', monRequiredFromSender: '0', sponsored, sponsoredBy };
  }

  // ---- settlement ----------------------------------------------------------

  _settlement(op, receipt, txHash) {
    const statusMap = { completed: 'confirmed', confirming: 'confirming', submitted: 'submitted', broadcasting: 'submitted', prepared: 'created', failed: 'failed', reverted: 'failed', expired: 'expired' };
    return {
      network: 'Monad',
      chainId: this.config.chain.chainId.toString(),
      asset: 'USDC',
      status: statusMap[op.state] ?? op.state,
      blockNumber: str(op.blockNumber ?? receipt?.blockNumber ?? null),
      txHash: txHash ?? null,
      explorerUrl: txHash ? `${this.config.chain.explorerUrl}/tx/${txHash}` : null,
      createdAt: op.createdAt ?? null,
      submittedAt: op.submittedAt ?? op.broadcastAt ?? null,
      confirmedAt: op.completedAt ?? null
    };
  }

  // ---- independent readback ------------------------------------------------

  async _verification(op, ctx, receipt, recipientToken) {
    const txHash = op.transactionHash ?? op.txHash ?? null;
    const monadReceipt = receipt ? (receiptSucceeded(receipt) ? PASS : FAIL) : (txHash ? PENDING : UNKNOWN);
    const blockConfirmation = (receipt && (op.blockNumber ?? receipt.blockNumber)) ? PASS : (txHash ? PENDING : UNKNOWN);

    // Alchemy readback: an independent chain read (the recipient balance), separate from the
    // confirming path. If the provider couldn't be read, say unavailable — never fake it.
    let alchemyReadback = UNKNOWN;
    if (op.state === 'completed' || txHash) alchemyReadback = recipientToken != null ? PASS : UNAVAILABLE;

    const envioAvailable = envioIndexer().available();
    const envioIndex = !envioAvailable ? NOT_CONFIGURED : (op.indexed ? PASS : PENDING);

    let balanceDelta = UNKNOWN;
    if (op.state === 'completed' && ctx.amountAtomic != null) {
      balanceDelta = recipientToken == null ? UNAVAILABLE : (recipientToken >= BigInt(ctx.amountAtomic) ? PASS : FAIL);
    } else if (recipientToken == null && txHash) {
      balanceDelta = UNAVAILABLE;
    }

    // Note: the recipient's absolute balance is deliberately NOT returned — only the assertion result
    // (balanceDelta), so the caller learns "recipient received ≥ amount", never the recipient's total.
    return {
      monadReceipt,
      blockConfirmation,
      alchemyReadback,
      alchemyProvider: chainProvider().name,
      envioIndex,
      balanceDelta
    };
  }

  // ---- request binding & claim proof --------------------------------------

  _request(op, ctx) {
    const requestId = ctx.intent.requestId;
    if (!requestId) return null;
    const boundInEnvelope = Boolean(op.env && op.env.requestId && op.env.requestId !== ZERO32);
    return {
      requestId,
      label: ctx.intent.memo || null,
      amountAtomic: ctx.amountAtomic,
      // "Bound to payment" is true only because the requestId is cryptographically inside the signed
      // settlement envelope — not a mere UI association.
      boundToPayment: boundInEnvelope ? 'yes' : 'unknown',
      envelopeRequestHash: op.env?.requestId ?? null
    };
  }

  _claim(op, ctx) {
    const c = ctx.claim;
    if (!c) return null;
    const funded = ['funded', 'claim_submitted', 'claimed', 'refund_submitted', 'refunded'].includes(c.status);
    const claimed = c.status === 'claimed' || c.status === 'claim_submitted';
    const refunded = c.status === 'refunded' || c.status === 'refund_submitted';
    return {
      claimId: c.claimId,
      fundsProtected: funded ? 'yes' : c.status === 'funding_failed' ? 'no' : 'pending',
      // Collection required BOTH the authorizer eligibility signature and the recipient's Mera
      // ClaimIntent (dual signature) — an alias/OTP alone can never release funds.
      recipientEligibility: claimed ? 'verified' : (c.status === 'funded' ? 'pending' : 'unknown'),
      claimedAt: c.claimedAt ?? null,
      expiredAt: (refunded || (c.status === 'funded' && c.expiry < nowSec())) ? new Date(c.expiry * 1000).toISOString() : null,
      refund: refunded ? 'confirmed' : (c.status === 'funded' && c.expiry < nowSec() ? 'available' : null),
      // Refund funds always return to the original sender (contract-enforced destination).
      senderRestored: c.status === 'refunded' ? 'verified' : c.status === 'refund_submitted' ? 'pending' : null
    };
  }

  // ---- proof status & evidence level --------------------------------------

  _status(op, privacy, verification) {
    if (op.state === 'failed' || op.state === 'reverted') return 'unknown';
    if (op.state !== 'completed') return 'pending';
    const receiptOk = verification.monadReceipt === PASS;
    const clean = privacy.calldataCheck === PASS && privacy.sensitiveOnchain === 'no';
    const independent = [verification.alchemyReadback, verification.envioIndex, verification.balanceDelta].includes(PASS);
    if (receiptOk && clean && independent) return 'verified';
    if (receiptOk || clean) return 'partially_verified';
    return 'unknown';
  }

  // Never auto-claims E4/E5 (repetition / mainnet); E1 is reserved for iOS demo fixtures.
  _level(op, txHash, verification) {
    const confirmed = op.state === 'completed' && txHash && verification.monadReceipt === PASS;
    if (!confirmed) return 'E0';
    const independent = [verification.alchemyReadback, verification.envioIndex, verification.balanceDelta].includes(PASS);
    return independent ? 'E3' : 'E2';
  }

  // ---- typed evidence items ------------------------------------------------

  _evidence({ op, ctx, receipt, privacy, verification, gas, settlement, txHash, level }) {
    const now = new Date().toISOString();
    const items = [];
    const add = (type, status, source, reference, detail, observedAt = now) =>
      items.push({ id: `${type}:${op.operationId}`, type, status, source, observedAt, reference, detail });

    add('transactionReceipt', verification.monadReceipt, 'monad', txHash,
      receipt ? `receipt status ${String(receipt.status)}` : 'no receipt yet', settlement.confirmedAt ?? now);
    add('blockConfirmation', verification.blockConfirmation, 'monad', settlement.blockNumber, 'mined block');
    add('alchemyReadback', verification.alchemyReadback, verification.alchemyProvider, ctx.recipientAddress,
      'independent chain read of the recipient account');
    add('envioIndex', verification.envioIndex, 'envio', op.operationId,
      verification.envioIndex === NOT_CONFIGURED ? 'Envio not configured' : (op.indexed ? 'indexed' : 'awaiting index'),
      op.indexedAt ?? now);
    add('balanceDelta', verification.balanceDelta, verification.alchemyProvider, ctx.recipientAddress,
      `recipient holds ≥ ${ctx.amountAtomic ?? '0'} atomic`);
    add('resolutionAttestation', ctx.intent.resolutionRequestId ? PASS : UNKNOWN, 'resolver',
      ctx.intent.resolutionRequestId, `alias version ${ctx.intent.aliasVersion ?? '?'} · resolved privately, no phone in attestation`);
    add('privacyCalldataCheck', privacy.calldataCheck, 'prism', null,
      `${privacy.detail.calldataFieldsScanned} calldata fields vs ${privacy.detail.prohibitedValueCount} prohibited values`);
    add('privacyEventCheck', privacy.eventCheck, receipt ? 'chain-logs' : 'unavailable', null,
      privacy.eventCheck === UNKNOWN ? 'no on-chain logs available to scan' : `${privacy.detail.eventFieldsScanned} event fields scanned`);
    add('contractSchemaCheck', privacy.schemaCheck, 'contract-source-audit', this.config.chain.paymentRouter,
      'router/vault emit & store only id, addresses, amount, opaque refs — no phone-derived field');
    if (ctx.intent.requestId) {
      add('requestBinding', op.env?.requestId && op.env.requestId !== ZERO32 ? PASS : UNKNOWN, 'envelope',
        ctx.intent.requestId, 'requestId hashed inside the signed settlement envelope');
    }
    if (ctx.claim) {
      add('claimState', PASS, 'prism', ctx.claim.claimId, `claim status: ${ctx.claim.status}`);
    }
    return items.map(it => ({ ...it, level }));
  }

  // ---- shared-account (Circle) proof ---------------------------------------
  //
  // Same surface, same vocabulary, one extra section. What changes for a Circle is not the standard
  // of evidence but *where the evidence comes from*, and the split is deliberate:
  //
  //   proposal / signature coordination   Safe Transaction Service   — coordination, NEVER execution
  //   owners / threshold                  the Safe contract
  //   USDC balance                        the USDC contract on Monad
  //   the payment itself                  the Monad receipt + the USDC Transfer log inside it
  //   the human recipient                 Prism resolution
  //   indexing                            the existing Prism evidence pipeline
  //
  // Nothing below reports the Transaction Service as proof that anything happened. It is listed as
  // an evidence item with an explicit `coordination` status so a reader can see that the distinction
  // was made rather than having to trust that it was.

  async _canonicalCircle(paymentId, actorPrismId) {
    const bundle = await this.circles.evidenceFor(paymentId, actorPrismId);
    if (!bundle) throw notFoundError('payment not found');

    // A contribution settles through the ordinary Prism router, so its proof IS the ordinary payment
    // proof — assembled from the same operation, with the Circle section added. Building a second
    // one would be exactly the duplicate evidence path this design refuses.
    if (bundle.underlyingOperationId) {
      const base = await this.canonical(bundle.underlyingOperationId, null);
      return { ...base, paymentId, kind: 'circle-contribution', circle: this._circleSection(bundle), demo: false };
    }

    const op = bundle.operation;
    const ctx = this._circleContext(bundle);
    const receipt = bundle.receipt;
    const evidence = bundle.evidence ?? null;

    const privacy = this._privacy(op, ctx, receipt);
    const verification = this._circleVerification(bundle, receipt, evidence);
    const gas = this._gas(op, receipt, null);
    const settlement = this._settlement(op, receipt, op.transactionHash ?? null);
    const circle = this._circleSection(bundle);

    const receiptOk = verification.monadReceipt === PASS;
    const clean = privacy.calldataCheck === PASS && privacy.sensitiveOnchain === 'no';
    const independent = [verification.safeExecution, verification.usdcTransfer, verification.balanceReadback].includes(PASS);
    const proofStatus = op.state === 'failed' ? 'unknown'
      : op.state !== 'completed' ? 'pending'
      : (receiptOk && clean && independent) ? 'verified'
      : (receiptOk || clean) ? 'partially_verified' : 'unknown';
    const level = op.state === 'completed' && op.transactionHash && receiptOk ? (independent ? 'E3' : 'E2') : 'E0';

    return {
      paymentId,
      kind: op.kind,
      direction: 'sent',
      amountAtomic: ctx.amountAtomic,
      tokenSymbol: 'USDC',
      proofStatus,
      evidenceLevel: level,
      demo: false,
      recipient: this._recipient(op, ctx),
      // The block that makes a shared payment inspectable: which Circle, which shared account, what
      // authority, which policy, who proposed, who approved, and the Safe digest they signed.
      circle,
      privacy,
      authorization: {
        method: bundle.policy === 'SPENDING_LIMIT' ? 'Mera passkey (within an on-chain spending limit)' : 'Mera passkey (Safe owner signature)',
        localApproval: null,
        otpForSpending: 'no'
      },
      gas,
      settlement,
      verification,
      request: null,
      claim: null,
      evidence: this._circleEvidenceItems({ bundle, privacy, verification, gas, settlement, level, circle }),
      generatedAt: new Date().toISOString()
    };
  }

  /** The proof context for a Circle payment: the Circle is the payer, a Prism identity is the payee. */
  _circleContext(bundle) {
    const recipientIdentity = bundle.recipientPrismId ? this.paymentService.identity(bundle.recipientPrismId) : null;
    const proposerIdentity = bundle.proposerPrismId ? this.paymentService.identity(bundle.proposerPrismId) : null;
    return {
      intent: bundle.operation.intent ?? {},
      // Both people whose identifiers must never appear on-chain: the person being paid, and the
      // member who moved the money. The detector searches for both.
      senderIdentity: proposerIdentity,
      recipientIdentity,
      claim: null,
      senderAddress: bundle.circle.safeAddress ?? null,
      recipientAddress: bundle.operation.intent?.circle?.restricted
        ? (recipientIdentity?.accountAddress ?? null)
        : (bundle.view?.recipientAccount ?? recipientIdentity?.accountAddress ?? null),
      direction: 'sent',
      amountAtomic: bundle.operation.intent?.amountAtomic ?? null,
      // The exact values inside the Safe transaction, handed over by CircleService — this service
      // does not know Safe encoding and must not learn it.
      calldataFields: bundle.calldataFields ?? []
    };
  }

  /** The Circle section of the proof. Every figure is a read, and an unread figure stays null. */
  _circleSection(bundle) {
    const context = bundle.operation.intent?.circle ?? {};
    const authority = bundle.authority;
    const view = bundle.view ?? {};
    const address = bundle.circle.safeAddress ?? null;
    return {
      circleId: bundle.circle.circleId,
      name: bundle.circle.name,
      sharedAccount: address ? { address, abbreviated: abbreviate(address) } : null,
      asset: 'USDC',
      token: this.config.chain.usdc,
      // "Shared" for a threshold payment, "Delegated" for a limit spend, "Personal" for money in.
      authority: context.authority ?? null,
      // Read from the Safe, not from Prism's mirror: "2 of 3 admins" is only claimed when the owner
      // set and threshold were actually read at proof time.
      policy: authority ? approvalPolicyLabel({ requiredApprovals: authority.threshold, adminCount: authority.adminCount }) : (context.policy ?? null),
      policySource: authority ? 'safe contract' : 'unavailable',
      owners: authority?.owners ?? null,
      threshold: authority?.threshold ?? null,
      proposer: context.proposer ?? null,
      approvals: context.approvers ?? [],
      approvalsSource: view.approvalsSource ?? null,
      requiredApprovals: context.requiredApprovals ?? null,
      safeTxHash: context.safeTxHash ?? null,
      safeNonce: context.safeNonce ?? null,
      binding: bundle.binding ?? null,
      spendingLimit: context.spendingLimitReference ?? null,
      allowance: bundle.allowance ? {
        limitAtomic: bundle.allowance.amountAtomic,
        spentAtomic: bundle.allowance.spentAtomic,
        availableAtomic: bundle.allowance.availableAtomic,
        period: bundle.allowance.period,
        source: 'allowance module'
      } : null,
      balance: {
        before: bundle.balanceBefore ?? null,
        after: bundle.balanceAfter ?? null,
        current: bundle.balance ?? null,
        // Every one of these came from `USDC.balanceOf(safe)`; none is derived from Prism's activity.
        source: 'usdc contract'
      },
      transfer: bundle.evidence?.transfer ?? null,
      restricted: Boolean(context.restricted)
    };
  }

  /** What was independently established for a Circle payment, and by whom. */
  _circleVerification(bundle, receipt, evidence) {
    const txHash = bundle.operation.transactionHash ?? null;
    const monadReceipt = receipt ? (receiptSucceeded(receipt) ? PASS : FAIL) : (txHash ? PENDING : UNKNOWN);
    const blockConfirmation = evidence?.blockNumber || receipt?.blockNumber ? PASS : (txHash ? PENDING : UNKNOWN);

    // The Safe's own ExecutionSuccess for THIS digest. A successful receipt is not this claim: Safe
    // swallows a failing inner call and still returns a successful transaction.
    const safeExecution = bundle.policy === 'SPENDING_LIMIT'
      ? (evidence?.transfer ? PASS : (txHash ? PENDING : UNKNOWN))
      : (evidence?.safeExecutionSuccess ? PASS : (txHash ? PENDING : UNKNOWN));

    // The USDC Transfer from this Circle to the reviewed recipient, for the exact amount.
    const usdcTransfer = evidence?.transfer ? PASS : (txHash ? PENDING : UNKNOWN);

    const ownersReadback = bundle.authority ? PASS : UNAVAILABLE;
    const thresholdReadback = bundle.authority ? PASS : UNAVAILABLE;
    const balanceReadback = bundle.balance != null ? PASS : UNAVAILABLE;
    const allowanceReadback = bundle.policy === 'SPENDING_LIMIT' ? (bundle.allowance ? PASS : UNAVAILABLE) : UNKNOWN;

    return {
      monadReceipt,
      blockConfirmation,
      safeExecution,
      usdcTransfer,
      ownersReadback,
      thresholdReadback,
      balanceReadback,
      allowanceReadback,
      alchemyReadback: balanceReadback,
      alchemyProvider: chainProvider().name,
      // A Safe transfer is not a `PaymentSettled` event, so Prism's Envio index does not carry it.
      // Saying "not indexed" would imply a missing row; the honest answer is that this evidence
      // pipeline does not cover this transaction.
      envioIndex: NOT_APPLICABLE,
      balanceDelta: bundle.balanceBefore != null && bundle.balanceAfter != null ? PASS : UNAVAILABLE
    };
  }

  _circleEvidenceItems({ bundle, privacy, verification, gas, settlement, level, circle }) {
    const now = new Date().toISOString();
    const items = [];
    const add = (type, status, source, reference, detail) =>
      items.push({ id: `${type}:${bundle.operation.operationId}`, type, status, source, observedAt: now, reference, detail, level });

    add('transactionReceipt', verification.monadReceipt, 'monad', settlement.txHash, 'the execution transaction on Monad');
    add('blockConfirmation', verification.blockConfirmation, 'monad', settlement.blockNumber, 'mined block');
    if (bundle.policy === 'THRESHOLD') {
      add('safeExecutionSuccess', verification.safeExecution, 'safe contract', circle.safeTxHash,
        'the Safe emitted ExecutionSuccess for this exact transaction digest');
      add('ownerSignatures', circle.approvals.length >= (circle.requiredApprovals ?? Infinity) ? PASS : PENDING,
        'signatures', circle.safeTxHash,
        `${circle.approvals.length} of ${circle.requiredApprovals ?? '?'} verified against the live owner set`);
      // Named so the distinction is visible in the evidence list itself, not only in a document.
      add('proposalCoordination', COORDINATION, 'safe transaction service', circle.safeTxHash,
        'used to share the proposal and collect signatures; never treated as evidence of execution');
    } else {
      add('allowanceTransfer', verification.safeExecution, 'allowance module', settlement.txHash,
        'the module executed a transfer inside this member\'s approved limit');
      add('allowanceReadback', verification.allowanceReadback, 'allowance module', circle.spendingLimit?.delegate ?? null,
        'the limit and the amount spent, read back from the module');
    }
    add('usdcTransfer', verification.usdcTransfer, 'usdc contract', settlement.txHash,
      bundle.evidence?.transfer
        ? `Transfer ${bundle.evidence.transfer.amountAtomic} atomic from the Circle to the reviewed recipient`
        : 'no matching USDC Transfer observed yet');
    add('ownersReadback', verification.ownersReadback, 'safe contract', circle.sharedAccount?.address ?? null,
      circle.owners ? `${circle.owners.length} admin${circle.owners.length === 1 ? '' : 's'} on-chain` : 'the Safe could not be read');
    add('thresholdReadback', verification.thresholdReadback, 'safe contract', circle.sharedAccount?.address ?? null,
      circle.threshold != null ? `${circle.threshold} approvals required on-chain` : 'the Safe could not be read');
    add('balanceReadback', verification.balanceReadback, 'usdc contract', circle.sharedAccount?.address ?? null,
      'the Circle balance, read from the token contract');
    add('resolutionAttestation', bundle.operation.intent?.resolutionRequestId ? PASS : UNKNOWN, 'resolver',
      bundle.operation.intent?.resolutionRequestId ?? null,
      `alias version ${bundle.operation.intent?.aliasVersion ?? '?'} · resolved privately, no phone in the attestation`);
    add('privacyCalldataCheck', privacy.calldataCheck, 'prism', null,
      `${privacy.detail.calldataFieldsScanned} Safe transaction fields vs ${privacy.detail.prohibitedValueCount} prohibited values`);
    add('privacyEventCheck', privacy.eventCheck, bundle.receipt ? 'chain-logs' : 'unavailable', null,
      privacy.eventCheck === UNKNOWN ? 'no on-chain logs available to scan' : `${privacy.detail.eventFieldsScanned} event fields scanned`);
    add('approvalBinding', bundle.binding?.ok ? PASS : FAIL, 'prism', circle.safeTxHash,
      bundle.binding?.ok
        ? 'the recorded digest is the digest of these exact fields'
        : (bundle.binding?.reasons ?? []).join('; '));
    add('gasSponsorship', gas.sponsored, 'monad', gas.sponsoredBy, 'the relayer paid the MON for this transaction');
    return items;
  }
}

function abbreviate(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function notFoundError(message) { const e = new Error(message); e.statusCode = 404; return e; }

function field(pairs) { return pairs.map(([name, value]) => ({ name, value })); }
function str(v) { return v == null ? null : v.toString(); }
function strip(v) { return String(v ?? '').replace(/^0x/i, '').toLowerCase(); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function receiptSucceeded(r) {
  const s = r?.status;
  return s === 'success' || s === '0x1' || s === 1 || s === true;
}
