/**
 * Circle proposal message threads — human context, never authority (INV-A1).
 *
 * An overflow spend or threshold payment can carry an explanation ("Hotel deposit for the
 * retreat" + invoice reference) so approvers know what they are being asked to sign. That is
 * ALL a message is: this service writes display text under a proposal id. It never touches
 * proposals, approvals, thresholds, digests, nonces, or execution — those live exclusively in
 * CircleService + the Safe, and message rows are structurally incapable of reaching them (the
 * service holds no reference to any approval or execution path).
 *
 * Boundaries:
 *   - Membership: only ACTIVE members of the Circle may read or post (else 403). Existence
 *     of the proposal itself is confirmed through CircleService (404 when unknown).
 *   - Privacy (INV-P1): E.164-looking values in text or metadata are rejected with 400.
 */
import crypto from 'node:crypto';
import { badRequest, forbidden, notFound } from '../circles/model.js';
import { MemberStatus } from '../circles/model.js';

export const MAX_THREAD_MESSAGE_CHARS = 1000;
const ATTACHMENT_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const E164_PATTERNS = [/tel:/i, /\+\d{7,15}/, /\b\d{3}[-.\s()]*\d{3}[-.\s()]*\d{4}\b/];

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function assertNoE164(value, field) {
  for (const s of collectStrings(value, [])) {
    for (const re of E164_PATTERNS) {
      if (re.test(s)) throw badRequest(`${field} must not contain a phone number (INV-P1)`);
    }
  }
}

export class CircleMessageService {
  constructor({ store, config, circleService, identityService }) {
    if (!store) throw new Error('store is required');
    if (!circleService) throw new Error('circleService is required');
    if (!identityService) throw new Error('identityService is required');
    this.store = store;
    this.config = config;
    this.circles = circleService;
    this.identityService = identityService;
  }

  _threadKey(circleId, proposalId) {
    return `${circleId}:${proposalId}`;
  }

  /** ACTIVE membership is the read/write boundary. Anything else is 403, explicitly. */
  _activeMember(circleId, prismId) {
    const member = this.store.read().circleMembers?.[`${circleId}:${prismId}`];
    if (!member || member.status !== MemberStatus.ACTIVE) {
      throw forbidden('only active members of this Circle can access proposal messages');
    }
    return member;
  }

  /** Proposal must exist and be a payment proposal; membership already established above. */
  async _paymentProposal(circleId, proposalId, prismId) {
    const view = await this.circles.getPayment({ circleId, proposalId, prismId });
    if (!view) throw notFound('proposal not found');
    return view;
  }

  async postProposalMessage({ circleId, proposalId, authorPrismId, text, attachmentHash = null }) {
    if (!circleId) throw badRequest('circleId is required');
    if (!proposalId) throw badRequest('proposalId is required');
    if (!authorPrismId) throw badRequest('authorPrismId is required');
    this._activeMember(circleId, authorPrismId);
    await this._paymentProposal(circleId, proposalId, authorPrismId);

    const body = String(text ?? '').trim();
    if (body.length < 1) throw badRequest('message text must not be empty');
    if (body.length > MAX_THREAD_MESSAGE_CHARS) {
      throw badRequest(`message text must be at most ${MAX_THREAD_MESSAGE_CHARS} characters`);
    }
    assertNoE164(body, 'message text');
    let attachment = null;
    if (attachmentHash !== null && attachmentHash !== undefined) {
      attachment = String(attachmentHash).trim();
      if (!ATTACHMENT_HASH_RE.test(attachment)) throw badRequest('attachmentHash must be a 0x-prefixed 32-byte hash');
      assertNoE164(attachment, 'attachmentHash');
    }

    const identity = this.identityService.get(authorPrismId);
    const message = {
      messageId: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      proposalId,
      circleId,
      authorPrismId,
      authorAccount: identity?.accountAddress ?? null,
      text: body,
      attachmentHash: attachment,
      createdAt: new Date().toISOString()
    };
    const key = this._threadKey(circleId, proposalId);
    this.store.mutate((d) => {
      d.circleProposalMessages ??= {};
      d.circleProposalMessages[key] ??= [];
      d.circleProposalMessages[key].push(message);
    });
    return message;
  }

  async getProposalMessages({ circleId, proposalId, requesterPrismId }) {
    if (!circleId) throw badRequest('circleId is required');
    if (!proposalId) throw badRequest('proposalId is required');
    if (!requesterPrismId) throw badRequest('requesterPrismId is required');
    this._activeMember(circleId, requesterPrismId);
    await this._paymentProposal(circleId, proposalId, requesterPrismId);
    const messages = [...(this.store.read().circleProposalMessages?.[this._threadKey(circleId, proposalId)] ?? [])]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { circleId, proposalId, messages };
  }
}
