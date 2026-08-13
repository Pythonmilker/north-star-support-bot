/**
 * The contract between "understanding" and "answering".
 *
 * THE INVARIANT: a classification carries NO free text. It is a closed enum plus a couple of
 * tightly-constrained entities. This is what makes it *structurally impossible* for the model to
 * author a customer-facing fact — not a rule we ask it to follow, but a shape it cannot express.
 *
 * The prior art in this developer's own codebase shows why this matters: a tool declared as
 * `answer_faq({ topic })` in the design doc shipped as `answer_faq({ topic, answer })` in the code,
 * and the model quietly took over the factual payload. `tests/schema.test.ts` enforces that the
 * same drift cannot happen here.
 */

/** The closed intent set. Anything unrecognised becomes `unknown` and escalates — never a guess. */
export const INTENTS = [
  'order_tracking',
  'returns_exchanges',
  'product_recommendation',
  'shipping_info',
  'human_handoff',
  'closing',
  'unknown',
] as const;

export type Intent = (typeof INTENTS)[number];

/** Interest hints for the recommendation flow. A closed set — the model picks, it does not invent. */
export const INTEREST_TAGS = [
  'shelter',
  'sleep',
  'packs',
  'insulation',
  'footwear',
  'cooking',
] as const;

export type InterestTag = (typeof INTEREST_TAGS)[number];

/**
 * Extracted entities. Every field is either a constrained enum or a digit-only string.
 * Note there is no `answer`, `text`, `message`, or `reply` field — and there never may be.
 */
export interface Entities {
  /** Digits only, as typed by the customer (e.g. "111"). Never a status, never prose. */
  orderId?: string;
  /** Which shipping tier the customer asked about, if they were specific. */
  shippingTier?: 'standard' | 'expedited';
  /** What the customer seems to be shopping for, used to pick a category. */
  interest?: InterestTag;
  /**
   * The model's read on whether the customer is shopping for something we actually stock. Used ONLY
   * when `interest` is absent, to answer an out-of-catalogue request (a canoe, a kayak) in one turn
   * instead of running them through the clarifying questions first. Still a closed enum — no prose.
   *   'out'       — clearly something a camping/hiking store wouldn't carry → say so now, skip the questions
   *   'in'        — clearly gear we carry, category not yet pinned → normal flow
   *   'ambiguous' — shopping, but can't tell yet → ask the clarifying questions
   * The keyword matcher never sets this (it has no world knowledge), so offline behaviour is unchanged.
   */
  catalogueFit?: 'in' | 'out' | 'ambiguous';
}

export interface Classification {
  intent: Intent;
  entities: Entities;
  /** 0..1. Below the threshold we deliberately fall back rather than answer confidently and wrongly. */
  confidence: number;
}

/** Below this, route to the fallback/handoff path. A confident wrong answer is worse than "I don't know". */
export const CONFIDENCE_THRESHOLD = 0.6;

/** Typed failures, so the orchestrator can tell "no key" from "rate limited" from "offline". */
export type ClassifyFailure =
  | { kind: 'no_key' }
  | { kind: 'rate_limited' }
  | { kind: 'offline' }
  | { kind: 'timeout' }
  | { kind: 'bad_response'; detail: string };

export type ClassifyResult =
  | { ok: true; value: Classification }
  | { ok: false; error: ClassifyFailure };

/**
 * Compose purposes — the closed set of reply types the generative layer may write. Each maps to a
 * server-owned prompt block and a fixed set of allowed slots (see transport/protocol.ts). Deliberately
 * NO order-tracking purpose: an order status is the most accuracy-critical line, and its warm lead is
 * status-class-specific, so it stays 100% deterministic (a generated lead could mis-frame a Processing
 * order as shipped). Composition covers only the fact-free-framed surfaces.
 */
export const COMPOSE_PURPOSES = [
  'returns',
  'shipping_standard',
  'shipping_expedited',
  'shipping_both',
  'recommendation',
  'out_of_catalogue',
  // Fact-free conversational replies. No slots — nothing to get wrong — so the model writes them freely,
  // validated only against inventing a fact (a stray number or promo). This is what keeps the bot from
  // sounding hardcoded on the turns where there is no business data to protect.
  'fallback',
  'closing',
  'clarify_activity',
  'clarify_conditions',
] as const;

export type ComposePurpose = (typeof COMPOSE_PURPOSES)[number];

export type ComposeResult =
  | { ok: true; value: string }
  | { ok: false; error: ClassifyFailure };

/** Anything that can turn text into a classification: the LLM, or the deterministic matcher. */
export interface IntentProvider {
  readonly name: 'llm' | 'rules';
  /**
   * Classify the CURRENT message. `history` is the customer's OWN recent prior messages (oldest→newest,
   * capped), passed only so the model can resolve a follow-up's references ("how do I start one?" after
   * "what's your return policy?"). It deliberately never contains the bot's replies: the classifier must
   * not see a business fact it could lift into an entity. The rule matcher ignores it entirely, so the
   * keyless floor is historyless and behaves identically with or without a key.
   */
  classify(text: string, history?: readonly string[]): Promise<ClassifyResult>;
  /**
   * Generate a warm reply for `purpose`, as prose studded with `{{SLOT}}` tokens the caller fills
   * verbatim. LLM-only; the rule matcher leaves it undefined, so the deterministic renderer is used.
   * Deliberately takes NO history: compose is the one generative surface, and any prior text handed to
   * it is text the model could copy into its prose outside a slot. The `purpose` enum is its topic.
   *
   * `context` is the real business data the model may REASON over (e.g. the return-policy conditions), so
   * it can answer the customer's actual question honestly rather than reassuring blindly. The exact values
   * are still presented via the tokens; the validator rejects a contradicted condition or a fabricated
   * number, so reasoning stays safe.
   */
  compose?(purpose: ComposePurpose, text: string, context?: string): Promise<ComposeResult>;
}

/**
 * The JSON Schema handed to the LLM. Mirrors the types above and is deliberately `additionalProperties:
 * false` so the model cannot bolt on a field of its own. `tests/schema.test.ts` walks this object and
 * fails if any unconstrained string property ever appears.
 */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    entities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        orderId: { type: 'string', pattern: '^[0-9]{1,10}$' },
        shippingTier: { type: 'string', enum: ['standard', 'expedited'] },
        interest: { type: 'string', enum: [...INTEREST_TAGS] },
        catalogueFit: { type: 'string', enum: ['in', 'out', 'ambiguous'] },
      },
    },
    /**
     * 0..1 — but the range is NOT expressed here, and that is not an oversight.
     *
     * Anthropic's structured-output implementation rejects `minimum`/`maximum` on a number:
     *
     *   400  output_config.format.schema: For 'number' type, properties maximum, minimum are not supported
     *
     * Every provider OpenRouter routes to (Bedrock, Azure) returns that. With `require_parameters: true`
     * there is no provider left to fall back to, so the request 400s — and because the orchestrator
     * degrades gracefully on ANY transport failure, the widget kept answering from keyword rules and
     * nothing looked broken. The entire LLM path was dead for two words of JSON schema, silently.
     *
     * The constraint didn't disappear; it moved to where it's actually enforceable.
     * `parseClassification()` clamps the value, which is the right place anyway: a schema is a request,
     * and a model's reply is untrusted input regardless of what we asked for.
     */
    confidence: { type: 'number' },
  },
  required: ['intent', 'entities', 'confidence'],
} as const;
