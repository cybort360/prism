/**
 * Circle templates are UX defaults and nothing more.
 *
 * A template never selects a person, never invents an admin address, and never overrides what the
 * creator chose. It answers one question — "given that N admins have already been selected, what
 * threshold should the sheet land on?" — and it always yields a threshold that is valid for that N.
 *
 * The recommendations encode a preference for a spare approval (see `spareApprovals`): 2-of-3 can
 * survive one lost phone, 2-of-2 cannot. Where the selected admins cannot support the recommended
 * shape, the recommendation degrades to the best valid threshold rather than demanding more people.
 */
import { assertThresholdWithinOwners, thresholdWarnings, badRequest } from './model.js';

export const CircleTemplate = Object.freeze({
  FAMILY: 'FAMILY',
  TRIP: 'TRIP',
  COMMUNITY: 'COMMUNITY',
  CUSTOM: 'CUSTOM'
});

const DEFINITIONS = Object.freeze({
  FAMILY: {
    label: 'Family',
    blurb: 'A household account two people keep an eye on.',
    // 2-of-3 *when three admins exist* — not a demand for three admins.
    preferred: { threshold: 2, admins: 3 }
  },
  TRIP: {
    label: 'Trip',
    blurb: 'A shared pot for a trip, closed when everyone gets home.',
    preferred: { threshold: 2, admins: 3 }
  },
  COMMUNITY: {
    label: 'Community',
    blurb: 'A group fund where no single person should move money alone.',
    // 3-of-5 *where sufficient admins exist*.
    preferred: { threshold: 3, admins: 5 }
  },
  CUSTOM: {
    label: 'Custom',
    blurb: 'You choose how many approvals a payment needs.',
    preferred: null                       // CUSTOM defers entirely to the creator
  }
});

export function templateDefinition(template) {
  const def = DEFINITIONS[template];
  if (!def) throw badRequest(`unknown circle template: ${template}`);
  return def;
}

/**
 * The threshold a template suggests for the admins that were actually selected.
 *
 * Degradation rule: a template's preferred threshold applies only when there are at least as many
 * admins as it was designed for. With fewer, we fall back to "a majority, but never more than the
 * admins present", so a COMMUNITY Circle with 3 selected admins recommends 2 rather than an
 * impossible 3-of-3-by-accident or an unreachable 3-of-5.
 *
 * Returns null for CUSTOM: there is no recommendation to make, and pretending otherwise would put
 * Prism's thumb on a scale the creator was told they control.
 */
export function recommendThreshold(template, adminCount) {
  const def = templateDefinition(template);
  if (!Number.isInteger(adminCount) || adminCount < 1) throw badRequest('a Circle needs at least one admin');
  if (!def.preferred) return null;

  const { threshold, admins } = def.preferred;
  const recommended = adminCount >= admins
    ? threshold
    : Math.max(1, Math.min(adminCount, Math.ceil(adminCount / 2)));

  // Never recommend more approvals than there are admins to give them.
  return Math.min(recommended, adminCount);
}

/**
 * Everything the creation sheet needs to render one template honestly: the suggested threshold for
 * the admins chosen so far, every threshold that is actually valid, and the plain-language
 * consequence of each. The warnings are the point — a 2-person Circle has no safe default, so the
 * UI is given the text for both choices rather than a recommendation dressed up as a safe one.
 */
export function templateOptions(template, adminCount) {
  const def = templateDefinition(template);
  const recommended = recommendThreshold(template, adminCount);
  const choices = [];
  for (let t = 1; t <= adminCount; t++) {
    choices.push({
      threshold: t,
      label: `${t} of ${adminCount}`,
      recommended: t === recommended,
      warnings: thresholdWarnings({ threshold: t, ownerCount: adminCount })
    });
  }
  return {
    template,
    label: def.label,
    blurb: def.blurb,
    adminCount,
    recommendedThreshold: recommended,
    // A 2-person Circle is called out explicitly: neither 1-of-2 nor 2-of-2 is universally safe, and
    // the creator has to see both consequences before authorizing.
    twoPersonTradeoff: adminCount === 2 ? {
      oneOfTwo: thresholdWarnings({ threshold: 1, ownerCount: 2 }),
      twoOfTwo: thresholdWarnings({ threshold: 2, ownerCount: 2 })
    } : null,
    choices
  };
}

/** Validate a creator's explicit choice against the admins they actually selected. */
export function assertTemplateChoice({ template, threshold, adminCount }) {
  templateDefinition(template);
  assertThresholdWithinOwners({ threshold, ownerCount: adminCount, context: 'approvals required' });
  return true;
}
