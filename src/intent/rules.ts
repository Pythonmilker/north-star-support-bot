/**
 * Deterministic intent matcher — the floor under the whole product.
 *
 * This runs with no API key, no network, and no cost. It is what answers when OpenRouter is missing,
 * rate-limited, offline, or slow. Because it exists, a client-side key that dies mid-evaluation
 * degrades the bot's *understanding* rather than breaking the bot.
 *
 * It is intentionally conservative: when nothing scores above the bar it returns `unknown`, which
 * routes to the fallback + escalation path. Guessing would be worse than admitting ignorance —
 * a confident wrong answer against verified data is the one failure we cannot take back.
 */

import {
  type Classification,
  type ClassifyResult,
  type Entities,
  type Intent,
  type IntentProvider,
  type InterestTag,
} from './types';

interface Rule {
  intent: Intent;
  patterns: RegExp[];
}

/**
 * The patterns were widened against `tests/intent-corpus.test.ts` — ~90 phrasings a real shopper might
 * type. The first draft passed its own unit tests and then missed 18 of them, all in the same way:
 * written for the phrasing the author imagined rather than the one a customer types. "help me pick" was
 * covered; "help picking" was not. "return" was covered; "returnable" was not (the `\b` after
 * `return(s|ing)?` can't match mid-word). "suggest" was covered; "suggestions" was not.
 *
 * That is what the corpus is for. Add a phrasing there first, watch it fail, then widen a pattern.
 */
const RULES: Rule[] = [
  {
    intent: 'order_tracking',
    patterns: [
      /\b(track|tracking)\b/i,
      /\bwhere('?s| is|s)?\b.*\b(order|package|parcel|stuff|it)\b/i,
      /\border\s*(status|update|#?\d+)\b/i,
      /\b(my|the)\s+(order|package|parcel|delivery|shipment|stuff|item|items)\b/i,
      /\bhasn'?t\s+(arrived|shipped|come)\b/i,
      /\bstill\s+hasn'?t\b/i,
      /\bcheck\b[^.!?]*\bon\s+(my|an|the)\s+order\b/i,
      /\b(did|has|have)\b[^.!?]*\bship(ped)?\s+yet\b/i,
      // A bare order number ("#222", "222"). Customers routinely just paste the number — with no
      // keyword to match on, this would otherwise fall straight through to the fallback.
      /^\s*#?\s*\d{1,10}\s*$/,
    ],
  },
  {
    intent: 'returns_exchanges',
    patterns: [
      // `return(s|ing)?\b` cannot match "returnable" — the word boundary lands mid-word. Spell it out.
      /\breturn(s|ing|ed|able)?\b/i,
      /\bexchange(s|ing)?\b/i,
      /\brefund(s|ed)?\b/i,
      // "send it back", "take my used tent back", "bring the jacket back", "mail this back" — a customer
      // returning something rarely uses the word "return". (A bare "back" is caught earlier as the RESET
      // command, so this needs one of these verbs to fire.)
      /\b(send|take|bring|ship|mail|give)\b[^.!?]{0,25}\bback\b/i,
      /\b(does|do|did)n'?t\s+fit\b/i,
      /\btoo\s+(small|big|tight|large)\b/i,
      /\bwrong\s+(size|item|colou?r)\b/i,
      /\bchanged\s+my\s+mind\b/i,
    ],
  },
  {
    intent: 'shipping_info',
    patterns: [
      /\bshipping\b/i,
      /\bdelivery\s+(time|times|options?|speed)\b/i,
      /\bhow\s+long\b[^?]*\b(ship|deliver|delivery|take|arrive)\b/i,
      /\bhow\s+long\s+(until|till|til|before)\b/i,
      /\bhow\s+much\s+time\b/i,
      /\bexpedited?\b/i,
      /\b(overnight|express)\b/i,
      /\b(standard|express|overnight|fast)\s+shipping\b/i,
      /\bwhen\s+will\s+it\s+(arrive|get\s+here|come)\b/i,
    ],
  },
  {
    intent: 'product_recommendation',
    patterns: [
      /\brecommend(ation|ations|s)?\b/i,
      /\bsuggest(ion|ions|s)?\b/i,
      /\badvice\b/i,
      // On an outdoor-gear store, someone saying "gear" is shopping. It is the single highest-signal
      // word in the whole vocabulary, and the first draft didn't match it at all.
      /\bgear\b/i,
      /\b(what|which)\b[^?]*\bshould\s+i\s+(buy|get|bring|choose|pick|use)\b/i,
      /\blooking\s+for\b/i,
      /\bshop(ping)?\s+for\b/i,
      /\bneed\s+(a|some|new)\b/i,
      // "help me pick" AND "help picking" — the customer does not conjugate to suit our regex.
      /\bhelp\s+(me\s+)?(find|finding|pick|picking|choose|choosing|select|selecting)\b/i,
      /\bbest\s+\w+\s+for\b/i,
      /\b(don'?t|dont)\s+know\s+what\s+to\s+(get|buy|bring)\b/i,
    ],
  },
  {
    intent: 'human_handoff',
    patterns: [
      /\b(live|real|human)\s+(agent|person|rep|representative)\b/i,
      /\btalk\s+to\s+(someone|a\s+human|a\s+person|an?\s+agent)\b/i,
      /\b(agent|human|representative)\b/i,
      /\bspeak\s+to\b/i,
      /\bcustomer\s+(service|support)\b/i,
      /\b(is\s+)?anyone\s+(there|available|home)\b/i,
    ],
  },
  {
    // A goodbye or a thank-you. Not a support need — but answering "sorry, I didn't understand" to
    // "thanks, that's all" is a small, avoidable rudeness that the stress test surfaced. A closed
    // conversation deserves a warm close, not the fallback.
    intent: 'closing',
    patterns: [
      /\b(thanks|thank\s*you|thx|ty|cheers|much\s+appreciated|appreciate\s+it)\b/i,
      /\bthat'?s\s+(all|it|everything|great|perfect)\b/i,
      /\b(all\s+)?(good|set|done)\s*(now|thanks|thank\s*you)?\s*[.!]?$/i,
      /\b(good)?bye\b|\bsee\s+(ya|you)\b|\bgotta\s+go\b/i,
      /\b(no|nope)[, ]+(thanks|thank\s*you|i'?m\s+good)\b/i,
      // "you've been [really / such a / so] helpful" — allow words between "been" and the compliment.
      /\byou'?ve\s+been\b[^.!?]*\b(great|helpful|amazing|wonderful|awesome|kind|fantastic|the\s+best)\b/i,
    ],
  },
];

/** Interest keywords → the closed InterestTag set used to pick a product category. */
// The `s?` on the nouns matters: "hiking boots", "sleeping bags", "tents" are how people actually type,
// and a pattern that only matched the singular ("boot", "bag", "tent") silently failed on all of them.
const INTEREST_PATTERNS: ReadonlyArray<readonly [InterestTag, RegExp]> = [
  ['shelter', /\b(tents?|shelters?|tarps?|camp(ing|site)?)\b/i],
  ['sleep', /\b(sleep(ing)?\s*bags?|sleeping|pads?|bedrolls?|quilts?)\b/i],
  ['packs', /\b(backpacks?|packs?|daypacks?|rucksacks?|bags?)\b/i],
  ['insulation', /\b(jackets?|coats?|insulat|warm|cold|layers?|fleece|puffy|puffies)\b/i],
  ['footwear', /\b(boots?|shoes?|footwear|sneakers?)\b/i],
  ['cooking', /\b(stoves?|cook|kitchen|pots?|pans?|meals?|food)\b/i],
];

/**
 * Fold "smart" curly quotes to straight ones before any pattern runs.
 *
 * Phone keyboards and word processors auto-substitute ' → ' and " → ", so a customer typing "where's my
 * order" on an iPhone sends a curly apostrophe that a `'?` in a pattern will not match. Every entry point
 * normalises first, so the rules never have to spell both forms. (The LLM path is unaffected — the model
 * reads either fine.)
 */
const SMART_QUOTES = /[‘’‛]/g;
function normalize(text: string): string {
  return text.replace(SMART_QUOTES, "'");
}

/** Order numbers: a bare 1-10 digit run, optionally prefixed with '#' or the word "order". */
function extractOrderId(text: string): string | undefined {
  const m = /(?:order\s*)?#?\s*(\d{1,10})\b/i.exec(text);
  return m?.[1];
}

/**
 * Pull a gear interest out of free text, independent of intent.
 *
 * Exported because the recommendation flow needs it mid-conversation: once we've asked "what are you
 * heading out to do?", the customer's reply ("going camping this weekend") is an *answer*, not a new
 * request — it won't classify as `product_recommendation`, so reading the interest off the intent
 * classifier would find nothing. The interest has to be read from the words themselves.
 */
export function extractInterest(text: string): InterestTag | undefined {
  const t = normalize(text);
  for (const [tag, pattern] of INTEREST_PATTERNS) {
    if (pattern.test(t)) return tag;
  }
  return undefined;
}

function extractEntities(text: string, intent: Intent): Entities {
  const entities: Entities = {};

  if (intent === 'order_tracking') {
    const id = extractOrderId(text);
    if (id) entities.orderId = id;
  }

  if (intent === 'shipping_info') {
    if (/\bexpedited?|express|fast|rush|overnight\b/i.test(text)) entities.shippingTier = 'expedited';
    else if (/\bstandard|normal|regular|basic\b/i.test(text)) entities.shippingTier = 'standard';
  }

  if (intent === 'product_recommendation') {
    const interest = extractInterest(text);
    if (interest) entities.interest = interest;
  }

  return entities;
}

/**
 * Did the customer explicitly ask for a person? Checked as an override rather than by score, because
 * a topical keyword will often co-occur with the request and would otherwise out-vote it.
 */
const EXPLICIT_HUMAN_REQUEST: RegExp[] = [
  /\b(live|real|actual|human)\s+(agent|person|rep|representative|being|someone|somebody)\b/i,
  /\b(talk|speak|chat|connect)\b[^.!?]*\b(human|person|agent|someone|somebody|anybody|representative|rep)\b/i,
  /\b(get|give|put)\s+me\s+(a|an|through\s+to)?\s*(human|person|agent|rep|someone|somebody)\b/i,
  /\bcustomer\s+(service|support)\b/i,
  /\b(real|actual|live)\s+person\b/i,
];

export function isExplicitHumanRequest(text: string): boolean {
  const t = normalize(text);
  return EXPLICIT_HUMAN_REQUEST.some((p) => p.test(t));
}

/**
 * Things a camping and hiking store plainly does not stock. A deterministic backstop so an
 * out-of-catalogue request ("do you sell canoes?") is caught reliably — even offline, and even when the
 * LLM forgets to flag it (its `catalogueFit` judgment is real but not 100% consistent). When this fires
 * and nothing reads as a gear category, the orchestrator answers in one turn instead of interrogating.
 */
const OUT_OF_CATALOGUE =
  /\b(canoe|kayak|paddle\s?board|paddleboard|raft|dinghy|surf\s?board|surfboard|bike|bicycle|scooter|skateboard|skis?|snowboard|fishing\s+(rod|pole|reel)|scuba|snorkel|firearm|gun|ammo|drone)s?\b/i;

/** True when the customer is asking for a plainly-unstocked item and no gear category is present. */
function isOutOfCatalogue(normalized: string): boolean {
  return OUT_OF_CATALOGUE.test(normalized) && !extractInterest(normalized);
}

/**
 * Score by counting matched patterns. More independent signals for an intent = more confidence.
 */
export function classifyWithRules(text: string): Classification {
  /**
   * An explicit request for a human wins outright, and it is checked FIRST — before scoring, and before
   * the no-match bail-out below.
   *
   * Both orderings matter, and getting the second one wrong was a real bug. "customer support" matches
   * the explicit list but matched no scoring rule, so the empty-score early return fired and the
   * customer asking for a person got "sorry, I didn't catch that" instead. Someone asking for a human
   * has been understood perfectly — routing that to the fallback is the worst possible reply.
   *
   * Checking it before scoring matters too: a customer who types "return this, get me a human" has a
   * topical keyword that would out-vote the request. They asked for a person. Give them a person.
   */
  if (isExplicitHumanRequest(text)) {
    return { intent: 'human_handoff', entities: {}, confidence: 0.95 };
  }

  const norm = normalize(text);

  // Out-of-catalogue backstop. Set before scoring so it's carried whatever the intent lands on; the
  // orchestrator reads `catalogueFit` ahead of the intent, so this alone drives the one-turn answer.
  const outEntities: Entities = isOutOfCatalogue(norm) ? { catalogueFit: 'out' } : {};

  const scores = new Map<Intent, number>();

  for (const rule of RULES) {
    const hits = rule.patterns.reduce((n, p) => (p.test(norm) ? n + 1 : n), 0);
    if (hits > 0) scores.set(rule.intent, hits);
  }

  // A bare gear mention ("hiking boots", "a tent") is a shopping signal even without a "recommend" verb.
  // Deliberately WEAK (score 1): any stronger intent — a return, an order lookup, a handoff — still
  // outscores it, so "return my tent" is a return, not a tent recommendation.
  if (!scores.has('product_recommendation') && extractInterest(norm)) {
    scores.set('product_recommendation', 1);
  }

  if (scores.size === 0) {
    return { intent: 'unknown', entities: outEntities, confidence: outEntities.catalogueFit ? 0.7 : 0 };
  }

  // Highest score wins. Ties fall to whichever intent is declared first in RULES — deterministic,
  // because Array.prototype.sort is stable and the Map preserves insertion order.
  const best: Intent = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const hits = scores.get(best) ?? 0;
  // 1 signal → 0.65 (just over the bar), 2 → 0.8, 3+ → 0.9. Deliberately never claims certainty.
  const confidence = Math.min(0.9, 0.5 + hits * 0.15);

  return { intent: best, entities: { ...extractEntities(text, best), ...outEntities }, confidence };
}

/** The rule matcher as an IntentProvider, so it is swappable with the LLM behind one interface. */
export const ruleProvider: IntentProvider = {
  name: 'rules',
  classify(text: string): Promise<ClassifyResult> {
    return Promise.resolve({ ok: true, value: classifyWithRules(text) });
  },
};
