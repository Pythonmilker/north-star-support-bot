/**
 * The classification protocol — shared by the browser widget and the server-side proxy.
 *
 * This file exists so those two can never drift apart. The worker in `proxy/` imports it directly, so
 * the prompt the server sends and the schema the client validates against are literally the same
 * constants. A proxy that quietly used last month's schema would be a nasty bug to find.
 *
 * Relative imports (not the `@/` alias) on purpose: this module is compiled by Vite for the browser AND
 * by wrangler for the worker, and only one of those knows about our path aliases.
 */

import {
  CLASSIFICATION_JSON_SCHEMA,
  INTENTS,
  INTEREST_TAGS,
  type Classification,
  type Intent,
} from '../intent/types';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Longest customer message we'll classify. Past this it's not a support question, it's an attack. */
export const MAX_INPUT_CHARS = 2000;

/**
 * Models the proxy will spend the shop's money on. An allowlist, not a passthrough: without it, anyone
 * who read the proxy URL out of the page source could bill a frontier model to the shop's account.
 * `openrouter/auto` is here too, so the perpetual last-resort fallback (below) also works through the proxy.
 */
export const ALLOWED_MODELS = [
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-4o-mini',
  'google/gemini-2.5-flash',
  'openrouter/auto',
] as const;

/**
 * Newer Anthropic tiers removed sampling parameters — OpenRouter reports `temperature: false` for
 * `claude-sonnet-5` and `claude-opus-4.7`, and sending it there is a 400. Our default still accepts it,
 * and temperature 0 genuinely helps classification consistency, so we send it only where it's supported.
 */
const REJECTS_SAMPLING_PARAMS = /claude-(sonnet-5|opus-4\.7)/i;

/**
 * Model-level fallback chain — OpenRouter's `models` array. The primary (config.model / data-model) is
 * always first; these follow, in priority order. If the primary is deprecated, down, rate-limited, or
 * moderation-flagged, OpenRouter routes to the next automatically, so the LLM path survives a whole model
 * going away — with the deterministic keyword matcher still the final floor beneath all of them.
 *
 * Every NAMED entry must (a) be in ALLOWED_MODELS (the proxy spend-allowlist) and (b) honor strict
 * json_schema AND accept `temperature`. Verified live on https://openrouter.ai/api/v1/models:
 *   openai/gpt-4o-mini       structured_outputs:true  response_format:true  temperature:true  $0.15/$0.60
 *   google/gemini-2.5-flash  structured_outputs:true  response_format:true  temperature:true  $0.30/$2.50
 * Cross-vendor on purpose: an Anthropic-wide outage still gets served. Do NOT add a named
 * REJECTS_SAMPLING_PARAMS model, a ':free' tier, or a temperature:false model (e.g. gpt-5-mini) —
 * require_parameters would silently skip it, or it would 400 and abort the chain (see chainAcceptsSampling).
 *
 * `openrouter/auto` is the LAST entry, and the deliberate exception to (b): a non-versioned floating
 * router that never 404s, so the LLM path keeps working after every named model above is eventually
 * retired. It is best-effort (it may route to a model that rejects `temperature`), which is exactly why
 * it sits last — a 400 there ends the chain and drops to the keyword matcher, and can never abort an
 * earlier, still-good model. `require_parameters: true` keeps it honest: OpenRouter only routes it to a
 * provider that honors our json_schema, so auto returns a valid classification or fails cleanly to the floor.
 *
 * ONLY ONE NAMED FALLBACK, because of MAX_CHAIN_MODELS below. `auto` is worth the slot it takes: a single
 * named model covers one vendor, while auto re-routes across OpenRouter's whole catalogue (it is what
 * would have picked gemini anyway), so trading the second named model for it widens coverage rather
 * than narrowing it.
 */
export const MODEL_FALLBACKS = ['openai/gpt-4o-mini', 'openrouter/auto'] as const;

/**
 * OpenRouter rejects a `models` array longer than this with HTTP 400:
 *   "'models' array must have 3 items or fewer."
 *
 * That 400 is a malformed-request error, so it does NOT fall through to another model — it kills the
 * whole call. This shipped broken once: a four-model chain 400'd on EVERY classification, and graceful
 * degradation hid it perfectly (the bot kept answering from the keyword matcher, so every test stayed
 * green and the demo looked fine while the LLM path was completely dead). Verified live against
 * https://openrouter.ai/api/v1/chat/completions. Keep the cap; it is the only thing standing between a
 * future "just add one more fallback" and a silently inert LLM.
 */
export const MAX_CHAIN_MODELS = 3;

/** Build the ordered chain: the caller's primary first, then the fallbacks, deduped, capped. */
export function modelChain(primary: string): string[] {
  return [primary, ...MODEL_FALLBACKS.filter((m) => m !== primary)].slice(0, MAX_CHAIN_MODELS);
}

/**
 * `temperature` is one top-level param applied to whichever chain model runs. A model that rejects it
 * returns a 400 — and a malformed-request 400 does NOT fall through to the next model (OpenRouter only
 * falls through on downtime / rate-limit / context-length / moderation). So send the sampling param only
 * if EVERY chain member accepts it; otherwise omit it for the whole chain. The strict schema already
 * collapses the output space, so temperature is a nicety, not a requirement.
 */
function chainAcceptsSampling(chain: readonly string[]): boolean {
  return chain.every((m) => !REJECTS_SAMPLING_PARAMS.test(m));
}

/**
 * The classification prompt. Deliberately about *intent*, never about *answers* — the model is a router,
 * and it is told so plainly. Explaining why (rather than shouting rules at it) generalises far better to
 * phrasings we never anticipated.
 *
 * Read it and notice what is NOT here: no order statuses, no return policy, no shipping times. Not one
 * business fact. A model that never sees a fact cannot paraphrase one, and paraphrasing verified data is
 * the failure this whole architecture exists to prevent.
 */
export const SYSTEM_PROMPT = `You are the intent router for an outdoor-gear store's support chat.

You do NOT answer customers. You never write a reply, a fact, or a sentence for them to read —
another system does that. Your only job is to read what the customer said and label it.

Return exactly one intent:
- order_tracking: they want to know where an order is, or are giving an order number
- returns_exchanges: returns, exchanges, refunds, wrong size, sending something back
- shipping_info: how long delivery takes, shipping options, standard vs expedited
- product_recommendation: they want help choosing gear, or are describing a trip
- human_handoff: they EXPLICITLY asked to reach a person — "talk to a human", "live agent", "get me a
  rep", "customer service". Frustration, anger, or insults on their own ("this is useless", "I'm furious")
  are NOT human_handoff — label those unknown so we can offer help first.
- closing: they're thanking you, saying goodbye, or signalling they're done ("thanks, that's all")
- unknown: anything else, or you're genuinely unsure

Also extract, only when clearly present:
- orderId: digits only, exactly as they typed them
- shippingTier: "standard" or "expedited", only if they named one
- interest: the gear category they're shopping for, mapped to one of our six — set it whenever the item
  clearly fits one:
    shelter    = tents, tarps, shelters
    sleep      = sleeping bags, sleeping pads, quilts
    packs      = backpacks, daypacks, rucksacks
    insulation = jackets, fleece, puffies, layers, anything for warmth
    footwear   = hiking boots, trail shoes
    cooking    = stoves, pots, camp kitchen
  e.g. "recommend a tent" -> shelter, "a warm jacket" -> insulation, "a sleeping bag" -> sleep.
- catalogueFit: only when they're shopping but you gave no interest. This is a camping and hiking gear
  store — tents, sleeping bags, backpacks, insulated layers, hiking footwear, camp cooking. Set "out"
  if they want something such a store plainly would not stock (a canoe, a kayak, a fishing rod, a
  bicycle); "in" if it's clearly our kind of gear but you can't pin the category yet; "ambiguous" if
  you can't tell. This lets us tell someone we don't carry canoes right away instead of interrogating them.

Set confidence honestly. If you are guessing, say so with a low number — an honest "unknown" is far
more useful to us than a confident wrong label, because a wrong label sends the customer a wrong
answer.`;

/**
 * Follow-up context for the classifier. It is otherwise memoryless, so a follow-up like "how do I start
 * one?" has no referent and lands in `unknown`. We give it the customer's OWN recent messages — never
 * the bot's replies, which carry business facts the model could copy into an entity — purely to resolve
 * references. Kept small on purpose: a follow-up is short, and a wide window is token/bleed surface, not
 * signal.
 */
export const HISTORY_MAX_TURNS = 3;
export const HISTORY_TURN_CHARS = 200;

/**
 * Build the OpenRouter request body. The ONE place this shape is defined, so the direct-from-browser
 * path and the proxied path cannot disagree about what a classification request looks like.
 *
 * `history` is the customer's recent prior messages (oldest→newest). With none, the body is BYTE-IDENTICAL
 * to the old single-turn request — the verified single-turn path is untouched; only multi-turn gains context.
 */
export function buildClassificationBody(
  model: string,
  text: string,
  history?: readonly string[],
): Record<string, unknown> {
  const models = modelChain(model);
  const current = text.slice(0, MAX_INPUT_CHARS);
  const recent = (history ?? []).slice(-HISTORY_MAX_TURNS).map((h) => h.slice(0, HISTORY_TURN_CHARS));
  const userContent = recent.length
    ? 'Earlier in this chat the customer said (oldest first) — use these ONLY to resolve references like ' +
      '"it" / "one" / "that", never as the thing to classify:\n' +
      recent.map((h) => `• ${h}`).join('\n') +
      `\n\nClassify ONLY this new message:\n${current}`
    : current;
  return {
    // OpenRouter's fallback chain: primary first, then MODEL_FALLBACKS. Survives a model deprecation
    // or outage; the keyword matcher remains the floor beneath the whole chain.
    models,
    max_tokens: 200,
    // Sent only if EVERY chain member accepts it — otherwise a rejecting model 400s and aborts the chain.
    ...(chainAcceptsSampling(models) ? { temperature: 0 } : {}),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'classification', strict: true, schema: CLASSIFICATION_JSON_SCHEMA },
    },
    /**
     * Without this, OpenRouter may route to a provider that silently IGNORES response_format and returns
     * prose — the exact failure this architecture exists to prevent. `require_parameters` makes it refuse
     * to route instead, so a provider that can't honour the schema fails loudly (and we fall back to the
     * rule matcher) rather than quietly handing us an unconstrained answer.
     */
    provider: { require_parameters: true },
  };
}

function isIntent(v: unknown): v is Intent {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v);
}

/**
 * Parse and hard-validate the model's reply. Anything unexpected is a rejection, not a crash.
 *
 * Every field is re-checked here rather than trusted because the schema was requested. Structured output
 * is a strong hint, not a guarantee — and a stray value must never reach the renderer.
 */
export function parseClassification(raw: string): Classification | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;

  const obj = data as Record<string, unknown>;
  if (!isIntent(obj['intent'])) return undefined;

  const rawEntities = (obj['entities'] ?? {}) as Record<string, unknown>;

  /**
   * Clamp to 0..1 here rather than asking the schema to do it.
   *
   * The schema USED to say `minimum: 0, maximum: 1`, and Anthropic's structured outputs reject those on
   * a number — a 400 that killed the whole LLM path (see CLASSIFICATION_JSON_SCHEMA). But code is the
   * better home for this anyway: the model's reply is untrusted input no matter what we asked for, and a
   * confidence of 7 sailing through would defeat CONFIDENCE_THRESHOLD and let a wild guess answer as if
   * it were certain — the exact failure this whole architecture exists to prevent.
   */
  const rawConfidence = obj['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0.5;

  const classification: Classification = {
    intent: obj['intent'],
    entities: {},
    confidence,
  };

  const orderId = rawEntities['orderId'];
  if (typeof orderId === 'string' && /^\d{1,10}$/.test(orderId)) {
    classification.entities.orderId = orderId;
  }

  const tier = rawEntities['shippingTier'];
  if (tier === 'standard' || tier === 'expedited') {
    classification.entities.shippingTier = tier;
  }

  const interest = rawEntities['interest'];
  if (typeof interest === 'string' && (INTEREST_TAGS as readonly string[]).includes(interest)) {
    classification.entities.interest = interest as (typeof INTEREST_TAGS)[number];
  }

  const fit = rawEntities['catalogueFit'];
  if (fit === 'in' || fit === 'out' || fit === 'ambiguous') {
    classification.entities.catalogueFit = fit;
  }

  return classification;
}

/* ================================================================================================
 * COMPOSE PROTOCOL — the generative layer.
 *
 * Unlike classification (which forbids free text), compose deliberately asks the model to WRITE prose.
 * The safety comes from a different place: the model may only reference business data through
 * `{{SLOT}}` tokens, which code substitutes verbatim AFTER generation (see answer/compose.ts). The
 * model literally never types a status, a policy, or a price — it types a token. Every purpose has a
 * fixed allow-list of tokens; anything else, or any leftover `{{`, discards the whole reply and the
 * deterministic renderer answers instead.
 *
 * The purpose is a closed enum chosen by our own code, never by the customer — so this can be proxied
 * without becoming a general-purpose LLM.
 * ============================================================================================== */

/** Every placeholder token the compose layer understands. A token outside this set voids the reply. */
export const SLOT_NAMES = [
  'RETURN_POLICY',
  'RETURNS_LINK',
  'SHIPPING_STANDARD',
  'SHIPPING_EXPEDITED',
  'CATEGORY_RECOMMENDED',
  'CATEGORY_LIST',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

import { COMPOSE_PURPOSES, type ComposePurpose } from '../intent/types';

/** Per-purpose brief: what to write, and which tokens are allowed / required. */
export interface PurposeSpec {
  brief: string;
  allowed: readonly SlotName[];
  required: readonly SlotName[];
}

export const PURPOSE_SPECS: Record<ComposePurpose, PurposeSpec> = {
  returns: {
    brief:
      'The customer asked about returns or exchanges. Use the reference-data conditions to answer THEIR ' +
      'actual question. If they just want the policy, present it warmly. If they describe a situation or ask ' +
      'whether something qualifies ("I lost my packaging", "can I return a used item?", "will you honor it?"), ' +
      'reason from the conditions and tell them honestly whether it meets them — if a required condition ' +
      'clearly is not met, say so kindly and plainly. Do NOT promise to waive, override, or make an exception ' +
      'yourself, and never call a required condition optional or unnecessary; instead offer to connect them ' +
      'with a live agent for special cases (they can just say "live agent"). Always include the exact policy ' +
      'once via {{RETURN_POLICY}} on its own line, and refer to any number or timeframe only through that ' +
      'token — never write a number yourself. A "Start a return" button appears automatically; you may point ' +
      'to it, but write no URL or file name.',
    allowed: ['RETURN_POLICY'],
    required: ['RETURN_POLICY'],
  },
  shipping_standard: {
    brief:
      'The customer asked about standard shipping. Warmly answer, then present the token ' +
      '{{SHIPPING_STANDARD}} on ITS OWN LINE (it already reads "Standard shipping: 3-5 business days", so ' +
      "don't wrap it mid-sentence). Include it once. Do NOT quote or imply any cost, compare speeds, or " +
      'promise a particular delivery day — let the token state the timeframe.',
    allowed: ['SHIPPING_STANDARD'],
    required: ['SHIPPING_STANDARD'],
  },
  shipping_expedited: {
    brief:
      'The customer asked about expedited/fast shipping. Warmly answer, then present the token ' +
      '{{SHIPPING_EXPEDITED}} on ITS OWN LINE (it already reads "Expedited shipping: 1-2 business days", so ' +
      "don't wrap it mid-sentence). Include it once. Do NOT quote or imply any cost, compare speeds, or " +
      'promise a particular delivery day — let the token state the timeframe.',
    allowed: ['SHIPPING_EXPEDITED'],
    required: ['SHIPPING_EXPEDITED'],
  },
  shipping_both: {
    brief:
      'The customer asked about shipping in general. Warmly lay out both options using the tokens ' +
      '{{SHIPPING_STANDARD}} and {{SHIPPING_EXPEDITED}}, each once, each on its own line. Do NOT compare ' +
      'their speeds in your own words, quote or imply any cost, or promise delivery on any particular day — ' +
      'the tokens state the timeframes; let them speak.',
    allowed: ['SHIPPING_STANDARD', 'SHIPPING_EXPEDITED'],
    required: ['SHIPPING_STANDARD', 'SHIPPING_EXPEDITED'],
  },
  recommendation: {
    brief:
      'Based on the chat, recommend the gear category carried by the token {{CATEGORY_RECOMMENDED}}. ' +
      'Include that token once. Recommend a CATEGORY, never a specific product or price. Keep it to a ' +
      'sentence or two, warm and outdoorsy.',
    allowed: ['CATEGORY_RECOMMENDED'],
    required: ['CATEGORY_RECOMMENDED'],
  },
  out_of_catalogue: {
    brief:
      "The customer is shopping for something that doesn't cleanly match a category we carry. Use the " +
      "reference data (what they've told you they want, and the exact categories we carry) to answer " +
      'HONESTLY. Warmly acknowledge it\'s not quite in our lineup — but do NOT name a specific thing "we ' +
      "don't carry\" or invent a reason why (you don't actually know why; guessing — e.g. \"we don't carry " +
      'winter-specific gear" — is worse than saying nothing). Do NOT pretend we stock it. If part of what ' +
      "they described genuinely fits one of the categories in the reference data, you MAY point to that " +
      "category by its exact name. FINISH your sentence with a period, then on a NEW line present the list " +
      '{{CATEGORY_LIST}} by itself — never weave it into the middle of a sentence (not "our {{CATEGORY_LIST}} ' +
      'includes…"). After the list, offer a live agent for anything specific. Never invent a product, a ' +
      'price, or a category name that is not in the reference data.',
    allowed: ['CATEGORY_LIST'],
    required: ['CATEGORY_LIST'],
  },

  // ── Fact-free conversational replies (no slots) ────────────────────────────────────────────────
  fallback: {
    brief:
      "You did not understand the customer's message. In one warm, human sentence, say so and invite them " +
      'to pick from the menu below or ask for a live agent. Do NOT guess at what they meant, and state no ' +
      'policy, price, timeframe, or order detail.',
    allowed: [],
    required: [],
  },
  closing: {
    brief:
      'The customer is wrapping up — a thanks or a goodbye. Reply warmly and briefly, leave the door open ' +
      'for anything else, and sign off with a little outdoors warmth. One sentence. No facts.',
    allowed: [],
    required: [],
  },
  clarify_activity: {
    brief:
      "The customer wants a gear recommendation but hasn't said what for. In one friendly, outdoorsy " +
      "question, ask what they're heading out to do. Do NOT recommend anything yet, and state no facts.",
    allowed: [],
    required: [],
  },
  clarify_conditions: {
    brief:
      'The customer is shopping for gear and named the activity. In one friendly question, ask what ' +
      'conditions they expect out there (weather, season, terrain). Do NOT recommend yet, and state no facts.',
    allowed: [],
    required: [],
  },
};

export const COMPOSE_SYSTEM_PROMPT = `You are North Star Support Bot, a friendly, helpful, concise support
agent for an outdoor camping and hiking gear store. Voice: warm, outdoorsy, never stiff, never a wall of text
— a sentence or two.

Absolute rules:
- Exact VALUES — order statuses, policies, timeframes, prices, product categories, links — are provided ONLY
  as a token like {{RETURN_POLICY}}. Write these tokens EXACTLY, braces and all, and let them carry the exact
  wording and numbers. Never retype a number, price, or timeframe yourself, and never invent one.
- You MAY reason about and refer to any "Reference data" you are given (e.g. that a return needs its original
  packaging) to answer the customer honestly — but never contradict it (don't call a required thing optional),
  and never promise an outcome it doesn't support. When unsure, present the token and offer a live agent.
- Use only the tokens you are told are allowed for this reply. Do not invent tokens.
- Do not add claims beyond the data. No "free shipping", no "on sale", no delivery guarantees.
- You are writing the whole customer-facing message. Return it in the "message" field.`;

/** The compose response schema. A single prose field — the SLATE the model fills. Validated downstream. */
export const COMPOSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export function buildComposeBody(
  model: string,
  purpose: ComposePurpose,
  text: string,
  context?: string,
): Record<string, unknown> {
  const spec = PURPOSE_SPECS[purpose];
  const userBlock =
    `Reply to write: ${spec.brief}\n` +
    (context
      ? `Reference data (reason over this to answer accurately — but present the exact values only through ` +
        `the tokens; never retype a number or the policy text): ${context}\n`
      : '') +
    `Allowed tokens: ${spec.allowed.map((s) => `{{${s}}}`).join(', ') || '(none)'}\n` +
    `The customer said: "${text.slice(0, MAX_INPUT_CHARS)}"`;
  const models = modelChain(model);
  return {
    models,
    max_tokens: 250,
    ...(chainAcceptsSampling(models) ? { temperature: 0.4 } : {}),
    messages: [
      { role: 'system', content: COMPOSE_SYSTEM_PROMPT },
      { role: 'user', content: userBlock },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'composed', strict: true, schema: COMPOSE_JSON_SCHEMA },
    },
    provider: { require_parameters: true },
  };
}

/** Pull the message string out of a compose reply. Anything unexpected → undefined (→ deterministic). */
export function parseCompose(raw: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const msg = (data as Record<string, unknown>)['message'];
  return typeof msg === 'string' && msg.trim() ? msg : undefined;
}

/** Which purposes exist, re-exported for the proxy's allow-list. */
export { COMPOSE_PURPOSES };
export type { ComposePurpose };
