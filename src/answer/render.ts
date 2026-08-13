/**
 * THE ONLY MODULE IN THIS CODEBASE THAT PRODUCES CUSTOMER-FACING TEXT.
 *
 * Everything here is assembled from two places and nowhere else:
 *   - `store()`    the business facts, printed byte-for-byte
 *   - `persona.ts` the voice wrapped around them
 *
 * The LLM's output never reaches this file except as an `Intent` + `Entities`: a closed enum and a
 * few constrained values. It cannot inject a sentence here even if it tries, because there is no
 * parameter through which a sentence could arrive. That is the whole design.
 *
 * VARIETY. The fact-free wrapper copy (leads, fallbacks, closings, openers) comes from POOLS in
 * persona.ts, and `pick()` selects one deterministically from a per-turn seed. So the bot stops
 * sounding like a recording — without any generated text, and identically on the keyed and keyless
 * paths. The verbatim facts (statuses, policy, shipping, categories) never vary: a status is always
 * printed byte-for-byte on its own labelled line, whatever warm lead sits above it.
 */

import { store } from '@/data/store';
import { PERSONA, ORDER_LEADS, type OrderLeadClass } from '@/persona';
import type { Entities, Intent, InterestTag } from '@/intent/types';

/** A rendered turn. `text` is what the customer sees; the flags drive UI affordances. */
export interface Answer {
  text: string;
  /** Show the quick-reply menu (used by fallback + after a resolution, per the "return to main flow" rule). */
  showMenu?: boolean;
  /** Enter the simulated Live Agent state. */
  handoff?: boolean;
  /** A real link to surface (the brief requires the returns flow to provide one). */
  link?: { label: string; href: string };
  /** The bot is waiting on a specific piece of information before it can answer. */
  awaiting?: 'order_number' | 'recommend_activity' | 'recommend_conditions';
}

/** Runtime values the host page supplies, overriding the store for this call. */
export interface RenderOptions {
  /** Where "Start a return" points. Overrides `store().returnsUrl`. */
  returnsUrl?: string | undefined;
  /**
   * Where a "Shop …" button on a recommendation points — the store's shop/collection page. Without it a
   * recommendation names a category but gives no way to act on it (a dead end a real customer hits fast).
   * The host sets it; a real store would point it at the actual category page.
   */
  shopUrl?: string | undefined;
  /**
   * A status already looked up by an order provider (see src/orders/). When present it is printed
   * verbatim, which is how a real order API plugs in without the renderer knowing where it came from.
   * `null` means "looked up, and there is no such order".
   */
  orderStatus?: string | null | undefined;
  /**
   * A per-turn seed for deterministic variant selection. The orchestrator passes the customer's input,
   * so different messages get different warm variants while the same message is always reproducible
   * (which is what keeps the pools testable). Absent → variant 0, the canonical form.
   */
  seed?: string | undefined;
}

/**
 * Deterministic index from a seed string — a tiny stable hash, no Math.random (which is unavailable
 * here anyway and would break reproducibility). Same seed → same pick, always.
 */
function pickIndex(seed: string, len: number): number {
  if (len <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % len;
}

function pick<T>(pool: readonly T[], seed: string | undefined): T {
  return pool[pickIndex(seed ?? '', pool.length)]!;
}

/** Bucket a status string into a lead class. Robust to arbitrary statuses a real order API might return. */
function classifyStatus(status: string): OrderLeadClass {
  if (/deliver/i.test(status)) return 'delivered';
  if (/process|pending|prepar/i.test(status)) return 'processing';
  if (/ship|transit|out for|on its way|dispatch/i.test(status)) return 'shipped';
  return 'neutral';
}

/** Order tracking. Statuses are printed verbatim; a delivered order additionally fires the follow-up. */
export function renderOrderTracking(orderId: string | undefined, opts: RenderOptions = {}): Answer {
  if (!orderId) {
    return { text: PERSONA.askOrderNumber, awaiting: 'order_number' };
  }

  const data = store();
  // An order provider's answer wins; otherwise fall back to the bundled data.
  const status = opts.orderStatus !== undefined ? opts.orderStatus : (data.orders[orderId] ?? null);

  if (status === null) {
    return { text: PERSONA.invalidOrder, showMenu: true };
  }

  // A warm lead, seeded by the order number so it's stable per order and still varies across orders.
  // The verbatim status follows on its own "Status:" line — never merged into prose, never reworded.
  const lead = pick(ORDER_LEADS[classifyStatus(status)], orderId);
  const lines = [lead, PERSONA.orderLine(orderId, status)];

  // The brief writes #333 as "Delivered (ask follow-up if needed)" — the parenthetical is a
  // requirement, and it is the single easiest sub-step in the whole contract to miss.
  if (/delivered/i.test(status)) lines.push(data.deliveredFollowUp);

  return { text: lines.join('\n'), showMenu: true };
}

/** Returns & exchanges. All three policy conditions are verified, plus an actual link. */
export function renderReturns(opts: RenderOptions = {}): Answer {
  const data = store();
  const text = [
    pick(PERSONA.returnsOpeners, opts.seed),
    `• ${data.returnPolicy.window}`,
    `• ${data.returnPolicy.condition}`,
    `• ${data.returnPolicy.packaging}`,
    PERSONA.exchangesNote,
    PERSONA.returnsLinkLabel,
  ].join('\n');

  return {
    text,
    link: { label: 'Start a return', href: opts.returnsUrl || data.returnsUrl },
    showMenu: true,
  };
}

/**
 * Returns, when the customer is asking whether THEIR specific situation qualifies — a lost box, a used
 * item, past the window, "will you honor it?". We present the three conditions verbatim and offer a human
 * for the edge cases; we never decide their case, because we cannot promise an outcome the policy might not
 * allow. (The orchestrator detects the eligibility question and routes here — see ELIGIBILITY_PROBE.)
 */
export function renderReturnsEligibility(opts: RenderOptions = {}): Answer {
  const data = store();
  const text = [
    PERSONA.returnsEligibilityIntro,
    `• ${data.returnPolicy.window}`,
    `• ${data.returnPolicy.condition}`,
    `• ${data.returnPolicy.packaging}`,
    PERSONA.returnsEligibilityOutro,
  ].join('\n');
  return {
    text,
    link: { label: 'Start a return', href: opts.returnsUrl || data.returnsUrl },
    showMenu: true,
  };
}

/**
 * Shipping. This intent has no dedicated use case in the brief, but the bot is still verified on
 * providing shipping info accurately — the trap the review surfaced. It gets a real path.
 */
export function renderShipping(tier: Entities['shippingTier'], opts: RenderOptions = {}): Answer {
  const { shipping } = store();
  const lines =
    tier === 'standard'
      ? [shipping.standard]
      : tier === 'expedited'
        ? [shipping.expedited]
        : [shipping.standard, shipping.expedited];

  return {
    text: [pick(PERSONA.shippingOpeners, opts.seed), ...lines.map((l) => `• ${l}`)].join('\n'),
    showMenu: true,
  };
}

/**
 * Shipping, when the customer wants something the two timeframes can't answer — a specific delivery date,
 * a rush, a guarantee. We do NOT reason or promise here (a static widget can't know when an order was
 * placed or where it is): we give the two timeframes verbatim and hand off to a human. (The orchestrator
 * detects these via SHIPPING_HUMAN.)
 */
export function renderShippingEligibility(opts: RenderOptions = {}): Answer {
  const { shipping } = store();
  return {
    text: [
      pick(PERSONA.shippingOpeners, opts.seed),
      `• ${shipping.standard}`,
      `• ${shipping.expedited}`,
      PERSONA.shippingHumanOffer,
    ].join('\n'),
    showMenu: true,
  };
}

/** Recommendations. The brief requires 1-2 clarifying questions first, and a CATEGORY (not a SKU). */
export function renderRecommendation(interest: InterestTag | undefined, opts: RenderOptions = {}): Answer {
  if (!interest) {
    return { text: PERSONA.recommendOpener, awaiting: 'recommend_activity' };
  }
  const category = store().categories[interest];
  if (!category) {
    // The shop reconfigured its taxonomy and dropped this tag. Never invent a category.
    return renderNoCategoryMatch(opts);
  }
  const answer: Answer = { text: pick(PERSONA.recommendResultVariants, opts.seed)(category), showMenu: true };
  // Give them a way to ACT on the recommendation — a category name with no link is a dead end.
  if (opts.shopUrl) answer.link = { label: `Shop ${category}`, href: opts.shopUrl };
  return answer;
}

/**
 * The clarifying questions ran but the customer's interest doesn't map to any category we stock — a
 * canoe, a fishing rod, anything outside camping/hiking gear. The old behaviour dead-ended on the
 * generic "I didn't quite catch that", which is both untrue (we DID understand) and unhelpful. Instead
 * we say plainly that we don't carry it and signpost the real categories, pulled live from store(), so
 * the customer leaves with a useful next step rather than a runaround. Still invents nothing.
 */
export function renderNoCategoryMatch(opts: RenderOptions = {}): Answer {
  const categories = Object.values(store().categories);
  const text = [
    pick(PERSONA.recommendNoMatchIntro, opts.seed),
    ...categories.map((c) => `• ${c}`),
    PERSONA.recommendNoMatchOutro,
  ].join('\n');
  const answer: Answer = { text, showMenu: true };
  if (opts.shopUrl) answer.link = { label: 'Browse all gear', href: opts.shopUrl };
  return answer;
}

/** Human handoff. Clearly announced, and explicitly not a dead end. Kept single/stable (verified). */
export function renderHandoff(): Answer {
  return {
    text: `${PERSONA.handoffIntro}\n${PERSONA.handoffReturn}`,
    handoff: true,
    showMenu: true,
  };
}

/** Fallback. A clear "didn't understand" PLUS options or escalation — an apology alone would fail. */
export function renderFallback(opts: RenderOptions = {}): Answer {
  return { text: pick(PERSONA.didNotUnderstandVariants, opts.seed), showMenu: true };
}

/** A thank-you or goodbye. Acknowledge warmly and leave the menu up so they can keep going. */
export function renderClosing(opts: RenderOptions = {}): Answer {
  return { text: pick(PERSONA.closingVariants, opts.seed), showMenu: true };
}

/** The single dispatch table. Every user-visible string in the product originates from one of these. */
export function render(intent: Intent, entities: Entities = {}, opts: RenderOptions = {}): Answer {
  switch (intent) {
    case 'order_tracking':
      return renderOrderTracking(entities.orderId, opts);
    case 'returns_exchanges':
      return renderReturns(opts);
    case 'shipping_info':
      return renderShipping(entities.shippingTier, opts);
    case 'product_recommendation':
      return renderRecommendation(entities.interest, opts);
    case 'human_handoff':
      return renderHandoff();
    case 'closing':
      return renderClosing(opts);
    case 'unknown':
      return renderFallback(opts);
  }
}
