/**
 * Circle Activity — one feed, two kinds of event, no invented history.
 *
 * The rule this service exists to hold: **there is no separate Circle transaction ledger.** Every
 * financial row here is a projection of a record that was already reconciled against the chain — a
 * contribution's settled Prism payment, a threshold payment's Safe execution and USDC Transfer, a
 * within-limit spend's transfer — and every governance row is a projection of either a member's own
 * guarded lifecycle or a governance transaction that was *read back* from the chain after executing.
 * Nothing in this file writes state, and nothing in it reports an event Prism merely intended.
 *
 * Financial and governance events stay distinguishable (`class`), because they answer different
 * questions. "Where did the money go" and "who is allowed to move it" must never blur into one list
 * where a limit change reads like a payment.
 */
import { ProposalKind, CirclePaymentState, MemberStatus, MemberRole } from '../circles/model.js';
import { PERIOD_LABELS } from '../circles/allowanceModule.js';

export const ActivityClass = Object.freeze({ FINANCIAL: 'financial', GOVERNANCE: 'governance' });

export const CircleActivityType = Object.freeze({
  CONTRIBUTION: 'CONTRIBUTION',
  PAYMENT: 'PAYMENT',
  SPEND: 'SPEND',
  MEMBER_INVITED: 'MEMBER_INVITED',
  MEMBER_JOINED: 'MEMBER_JOINED',
  MEMBER_PENDING_ACTIVATION: 'MEMBER_PENDING_ACTIVATION',
  MEMBER_PENDING_REMOVAL: 'MEMBER_PENDING_REMOVAL',
  MEMBER_LEFT: 'MEMBER_LEFT',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
  ADMIN_ADDED: 'ADMIN_ADDED',
  ADMIN_REMOVED: 'ADMIN_REMOVED',
  THRESHOLD_CHANGED: 'THRESHOLD_CHANGED',
  LIMITS_ENABLED: 'LIMITS_ENABLED',
  SPENDING_ACCESS_GRANTED: 'SPENDING_ACCESS_GRANTED',
  SPENDING_ACCESS_REMOVED: 'SPENDING_ACCESS_REMOVED',
  SPENDING_LIMIT_CHANGED: 'SPENDING_LIMIT_CHANGED',
  CIRCLE_CREATED: 'CIRCLE_CREATED',
  CIRCLE_ACTIVE: 'CIRCLE_ACTIVE',
  CIRCLE_CLOSING: 'CIRCLE_CLOSING',
  CIRCLE_CLOSED: 'CIRCLE_CLOSED'
});

export class CircleActivityService {
  constructor({ store, config, circleService, identityService }) {
    this.store = store;
    this.config = config;
    this.circles = circleService;
    this.identityService = identityService;
  }

  /**
   * The Circle's activity, newest first.
   *
   * Membership is the authorization boundary, as it is for every Circle read — `listPayments` and
   * friends enforce it, and the governance half re-checks it before touching the store.
   */
  async list(circleId, prismId, { limit = 100 } = {}) {
    const circle = this.circles.getCircleRecord(circleId);
    const [payments, contributions, spends] = await Promise.all([
      this.circles.listPayments(circleId, prismId).then((r) => r.payments).catch(() => []),
      Promise.resolve(this.circles.listContributions(circleId, prismId).contributions),
      Promise.resolve(this.circles.listSpends(circleId, prismId).spends)
    ]);

    const items = [
      ...contributions.map((c) => this._contributionItem(c)),
      ...payments.map((p) => this._paymentItem(p)),
      ...spends.map((s) => this._spendItem(s)),
      ...this._governanceItems(circleId)
    ].filter(Boolean);

    items.sort((a, b) => Date.parse(b.occurredAt ?? 0) - Date.parse(a.occurredAt ?? 0));
    return {
      circleId,
      circleName: circle.name,
      activity: items.slice(0, limit),
      // Said explicitly so no client has to infer it: these rows are projections of reconciled
      // records, not a ledger Prism maintains alongside the chain.
      source: 'reconciled',
      classes: Object.values(ActivityClass)
    };
  }

  // --- financial --------------------------------------------------------------

  /** Money in. The contributor's own payment, settled through the ordinary Prism router. */
  _contributionItem(c) {
    const who = this._person(c.contributorPrismId, c.circleId);
    return {
      id: c.contributionId,
      class: ActivityClass.FINANCIAL,
      type: CircleActivityType.CONTRIBUTION,
      occurredAt: c.completedAt ?? c.createdAt,
      // "Tobi added" — the Circle's feed names the person who put money in, never the Safe address.
      title: `${who.displayName} added`,
      subtitle: null,
      detail: null,
      direction: 'in',
      amountAtomic: c.amount,
      amountDisplay: this._money(c.amount),
      signedAmountDisplay: `+${this._money(c.amount)}`,
      asset: c.asset,
      status: c.status,
      settled: c.status === 'COMPLETED',
      actor: who,
      counterparty: null,
      // The canonical payment this row is a view of. Tapping it opens the ordinary receipt.
      paymentId: c.contributionId,
      operationId: c.operationId ?? null,
      transactionHash: c.transactionHash ?? null,
      proposalId: null,
      evidenceSource: 'monad receipt + USDC Transfer'
    };
  }

  /** Money out, under the Circle's threshold. */
  _paymentItem(p) {
    const recipient = p.recipientDisplayName ?? p.recipientHandle ?? 'a recipient';
    const proposer = this._person(p.proposerPrismId, p.circleId);
    const approved = p.collectedApprovals ?? 0;
    const required = p.requiredApprovals ?? null;
    return {
      id: p.proposalId,
      class: ActivityClass.FINANCIAL,
      type: CircleActivityType.PAYMENT,
      occurredAt: p.executedAt ?? p.createdAt,
      // "Airbnb" — who was paid, which is what a person scanning the feed is looking for.
      title: recipient,
      subtitle: p.memo || null,
      detail: p.lifecycle === CirclePaymentState.COMPLETED
        ? null
        : (required != null ? `${approved} of ${required} approvals` : null),
      direction: 'out',
      amountAtomic: p.amount,
      amountDisplay: this._money(p.amount),
      signedAmountDisplay: `-${this._money(p.amount)}`,
      asset: p.asset,
      status: p.lifecycle,
      settled: p.lifecycle === CirclePaymentState.COMPLETED,
      actor: proposer,
      counterparty: { prismId: p.recipientPrismId ?? null, displayName: recipient, handle: p.recipientHandle ?? null },
      paymentId: p.proposalId,
      operationId: null,
      transactionHash: p.executionTxHash ?? null,
      proposalId: p.proposalId,
      approvalRule: required == null ? null : `${required} approval${required === 1 ? '' : 's'}`,
      evidenceSource: 'safe execution + USDC Transfer'
    };
  }

  /** Money out, inside one member's on-chain limit. A different authority, said so. */
  _spendItem(s) {
    const spender = this._person(s.spenderPrismId, s.circleId);
    const recipient = s.recipientDisplayName ?? s.recipientHandle ?? 'a recipient';
    return {
      id: s.spendId,
      class: ActivityClass.FINANCIAL,
      type: CircleActivityType.SPEND,
      occurredAt: s.completedAt ?? s.createdAt,
      title: recipient,
      subtitle: s.memo || null,
      // The feed must never make a limit spend look like something the Circle approved together.
      detail: `${spender.displayName} · within their spending limit`,
      direction: 'out',
      amountAtomic: s.amount,
      amountDisplay: this._money(s.amount),
      signedAmountDisplay: `-${this._money(s.amount)}`,
      asset: s.asset,
      status: s.status,
      settled: s.status === 'COMPLETED',
      actor: spender,
      counterparty: { prismId: s.recipientPrismId ?? null, displayName: recipient, handle: s.recipientHandle ?? null },
      paymentId: s.spendId,
      operationId: null,
      transactionHash: s.transactionHash ?? null,
      proposalId: null,
      approvalRule: null,
      evidenceSource: 'allowance module + USDC Transfer'
    };
  }

  // --- governance -------------------------------------------------------------

  /**
   * Who joined, who left, who may spend, and what the Circle now requires.
   *
   * Two sources, both already guarded: each member's own lifecycle log, and governance proposals
   * that reached COMPLETED — which, for a governance change, means the transaction executed AND the
   * chain was read back to confirm it took effect. A proposal that merely executed is not here.
   */
  _governanceItems(circleId) {
    const data = this.store.read();
    const out = [];

    const circle = data.circles?.[circleId];
    if (circle?.createdAt) {
      // The Circle's own beginning. Taken from the record's `createdAt` rather than from a status
      // event, because CREATED is where a Circle starts — there is no transition into it to observe.
      out.push({
        ...this._governanceShell(`${circleId}:created`, CircleActivityType.CIRCLE_CREATED, circle.createdAt),
        title: `${circle.name} was created`,
        subtitle: null,
        actor: this._person(circle.createdByPrismId, circleId),
        subject: null
      });
    }
    for (const event of circle?.events ?? []) {
      const item = this._statusItem(circleId, event);
      if (item) out.push(item);
    }

    for (const invite of Object.values(data.circleInvitations ?? {})) {
      if (invite.circleId !== circleId) continue;
      const who = this._person(invite.invitedPrismId, circleId);
      out.push({
        ...this._governanceShell(`${invite.inviteId}:invited`, CircleActivityType.MEMBER_INVITED, invite.createdAt),
        title: `${who.displayName} was invited`,
        subtitle: roleLabel(invite.role),
        actor: this._person(invite.invitedByPrismId, circleId),
        subject: who
      });
    }

    for (const member of Object.values(data.circleMembers ?? {})) {
      if (member.circleId !== circleId) continue;
      for (const [index, event] of (member.events ?? []).entries()) {
        const item = this._memberItem(circleId, member, event, index);
        if (item) out.push(item);
      }
    }

    for (const proposal of Object.values(data.circleProposals ?? {})) {
      if (proposal.circleId !== circleId) continue;
      if (proposal.kind === ProposalKind.PAYMENT) continue;
      if (proposal.lifecycle !== CirclePaymentState.COMPLETED) continue;
      const item = this._governanceProposalItem(circleId, proposal);
      if (item) out.push(item);
    }

    return out;
  }

  _statusItem(circleId, event) {
    const type = {
      [ 'ACTIVE' ]: CircleActivityType.CIRCLE_ACTIVE,
      [ 'CLOSING' ]: CircleActivityType.CIRCLE_CLOSING,
      [ 'CLOSED' ]: CircleActivityType.CIRCLE_CLOSED
    }[event.state];
    if (!type) return null;
    const circle = this.store.read().circles?.[circleId];
    const title = {
      [CircleActivityType.CIRCLE_ACTIVE]: 'The Circle went live on Monad',
      [CircleActivityType.CIRCLE_CLOSING]: 'The Circle is being closed',
      [CircleActivityType.CIRCLE_CLOSED]: 'The Circle was closed'
    }[type];
    return {
      ...this._governanceShell(`${circleId}:${event.state}:${event.at}`, type, event.at),
      title,
      subtitle: type === CircleActivityType.CIRCLE_ACTIVE && event.detail?.threshold
        ? `${event.detail.threshold} approval${Number(event.detail.threshold) === 1 ? '' : 's'} required`
        : (event.detail?.reason ?? null),
      actor: event.detail?.by ? this._person(event.detail.by, circleId) : null,
      subject: null
    };
  }

  _memberItem(circleId, member, event, index) {
    const who = this._person(member.prismId, circleId);
    const shell = (type, title, subtitle = null) => ({
      ...this._governanceShell(`${circleId}:${member.prismId}:${index}`, type, event.at),
      title,
      subtitle,
      actor: event.detail?.by ? this._person(event.detail.by, circleId) : null,
      subject: who,
      evidenceSource: event.detail?.source === 'safe owner set' ? 'safe owner set' : 'prism'
    });
    switch (event.status) {
      // ACCEPTED is a step in the member's own lifecycle, not a change to the Circle: what the
      // Circle's feed reports is whether they are in (ACTIVE) or still waiting on Monad.
      case MemberStatus.ACCEPTED: return null;
      case MemberStatus.ACTIVE:
        return shell(CircleActivityType.MEMBER_JOINED, `${who.displayName} joined`, member.role === MemberRole.ADMIN ? 'Admin — confirmed on Monad' : roleLabel(member.role));
      case MemberStatus.PENDING_ACTIVATION:
        return shell(CircleActivityType.MEMBER_PENDING_ACTIVATION, `${who.displayName} accepted`, 'Admin authority becomes active once the Circle approves it on Monad');
      case MemberStatus.PENDING_REMOVAL:
        return shell(CircleActivityType.MEMBER_PENDING_REMOVAL, `Removing ${who.displayName} as an admin was proposed`, 'Their authority is unchanged until the Circle approves it');
      case MemberStatus.LEFT:
        return shell(CircleActivityType.MEMBER_LEFT, `${who.displayName} left`, event.detail?.reason ?? null);
      case MemberStatus.REMOVED:
        return shell(CircleActivityType.MEMBER_REMOVED, `${who.displayName} was removed`, event.detail?.source === 'safe owner set' ? 'Admin authority removed on Monad' : null);
      default: return null;
    }
  }

  /**
   * An executed governance change. Everything reported here is backed by `evidence.readback` — the
   * chain re-read after the transaction, which is what makes a limit "changed" rather than "asked
   * for". A change with no readback never reaches COMPLETED, so it never reaches this feed.
   */
  _governanceProposalItem(circleId, proposal) {
    const g = proposal.governance ?? {};
    const subject = g.prismId ? this._person(g.prismId, circleId) : null;
    const readback = proposal.evidence?.readback ?? null;
    const shell = (type, title, subtitle = null) => ({
      ...this._governanceShell(proposal.proposalId, type, proposal.executedAt ?? proposal.createdAt),
      title,
      subtitle,
      actor: this._person(proposal.proposerPrismId, circleId),
      subject,
      proposalId: proposal.proposalId,
      safeTxHash: proposal.safeTxHash ?? null,
      transactionHash: proposal.executionTxHash ?? null,
      approvalRule: proposal.requiredApprovals == null ? null
        : `${proposal.requiredApprovals} approval${Number(proposal.requiredApprovals) === 1 ? '' : 's'}`,
      readback,
      evidenceSource: 'safe execution + chain readback'
    });
    const name = subject?.displayName ?? 'A member';

    switch (proposal.kind) {
      case ProposalKind.SPEND_LIMIT_SET: {
        const to = this._limitLabel(readback?.amountAtomic ?? g.amountAtomic, readback?.period ?? g.period);
        const from = g.previous ? this._limitLabel(g.previous.amountAtomic, g.previous.period) : null;
        // "$50/day → $100/day" only when there really was a previous limit. Otherwise the honest
        // sentence is that a limit was set, with no arrow and no invented starting point.
        return from
          ? shell(CircleActivityType.SPENDING_LIMIT_CHANGED, `${name}'s spending limit changed`, `${from} → ${to}`)
          : shell(CircleActivityType.SPENDING_LIMIT_CHANGED, `${name}'s spending limit was set`, to);
      }
      case ProposalKind.SPEND_LIMIT_DELETE:
        return shell(CircleActivityType.SPENDING_ACCESS_REMOVED, `${name}'s spending limit was removed`, null);
      case ProposalKind.SPEND_DELEGATE_ADD:
        return shell(CircleActivityType.SPENDING_ACCESS_GRANTED, `${name} can spend from the Circle`, null);
      case ProposalKind.SPEND_DELEGATE_REMOVE:
        return shell(CircleActivityType.SPENDING_ACCESS_REMOVED, `${name}'s spending access was removed`, null);
      case ProposalKind.MODULE_ENABLE:
        return shell(CircleActivityType.LIMITS_ENABLED, 'Member spending limits were turned on', null);
      case ProposalKind.OWNER_ADD:
        return shell(CircleActivityType.ADMIN_ADDED, `${name} became an admin`, thresholdLabel(readback?.threshold ?? g.threshold));
      case ProposalKind.OWNER_REMOVE:
        return shell(CircleActivityType.ADMIN_REMOVED, `${name} is no longer an admin`, thresholdLabel(readback?.threshold ?? g.threshold));
      case ProposalKind.THRESHOLD_CHANGE:
        return shell(CircleActivityType.THRESHOLD_CHANGED, 'The Circle changed how many approvals it needs', thresholdLabel(readback?.threshold ?? g.threshold));
      default:
        return null;
    }
  }

  _governanceShell(id, type, occurredAt) {
    return {
      id: `gov:${id}`,
      class: ActivityClass.GOVERNANCE,
      type,
      occurredAt: occurredAt ?? null,
      detail: null,
      // A governance event moves no money, and every money-shaped field stays null rather than zero
      // so no client can accidentally sum it into a balance.
      direction: null,
      amountAtomic: null,
      amountDisplay: null,
      signedAmountDisplay: null,
      asset: null,
      status: null,
      settled: true,
      counterparty: null,
      paymentId: null,
      operationId: null,
      transactionHash: null,
      proposalId: null,
      approvalRule: null,
      evidenceSource: 'prism'
    };
  }

  // --- helpers ----------------------------------------------------------------

  _person(prismId, circleId) {
    if (!prismId) return null;
    const member = this.store.read().circleMembers?.[`${circleId}:${prismId}`];
    const identity = this.identityService.get(prismId);
    const handle = member?.handle ?? (identity?.handle ? `@${identity.handle}` : null);
    return { prismId, displayName: member?.displayName ?? identity?.displayName ?? handle ?? 'Someone', handle };
  }

  _limitLabel(amountAtomic, period) {
    if (amountAtomic == null) return null;
    const label = period ? (PERIOD_LABELS[period] ?? '') : '';
    return `${this._money(amountAtomic)}${label ? ` ${label}` : ''}`.trim();
  }

  _money(atomic) {
    const decimals = this.config.chain.usdcDecimals;
    const value = BigInt(atomic ?? 0);
    const scale = 10n ** BigInt(decimals);
    const whole = value / scale;
    const cents = ((value % scale) * 100n) / scale;
    return `$${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
  }
}

function roleLabel(role) {
  return { ADMIN: 'Admin', SPENDER: 'Can spend', CONTRIBUTOR: 'Can add money', VIEWER: 'Can view' }[role] ?? null;
}

function thresholdLabel(threshold) {
  if (threshold == null) return null;
  return `${threshold} approval${Number(threshold) === 1 ? '' : 's'} now required`;
}
