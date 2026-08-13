/**
 * THE GENERATIVE LAYER — human-feeling prose, with the EXACT facts still owned by code.
 *
 * The model writes the whole reply. Every exact VALUE (a status, a policy line, a timeframe, a price, a
 * category name) is a `{{SLOT}}` token it emits and never types; this module substitutes the verbatim
 * `store()` value AFTER generation, so a verified value is always byte-exact — the model can't misquote a
 * number it never wrote.
 *
 * What the model CAN now do (for returns) is REASON over the policy: it is handed the real conditions as
 * context, so asked "will you honor a return with no packaging?" it can answer honestly ("original packaging
 * is required, so that's outside the standard return — a live agent can help") instead of reassuring blindly.
 * The old blind slot-fill is exactly what produced the false-promise bug; giving the model the facts fixed
 * it. Safety is now: the exact values stay slotted, and the validator voids a reply that CONTRADICTS a
 * condition, PROMISES an outcome, or invents a number/attribute.
 *
 * Everything here fails safe. `composeOrRender` is handed the deterministic `Answer` (from render.ts)
 * as `base`, and returns exactly that base unless a fully-valid composed message is produced. So:
 *   - no key / rules provider / conversational off  → base (the model is never called)
 *   - transport failure, timeout, unparseable reply  → base
 *   - the model used a token it wasn't allowed, or one that can't resolve  → base
 *   - a required datum is missing, or any `{{` survives substitution  → base
 *   - the model wrote a number/price OUTSIDE a slot, contradicted a condition, or promised an outcome  → base
 * A raw `{{token}}` can therefore never reach a customer, and a verified value is always byte-exact
 * (it came from `store()` via substitution) or the whole turn falls back to the tested deterministic reply.
 *
 * Compose only ever replaces `answer.text`. Every flag — `link`, `showMenu`, `handoff`, `awaiting` — and
 * the state machine come from render.ts and pass through untouched, so generation can't break a flow or
 * drop the verified returns-link button.
 */

import { store } from '@/data/store';
import type { Answer } from '@/answer/render';
import {
  PURPOSE_SPECS,
  SLOT_NAMES,
  parseCompose,
  type SlotName,
} from '@/transport/protocol';
import type { ComposePurpose, IntentProvider, InterestTag } from '@/intent/types';

/** What the resolvers need from the current turn to fill dynamic slots. */
export interface SlotContext {
  interest?: InterestTag | undefined;
  returnsUrl?: string | undefined;
}

/**
 * Token → verbatim value. Reads the SAME `store()` the deterministic renderer reads, so there is exactly
 * one source of truth. A resolver returning null means "no value right now" → the whole reply is voided.
 */
const SLOT_RESOLVERS: Record<SlotName, (ctx: SlotContext) => string | null> = {
  RETURN_POLICY: () => {
    const p = store().returnPolicy;
    return [`• ${p.window}`, `• ${p.condition}`, `• ${p.packaging}`].join('\n');
  },
  RETURNS_LINK: (ctx) => ctx.returnsUrl || store().returnsUrl,
  SHIPPING_STANDARD: () => store().shipping.standard,
  SHIPPING_EXPEDITED: () => store().shipping.expedited,
  CATEGORY_RECOMMENDED: (ctx) => (ctx.interest ? (store().categories[ctx.interest] ?? null) : null),
  CATEGORY_LIST: () =>
    Object.values(store().categories)
      .map((c) => `• ${c}`)
      .join('\n'),
};

const TOKEN_RE = /\{\{\s*([A-Z_]+)\s*\}\}/g;
const SLOT_SET = new Set<string>(SLOT_NAMES);

/**
 * A fabricated fact hiding in the prose OUTSIDE any slot. The slots carry every real number, price, and
 * timeframe, so a digit or a promo claim in the model's own words is a hallucinated fact — void the reply.
 * Checked on the TEMPLATE (before substitution), because after substitution the slot values legitimately
 * contain digits ("3-5 business days").
 */
function hasFabricatedFact(templateWithoutTokens: string): boolean {
  if (/\d/.test(templateWithoutTokens)) return true; // any number the model invented
  if (/[$%]/.test(templateWithoutTokens)) return true; // a price or a percentage
  // "free" is a promo claim in either word order ("free shipping" / "shipping is free") — but allow the
  // idiom "feel free to…", which carries no promise.
  if (/\bfree\b/i.test(templateWithoutTokens.replace(/feel\s+free/gi, ''))) return true;
  if (
    /\b(on\s+sale|discount|coupon|clearance|bogo|guarantee\w*|% ?off|price\s*match|on\s+the\s+house|no\s+charge|complimentary|gratis)\b/i.test(
      templateWithoutTokens,
    )
  )
    return true; // promises we never made
  return false;
}

/**
 * The model inventing an ATTRIBUTE the data doesn't carry — a product claim on a recommendation ("fully
 * waterproof and lightweight"), or a spec on an out-of-catalogue reply. These purposes carry only a category
 * NAME in their slot, so any adjective about performance is fabricated. (Returns/shipping are handled
 * differently now — the model is GIVEN the policy data to reason over, so it may reference the conditions
 * correctly; a negated requirement is caught by CONTRADICTION_PROSE, and shipping's no-data claims by
 * SHIPPING_NODATA below.)
 */
// NOTE: "insulated" is deliberately NOT here — it's a word in our own category NAME ("Insulated Jackets &
// Layers"), so the model must be able to write it when it names that category. The words below are genuine
// invented SPECS (we detail no product), not category names.
const FACT_PROSE_PATTERNS: Partial<Record<ComposePurpose, RegExp>> = {
  out_of_catalogue: /\b(waterproof|weatherproof|lightweight|durable|breathable|warmest|top[-\s]?rated|premium|popular)\b/i,
  // Recommendations carry only a category NAME — any performance claim OR pricing language is unsupported
  // (we have no price data and name no SKU). "great options at every price point" is exactly this.
  recommendation:
    /\b(waterproof|weatherproof|lightweight|durable|breathable|warmest|top[-\s]?rated|premium|popular|bestsell\w*|price\s*point|priced?|pricing|cheap\w*|affordable|budget|expensive|inexpensive|value|deal|bargain|every\s+price)\b/i,
};

/**
 * Shipping is NOT given the timeframes to reason over yet (only returns is), so its prose must not editorialise
 * speed or invent cost/coverage — the two tier tokens carry the facts. (Returns reasoning is a separate path.)
 */
const SHIPPING_NODATA = /\b(faster|slower|quick\w*|speedier|fastest|slowest|business\s+days?|weekends?|internationa\w*|overnight|same[-\s]?day|cost\w*|fees?|charges?|priced?|expensive|cheap\w*)\b/i;

/** True when the model's prose invents an attribute/claim its slot never carried. */
function proseAdjudicatesFact(prose: string, purpose: ComposePurpose): boolean {
  const pattern = FACT_PROSE_PATTERNS[purpose];
  if (pattern && pattern.test(prose)) return true;
  if ((purpose === 'shipping_standard' || purpose === 'shipping_expedited' || purpose === 'shipping_both') && SHIPPING_NODATA.test(prose)) return true;
  return false;
}

/**
 * The model CONTRADICTING a policy condition — saying a required thing is optional/waived/unnecessary. Now
 * that the model is given the real policy to reason over, an honest affirmation ("original packaging is
 * required, so this wouldn't qualify") is exactly what we want and is allowed; what we still forbid is the
 * negation ("packaging isn't required", "no need for the box", "no time limit"). The model rarely does this
 * once it has the correct facts — this is the backstop for when it does. Void → deterministic reply.
 */
const CONTRADICTION_PROSE =
  /\b(no need|not (necessary|required|mandatory)|isn'?t required|aren'?t required|(is|are|it'?s|that'?s)\s+optional|doesn'?t (have to|need to|matter)|don'?t (have to|need to|worry about|stress about|sweat)|no worries about|(totally|perfectly|completely|absolutely)\s+fine|no (time ?limit|deadline|restrictions?|conditions?)|unlimited returns?|regardless of (the )?(condition|packag\w*|state)|(without|no|missing)\s+(the |your |any )?(packag\w*|box\w*|receipts?|tags?)\s*(is|are|it'?s|that'?s|will be)?\s*(fine|ok|okay|acceptable|allowed|no problem|totally fine)|(used|worn|opened|damaged|unpackaged)\s+(item|items|one|ones|gear|product|tent|jacket|\w+)?\s*(is|are|it'?s|that'?s)?\s*(totally |perfectly )?(fine|ok|okay|acceptable|allowed|no problem))\b/i;

/** True when a conditional-purpose reply's prose contradicts (negates) one of its policy conditions. */
function proseContradictsPolicy(prose: string, purpose: ComposePurpose): boolean {
  return CONDITIONAL_PURPOSES.has(purpose) && CONTRADICTION_PROSE.test(prose);
}

/** Purposes whose facts are CONDITIONAL — a policy or timeframe the bot must never promise around. */
const CONDITIONAL_PURPOSES = new Set<ComposePurpose>([
  'returns',
  'shipping_standard',
  'shipping_expedited',
  'shipping_both',
]);

/**
 * An explicit OUTCOME-PROMISE in the model's own prose — the bot committing to honour, waive, refund, or
 * make an exception. It cannot see whether the customer's situation meets the policy (that's in a slot), so
 * any such promise is unbacked. A real, observed failure: "Absolutely! We've got you covered" in reply to
 * "will you honor a return with no packaging?" — a promise that contradicts "Original packaging required".
 *
 * The orchestrator already routes eligibility QUESTIONS to the deterministic renderer; this is the backstop
 * for a reply that promises an outcome without one — e.g. the model volunteering "we'll waive that for you".
 * Kept to explicit commitments (not every "of course"), so ordinary warm framing on a normal turn survives.
 */
const PROMISE_PROSE =
  /\b(we'?ll|we will|we can|we'?d|we do|i'?ll|i can)\s+(honou?r|waive|accept (it|them|that|your)|take (it|them|that|your) back|make an exception|refund (you|it|that)|cover (that|you)|sort (it|this|that) out|take care of (you|it|this|that)|handle (it|this|that|your)|get you sorted)\b|\b(rest assured|we guarantee|i guarantee|guaranteed|no exceptions?|make an exception|we promise|i promise|you'?re (all )?(set|good|good to go|covered)|(that|this|it)\s+qualifies|good to go|we'?ve got (it|this|you)\b|we got (you|this)|send (it|them|that|your \w+) (on\s+)?back and|no problem at all,?\s+(we|you)'?ll)\b/i;

/** True when a conditional-purpose reply's prose promises an outcome the bot can't stand behind. */
function prosePromisesOutcome(prose: string, purpose: ComposePurpose): boolean {
  return CONDITIONAL_PURPOSES.has(purpose) && PROMISE_PROSE.test(prose);
}

/**
 * Turn a composed template into a customer-ready string, or null to fall back. This is the whole safety
 * gate — see the module header for every reason it returns null.
 */
export function validateAndFill(
  template: string,
  purpose: ComposePurpose,
  ctx: SlotContext,
): string | null {
  const spec = PURPOSE_SPECS[purpose];
  const allowed = new Set<string>(spec.allowed);

  // 1. Every token the model used must be known AND allowed for this purpose.
  const used = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const token = m[1]!;
    if (!SLOT_SET.has(token) || !allowed.has(token)) return null;
    used.add(token);
  }

  // 2. Every REQUIRED datum for this purpose must actually be present.
  for (const req of spec.required) {
    if (!used.has(req)) return null;
  }

  // 3. No fabricated fact in the model's own prose (checked before substitution, so the slot's own
  //    values never trip it). Two screens: an invented number/price/promo (any purpose), and — for the
  //    fact-bearing purposes — the model adjudicating a fact the slot owns (e.g. "the box isn't required").
  const prose = template.replace(TOKEN_RE, ' ');
  if (hasFabricatedFact(prose)) return null; // an invented number / price / promo
  if (proseAdjudicatesFact(prose, purpose)) return null; // an invented product attribute or no-data claim
  if (proseContradictsPolicy(prose, purpose)) return null; // a NEGATED policy condition ("not required")
  if (prosePromisesOutcome(prose, purpose)) return null; // a promise to honour/waive/make an exception

  // 4. Substitute each token with its verbatim value; a null resolver voids the whole reply.
  //    The `() => value` replacer keeps a literal `$` in a value from being read as a replacement group.
  let out = template;
  for (const token of used) {
    const value = SLOT_RESOLVERS[token as SlotName](ctx);
    if (value === null) return null;
    out = out.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g'), () => value);
  }

  // 5. Backstop: if ANY brace pair survived (an unknown/misspelled token we didn't substitute), void it.
  //    This is the ironclad "a raw {{…}} never reaches a customer" guarantee.
  if (/\{\{|\}\}/.test(out)) return null;

  return out.trim();
}

/**
 * Compose a reply for `purpose`, or return the deterministic `base` on any failure. `base` MUST be the
 * render.ts Answer for this same turn — it supplies every flag and is the fallback text.
 */
/**
 * The real data the model may REASON over for this purpose — so it can answer the customer's actual
 * question ("does a lost-packaging return qualify?") instead of reassuring blindly. Built live from
 * store(), so it never drifts from the client's configured data. The exact values are STILL presented via
 * the slot; this is context for judgement, not text to copy. Only the conditional policies get it.
 */
function factContextFor(purpose: ComposePurpose): string | undefined {
  const s = store();
  if (purpose === 'returns') {
    return (
      `Our return policy — ALL of these must be met for a standard return: ` +
      `"${s.returnPolicy.window}", "${s.returnPolicy.condition}", "${s.returnPolicy.packaging}". ` +
      `Exchanges follow the same policy.`
    );
  }
  if (purpose === 'out_of_catalogue') {
    return (
      `This is a camping and hiking gear store. The ONLY categories we carry are: ` +
      `${Object.values(s.categories).join(', ')}. We carry NOTHING outside these categories.`
    );
  }
  return undefined;
}

export async function composeOrRender(
  purpose: ComposePurpose,
  base: Answer,
  provider: IntentProvider | undefined,
  text: string,
  ctx: SlotContext,
  askContext?: string,
): Promise<Answer> {
  if (!provider?.compose) return base;

  // The reference data the model reasons over: the store facts for this purpose, plus (for the
  // recommendation flow) a summary of what the customer is actually shopping for — so an out-of-catalogue
  // reply reasons over the WHOLE ask ("pants, fishing, winter") instead of guessing from the last word.
  const context = [factContextFor(purpose), askContext].filter(Boolean).join('\n') || undefined;
  const result = await provider.compose(purpose, text, context);
  if (!result.ok) return base;

  const filled = validateAndFill(result.value, purpose, ctx);
  if (filled === null) return base;

  // Only the words change. Flags, link, showMenu, awaiting — all inherited from the deterministic base.
  return { ...base, text: filled };
}
