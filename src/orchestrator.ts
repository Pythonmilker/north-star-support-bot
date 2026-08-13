/**
 * The conversation engine: classify → (fall back if needed) → render.
 *
 * Two jobs:
 *
 * 1. THE FALLBACK CHAIN. The LLM is tried first; on ANY typed failure — no key, rate limited,
 *    offline, timeout, malformed reply — we drop to the deterministic rule matcher. The bot always
 *    answers. It never shows an error, never goes silent, never strands the customer. This is what
 *    makes shipping a disposable client-side key survivable: when that key dies mid-evaluation, the
 *    widget degrades from "smart" to "keyword-matched", not from "working" to "broken".
 *
 * 2. THE STATE MACHINE. Multi-turn flows the brief requires: asking for an order number, asking 1-2
 *    clarifying questions before recommending, and the Live Agent state — which must always leave a
 *    route back to the main flow.
 */

import {
  classifyWithRules,
  extractInterest,
  isExplicitHumanRequest,
  ruleProvider,
} from '@/intent/rules';
import {
  render,
  renderOrderTracking,
  renderHandoff,
  renderNoCategoryMatch,
  renderReturnsEligibility,
  renderShippingEligibility,
  type Answer,
  type RenderOptions,
} from '@/answer/render';
import { composeOrRender } from '@/answer/compose';
import { HISTORY_MAX_TURNS, HISTORY_TURN_CHARS } from '@/transport/protocol';
import { store } from '@/data/store';
import type { OrderProvider } from '@/orders';
import { PERSONA } from '@/persona';
import {
  CONFIDENCE_THRESHOLD,
  type ComposePurpose,
  type Entities,
  type Intent,
  type IntentProvider,
  type InterestTag,
} from '@/intent/types';

export type Mode =
  | 'normal'
  | 'awaiting_order'
  | 'awaiting_activity'
  | 'awaiting_conditions'
  | 'live_agent';

export interface ConversationState {
  mode: Mode;
  /** Interest captured during the recommendation flow, carried across the clarifying questions. */
  pendingInterest?: InterestTag | undefined;
  /** Consecutive unrecognised inputs. Drives the fallback escalation below. */
  fallbackStreak?: number | undefined;
  /**
   * ── Sticky memory (persists across turns; cleared by "menu"/reset) ──
   * Set only when a turn UPDATES them; the handleTurn wrapper carries them forward otherwise. So the
   * inner logic doesn't have to thread them through every return path.
   */
  /** The last order number the customer successfully checked — so "my order?" needn't re-ask for it. */
  lastOrderId?: string | undefined;
  /** An interest we've already recommended this session — so we don't re-interrogate on a repeat ask. */
  recommendedInterest?: InterestTag | undefined;
  /**
   * The topic of the IMMEDIATELY preceding answered turn, when it was one we can safely re-answer
   * (returns or shipping — a static, verbatim, idempotent reply). Drives the follow-up topic-carry:
   * a short anaphoric miss right after one of these ("how do I start one?") continues that topic
   * instead of falling to "I didn't catch that". Set only by those two render paths and the carry
   * itself; every other turn leaves it unset, so it never survives a change of subject.
   */
  lastTopic?: 'returns_exchanges' | 'shipping_info' | undefined;
  /**
   * The customer's OWN recent messages (oldest→newest, capped), threaded to the LLM classifier so it can
   * resolve a follow-up's references. Bot replies are never stored here — the classifier must not see a
   * business fact. Appended by the handleTurn wrapper and dropped on reset. Ignored by the keyless floor.
   */
  recentTurns?: readonly string[] | undefined;
}

export const initialState: ConversationState = { mode: 'normal' };

/** The sticky fields that survive from turn to turn unless a turn explicitly changes them. */
type Memory = Pick<ConversationState, 'lastOrderId' | 'recommendedInterest'>;

/**
 * How many unrecognised inputs in a row before we hand the customer to a live agent.
 *
 * The brief pulls in two directions. Fallback handling must "offer options or escalation", which argues for
 * showing the menu. But the handoff section says that when a user "reaches a fallback scenario" the bot MUST
 * transition to the Live Agent state. Escalating on the very first confused message satisfies the letter of
 * the second clause and ignores the first, and it is a poor experience besides: one typo should not eject
 * someone into a queue.
 *
 * So: the first miss offers options, and a second miss in a row escalates. Both clauses hold, and a customer
 * who is genuinely stuck reaches a human without having to know the magic word.
 */
const FALLBACK_ESCALATION_THRESHOLD = 2;

export interface Turn {
  answer: Answer;
  state: ConversationState;
  /** Which provider actually decided the intent — surfaced in the UI so degradation is visible, not silent. */
  via: 'llm' | 'rules';
}

/** "menu" / "back" / "start over" always escapes whatever flow we're in — including Live Agent. */
const RESET = /^\s*(menu|main menu|back|start over|restart|home)\s*[.!]?\s*$/i;

/**
 * Pull an order number out of a reply to "what's your order number?".
 *
 * The reply has to be MARKED as an order number, not merely contain a digit. Taking the first number
 * anywhere told a customer who answered "I bought it about 2 weeks ago" that order #2 did not exist. A
 * false hit lands on the invalid-order branch, so it is a confidently wrong answer rather than a near miss.
 *
 * Three ways to be marked, most confident first: an explicit `#`; the word "order" (which `\b` keeps from
 * matching "ordered"); or a short reply — we just asked for the number, so a brief answer carrying one is
 * the answer. A longer sentence with a stray number falls through and re-classifies instead.
 */
function digitsIn(text: string): string | undefined {
  const t = text.trim();
  const hashed = /#\s*(\d{1,10})\b/.exec(t);
  if (hashed) return hashed[1];
  if (/\border\b/i.test(t)) return /\b(\d{1,10})\b/.exec(t)?.[1];
  return t.split(/\s+/).filter(Boolean).length <= 4 ? /\b(\d{1,10})\b/.exec(t)?.[1] : undefined;
}

/**
 * Intents that are never a plausible ANSWER to "what are you heading out to do?".
 *
 * Deliberately excludes `product_recommendation` and `unknown`, and that exclusion is the whole trick.
 * "I need a jacket for the trip" classifies as product_recommendation — but mid-flow it is an answer to
 * our question, not a fresh request, and treating it as fresh would ask the same question again forever.
 * "cold and wet" classifies as unknown, and it is likewise an answer, not a failure to understand.
 *
 * What's left is the set of things nobody says in reply to "what are you heading out to do?".
 */
const NEVER_AN_ANSWER: ReadonlySet<Intent> = new Set([
  'order_tracking',
  'returns_exchanges',
  'shipping_info',
  'human_handoff',
]);

/**
 * Did the customer abandon the clarifying question we asked, and say something else entirely?
 *
 * Without this, the recommendation flow is a trap. `awaiting_activity` and `awaiting_conditions` used to
 * consume ANY input as the answer to the question they'd just asked — so a customer who typed "actually,
 * get me a live agent" halfway through picking a tent was answered with "and what conditions are you
 * expecting out there?". The brief makes an explicit request for a person one of the two handoff
 * triggers, and it was being silently swallowed. Same for "where's my order #111".
 *
 * Note `awaiting_order` never had this bug — it already re-classifies anything that isn't a number.
 */
function changedTheSubject(text: string): boolean {
  if (isExplicitHumanRequest(text)) return true;
  const c = classifyWithRules(text);
  return c.confidence >= CONFIDENCE_THRESHOLD && NEVER_AN_ANSWER.has(c.intent);
}

/**
 * Does this message look like a FOLLOW-UP to the previous answer rather than a fresh request?
 *
 * Deliberately conjunctive and conservative: SHORT and (anaphoric OR elliptical). This gates the
 * topic-carry below, and the conservatism is load-bearing — the carry can only ever REVISIT the last
 * topic, never route a genuinely new (or garbage) message. So:
 *   - "how do I start one?"        short + "one"        → follow-up   (carries the returns topic)
 *   - "is there a form to fill out" short + "a form"     → follow-up
 *   - "do you have a store in Denver" no anaphor/ellipsis → NOT a follow-up → still falls back, and a
 *      second miss still escalates to a human (the required fallback→handoff trigger stays intact).
 * A short bare anaphor continues the topic; a fresh content noun does not.
 */
const FOLLOW_UP_ANAPHOR =
  /\b(it|that|this|one|ones|these|those|them|they|(a|an|the|any|another)\s+(form|link|page|policy|process|option|label|slip|refund|exchange))\b/i;
const FOLLOW_UP_ELLIPSIS = /^\s*(and|or|but|what about|how about|what if|then)\b/i;
function isFollowUpShape(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 7) return false;
  return FOLLOW_UP_ANAPHOR.test(text) || FOLLOW_UP_ELLIPSIS.test(text);
}

/**
 * Ask the LLM, fall back to rules on any failure. The provider interface means the caller never
 * learns which one answered — except via `via`, which we surface deliberately.
 */
async function classify(
  text: string,
  provider: IntentProvider | undefined,
  history?: readonly string[],
): Promise<{ intent: Intent; entities: Entities; via: 'llm' | 'rules' }> {
  if (provider) {
    const result = await provider.classify(text, history);
    if (result.ok && result.value.confidence >= CONFIDENCE_THRESHOLD) {
      let intent = result.value.intent;
      const entities = result.value.entities;
      // Handoff is spec'd to fire on an EXPLICIT request, and only that.
      if (isExplicitHumanRequest(text)) {
        // UPGRADE (mirrors the keyword path): an explicit "get me a human" always wins — even if topical
        // history led the model to label it order_tracking/returns/etc. isExplicitHumanRequest reads only
        // the CURRENT message, so the history window can never swallow this verified trigger.
        intent = 'human_handoff';
      } else if (intent === 'human_handoff') {
        // DOWNGRADE: the model sometimes infers handoff from pure frustration ("im enraged", "you're
        // useless") and does so inconsistently. Without an explicit request, route through the fallback
        // path (offer help + a live agent, escalate after two misses) so the trigger stays predictable.
        intent = 'unknown';
      }
      // Never trust an orderId the model lifted from HISTORY — only one the customer typed in the CURRENT
      // message. Otherwise "when will it arrive?" after checking #111 then #222 could resurrect #111 from
      // the transcript and answer about the wrong order. A bare follow-up falls to state.lastOrderId.
      if (entities.orderId && !text.includes(entities.orderId)) delete entities.orderId;
      return { intent, entities, via: provider.name };
    }
    // Either it failed, or it wasn't confident enough. Both mean: let the rules have a go. A
    // low-confidence LLM guess is exactly the "confident wrong answer" we refuse to ship.
  }

  const fallback = await ruleProvider.classify(text);
  const c = fallback.ok ? fallback.value : classifyWithRules(text);
  const intent: Intent = c.confidence >= CONFIDENCE_THRESHOLD ? c.intent : 'unknown';
  return { intent, entities: c.entities, via: 'rules' };
}

/**
 * Handle one customer turn.
 *
 * `provider` is the LLM classifier when a key is configured, and `undefined` otherwise — in which
 * case the whole thing runs on rules alone and still satisfies every verified criterion.
 */
/** Everything the orchestrator needs from the host page. */
export interface TurnDeps {
  /** LLM intent classifier. Absent means run on the keyword matcher, which answers everything. */
  provider?: IntentProvider | undefined;
  /** Where order numbers are looked up. Absent means the bundled mock data. */
  orders?: OrderProvider | undefined;
  /** Values the renderer prints (returns URL, and a resolved order status). */
  render?: RenderOptions | undefined;
  /** Opt in to generated, human-feeling replies (facts still spliced verbatim). Off → deterministic. */
  conversational?: boolean | undefined;
}

/**
 * Wrap a deterministic answer with a generated one WHEN conversational mode is on and an LLM is present.
 * Always fails safe to `base`: composeOrRender returns exactly `base` on any failure or validation reject,
 * so this can never do worse than the deterministic reply — it only ever makes the words warmer.
 *
 * Order tracking is deliberately absent from every call site: its status line is the most accuracy-critical
 * copy and its warm lead is status-class-specific, so it stays 100% deterministic.
 */
/**
 * Is the customer asking whether the policy covers THEIR specific situation, or describing a circumstance
 * that might fail a condition? ("I lost my packaging", "will you honor it without the box?", "it's been 45
 * days", "the item's used".)
 *
 * This is the trap the generative layer walks into: it can't read the policy (that lives in a slot), so
 * asked "so you'll honor it?" it reassures — "Absolutely, we've got you covered!" — directly above a policy
 * line that says "Original packaging required". A cheerful false promise about a verified policy. When a turn
 * looks like this, we DON'T generate: the deterministic renderer presents the policy plainly and lets it
 * answer, so the bot states the real conditions and never promises an outcome it can't stand behind.
 */
const ELIGIBILITY_PROBE =
  /\b(honou?red?|honou?ring|exceptions?|waive[ds]?|refund me|money back|even (if|without|though|when)|without (the|my|a|an|any|its|it|original|packaging|box|tags?|receipt)|no (packaging|box|receipt|tags?)|lost|missing|misplaced|don'?t have|do not have|no longer have|threw (it|them|that) (out|away)|damaged?|broke|broken|\bused\b|worn|opened|past|expired|late|overdue|receipts?|will you|would you|do you still|can i still|could i still|so you'?ll|so you will|so i can|is (that|this) (ok|okay|fine|allowed|cool)|does (that|this) (count|work|qualify|apply))\b/i;

/** The shipping purposes. */
const SHIPPING_PURPOSES: ReadonlySet<ComposePurpose> = new Set([
  'shipping_standard',
  'shipping_expedited',
  'shipping_both',
]);

/**
 * A shipping question the two timeframes can't answer on their own — a specific delivery date, a rush, a
 * guarantee, weekend/holiday/international coverage. We deliberately do NOT reason or promise here: a static
 * widget doesn't know when an order was placed or where the parcel is, so guessing a date is exactly the
 * over-promise to avoid. Give the two timeframes and hand off to a human instead.
 */
const SHIPPING_HUMAN =
  /\b((mon|tues|wednes|thurs|fri|satur|sun)day|today|tonight|tomorrow|in\s+time|arrive\s+(by|before|in)|get\s+(it|here|to\s+me|there)\s+(by|before|in)|before\s+(my|the|next|christmas|\w+day)|\brush(ed)?\b|overnight|guarantee\w*|specific\s+(date|day|time)|exact\w*\s+(day|date|time|when)|what\s+day|which\s+day|when\s+exactly|deliver\s+(on|by)|weekends?|holidays?|internationa\w*|christmas|new\s*year|ship\s+(it\s+)?to\s+\w+)\b/i;

async function withVoice(
  purpose: ComposePurpose,
  base: Answer,
  deps: TurnDeps,
  text: string,
  interest: InterestTag | undefined,
  returnsUrl: string | undefined,
  askContext?: string,
): Promise<Answer> {
  // SHIPPING never reasons or promises a delivery date. For a specific-delivery / rush / guarantee / coverage
  // question, give the two timeframes and hand off to a human; a basic "how long does shipping take?" gets
  // the normal warm tiers. Deterministic on both the keyed and keyless paths.
  if (SHIPPING_PURPOSES.has(purpose) && (SHIPPING_HUMAN.test(text) || ELIGIBILITY_PROBE.test(text))) {
    return renderShippingEligibility({ seed: text });
  }

  // RETURNS reasons over the policy it's given (see composeOrRender). Its eligibility probe falls back to the
  // acknowledge-and-offer render — also the safe landing if a reasoned reply is rejected, or there's no LLM.
  const returnsProbe = purpose === 'returns' && ELIGIBILITY_PROBE.test(text);
  const fallback = returnsProbe ? renderReturnsEligibility({ returnsUrl }) : base;

  if (!deps.conversational || !deps.provider) return fallback;

  return composeOrRender(purpose, fallback, deps.provider, text, { interest, returnsUrl }, askContext);
}

/**
 * A one-line summary of what the customer is shopping for, drawn from their own recent messages, so the
 * recommendation / out-of-catalogue compose reasons over the WHOLE ask ("pants … fishing … winter") rather
 * than the last word alone. That single-word view is what made it invent "we don't carry winter-specific
 * gear" for a customer who'd asked for pants.
 */
function shoppingContext(recentTurns: readonly string[] | undefined, current: string): string {
  const said = [...(recentTurns ?? []), current].map((s) => s.trim()).filter(Boolean).slice(-3);
  return `The customer is shopping. In their own words across this chat, they've said: ${said.join(' / ')}.`;
}

/** Which compose purpose (if any) a general-render intent maps to. Returns / shipping / closing. */
function generalPurpose(intent: Intent, entities: Entities): ComposePurpose | null {
  if (intent === 'returns_exchanges') return 'returns';
  if (intent === 'closing') return 'closing';
  if (intent === 'shipping_info') {
    return entities.shippingTier === 'standard'
      ? 'shipping_standard'
      : entities.shippingTier === 'expedited'
        ? 'shipping_expedited'
        : 'shipping_both';
  }
  return null;
}

/**
 * Resolve an order number through whichever provider is configured, then render it.
 *
 * The failure case is the interesting one. If a real order API is down we do NOT quietly answer from
 * bundled data, because that would state a stranger's order status from a fixture. We say we cannot
 * check and hand over to a human, which is the honest answer and the one a shop would want.
 */
async function answerOrder(
  orderId: string,
  deps: TurnDeps,
): Promise<{ answer: Answer; mode: Mode; foundOrderId?: string | undefined }> {
  if (!deps.orders) {
    // No provider configured: the renderer reads the bundled orders itself. Remember the number only if
    // it's a real order, so "my order?" later re-uses a valid one, never a typo.
    const found = store().orders[orderId] != null;
    return {
      answer: renderOrderTracking(orderId, deps.render ?? {}),
      mode: 'normal',
      foundOrderId: found ? orderId : undefined,
    };
  }

  const result = await deps.orders.lookup(orderId);
  if (!result.ok) {
    const handoff = renderHandoff();
    return {
      answer: { ...handoff, text: [PERSONA.orderLookupFailed, handoff.text].join('\n') },
      mode: 'live_agent',
    };
  }

  return {
    answer: renderOrderTracking(orderId, { ...(deps.render ?? {}), orderStatus: result.status }),
    mode: 'normal',
    foundOrderId: result.status != null ? orderId : undefined,
  };
}

/**
 * Handle one turn, then persist sticky memory. The inner function sets `lastOrderId` /
 * `recommendedInterest` only when it wants to CHANGE them; this wrapper carries the previous values
 * forward for any it left unset — except after a reset ("menu"), which starts fresh with a clean slate.
 * That keeps the inner logic from having to re-thread memory through its dozen return paths.
 */
export async function handleTurn(
  input: string,
  state: ConversationState,
  deps: TurnDeps = {},
): Promise<Turn> {
  const turn = await handleTurnInner(input, state, deps);
  if (RESET.test(input.trim())) return turn; // reset returns a clean state — no memory OR history carried

  const carried: Memory = {
    lastOrderId: turn.state.lastOrderId ?? state.lastOrderId,
    recommendedInterest: turn.state.recommendedInterest ?? state.recommendedInterest,
  };
  // Thread the customer's OWN message into the rolling history for the NEXT turn's classifier — capped,
  // and never the bot's reply (which would put a business fact where the model could copy it).
  const recentTurns = [...(state.recentTurns ?? []), input.trim().slice(0, HISTORY_TURN_CHARS)].slice(
    -HISTORY_MAX_TURNS,
  );
  return { ...turn, state: { ...turn.state, ...carried, recentTurns } };
}

async function handleTurnInner(
  input: string,
  state: ConversationState,
  deps: TurnDeps = {},
): Promise<Turn> {
  const provider = deps.provider;
  const text = input.trim();
  // Seed the fact-free variant pools with the customer's input, so different messages get different
  // warm phrasings while the same message stays reproducible (which keeps the pools testable).
  const opts: RenderOptions = { ...(deps.render ?? {}), seed: text };
  // The mode we ENTERED this turn in. The topic-carry only fires from a settled conversation
  // (normal / live_agent), never as a break-out from an awaiting_* flow (where an unrecognised input
  // is the customer abandoning the question we asked, not a follow-up to a returns/shipping answer).
  const enteringMode = state.mode;

  // The universal escape hatch. Works from inside Live Agent, which is what stops the handoff being
  // a dead end — a requirement the brief states twice.
  if (RESET.test(text)) {
    return {
      answer: { text: PERSONA.greeting, showMenu: true },
      state: { mode: 'normal' },
      via: 'rules',
    };
  }

  switch (state.mode) {
    case 'awaiting_order': {
      const orderId = digitsIn(text);
      if (orderId) {
        const { answer, mode, foundOrderId } = await answerOrder(orderId, deps);
        return { answer, state: { mode, lastOrderId: foundOrderId }, via: 'rules' };
      }
      // They said something else entirely — don't trap them in the flow, just re-classify.
      break;
    }

    case 'awaiting_activity': {
      // The reply ("going camping this weekend") is an ANSWER, not a new request — it won't classify
      // as product_recommendation, so the interest is read straight from the words.
      //
      // Unless it isn't an answer at all. See changedTheSubject(): a customer who says "actually, get
      // me a human" in the middle of this must not be told "and what conditions are you expecting?".
      if (changedTheSubject(text)) break;

      return {
        answer: await withVoice(
          'clarify_conditions',
          { text: PERSONA.recommendFollowUp, awaiting: 'recommend_conditions' },
          deps,
          text,
          undefined,
          opts.returnsUrl,
        ),
        state: { mode: 'awaiting_conditions', pendingInterest: extractInterest(text) },
        via: 'rules',
      };
    }

    case 'awaiting_conditions': {
      if (changedTheSubject(text)) break;

      // Second clarifying question answered. The activity sets the category; conditions only decide it
      // if the activity told us nothing ("cold and wet" on its own points at insulation).
      const interest = state.pendingInterest ?? extractInterest(text);
      if (interest) {
        const base = render('product_recommendation', { interest }, opts);
        return {
          answer: await withVoice('recommendation', base, deps, text, interest, opts.returnsUrl, shoppingContext(state.recentTurns, text)),
          // Remember what we recommended, so a later "what about footwear?" doesn't restart the questions.
          state: { mode: 'normal', recommendedInterest: interest },
          via: 'rules',
        };
      }
      // Two questions and still no signal — the customer wants something outside our catalogue (a canoe,
      // say). Don't invent a category, and don't pretend we didn't understand: name what we DO carry and
      // offer a human. Honest and useful beats a generic "I didn't catch that".
      return {
        answer: await withVoice(
          'out_of_catalogue',
          renderNoCategoryMatch(opts),
          deps,
          text,
          undefined,
          opts.returnsUrl,
          shoppingContext(state.recentTurns, text),
        ),
        state: { mode: 'normal' },
        via: 'rules',
      };
    }

    case 'live_agent':
    case 'normal':
      break;
  }

  const { intent, entities, via } = await classify(text, provider, state.recentTurns);

  // The canoe fix. A customer shopping for something we don't stock (a canoe, a kayak) should be told so
  // NOW and pointed at what we DO carry — not marched through two clarifying questions to a dead end.
  //
  // Checked BEFORE the unknown/fallback branch on purpose: the model tends to label a clearly-unsellable
  // request as intent=unknown while still setting catalogueFit=out, so keying this on the intent would
  // miss it. `catalogueFit` is only ever set by the LLM (the keyword matcher has no world knowledge), so
  // offline this never fires and the flow behaves exactly as before.
  if (entities.catalogueFit === 'out' && !entities.interest) {
    const base = renderNoCategoryMatch(opts);
    return {
      answer: await withVoice(
        'out_of_catalogue',
        base,
        deps,
        text,
        undefined,
        opts.returnsUrl,
        shoppingContext(state.recentTurns, text),
      ),
      state: { mode: 'normal' },
      via,
    };
  }

  // The fallback trigger for handoff. The brief lists TWO ways into the Live Agent state: an explicit
  // request, and "reaching a fallback scenario". The explicit request is handled by the classifier. This is
  // the other one, and it is the easy half to miss.
  if (intent === 'unknown') {
    // TOPIC-CARRY. A short, anaphoric miss right after a returns/shipping answer ("how do I start
    // one?", "is there a form?") is almost always a continuation of that topic, not a new request the
    // bot failed to parse. Re-answer in that topic — the reply is static, verbatim and idempotent, so
    // this can never state a wrong fact — instead of the generic fallback. Fires on ANY `unknown`,
    // whether the LLM or the keyword matcher produced it, so it fixes the follow-up on both paths.
    // Returning WITHOUT fallbackStreak resets the streak, so a genuine continuation never marches the
    // customer toward the fallback→live-agent escalation. Gated on entry mode + the follow-up shape so
    // a genuinely new or garbage message still falls back and, if repeated, still escalates to a human.
    // NB `lastTopic` is only ever written on a turn that also settles into `normal`, and it is not part of
    // the sticky Memory — so in practice this only fires from `normal`. The mode guard stays as the explicit
    // statement of intent: a carry must never break out of an `awaiting_*` flow, where an unrecognised input
    // means the customer abandoned the question we asked.
    if (enteringMode === 'normal' && state.lastTopic && isFollowUpShape(text)) {
      const carryBase = render(state.lastTopic, {}, opts);
      const carryPurpose = generalPurpose(state.lastTopic, {});
      const carryAnswer = carryPurpose
        ? await withVoice(carryPurpose, carryBase, deps, text, undefined, opts.returnsUrl)
        : carryBase;
      return { answer: carryAnswer, state: { mode: 'normal', lastTopic: state.lastTopic }, via };
    }

    const streak = (state.fallbackStreak ?? 0) + 1;
    if (streak >= FALLBACK_ESCALATION_THRESHOLD) {
      const handoff = render('human_handoff', {}, opts);
      return {
        answer: { ...handoff, text: `${PERSONA.escalatingAfterFallback}\n${handoff.text}` },
        state: { mode: 'live_agent' },
        via,
      };
    }
    return {
      answer: await withVoice('fallback', render('unknown', {}, opts), deps, text, undefined, opts.returnsUrl),
      state: { mode: 'normal', fallbackStreak: streak },
      via,
    };
  }

  if (intent === 'order_tracking') {
    // Use the number they gave, or fall back to the one they already checked — so "where's my order?"
    // after "order 111" answers about #111 instead of asking for the number again ("i just told you!").
    const orderId = entities.orderId ?? state.lastOrderId;
    if (orderId) {
      const { answer, mode, foundOrderId } = await answerOrder(orderId, deps);
      return { answer, state: { mode, lastOrderId: foundOrderId ?? state.lastOrderId }, via };
    }
    // No number and none remembered — ask for it (falls through to the general render below).
  }

  /**
   * The brief is explicit about the order of operations here: "1. Ask 1-2 clarifying questions.
   * 2. Recommend product category." Ask FIRST, then recommend.
   *
   * The bug this replaces: when the customer named the category themselves ("can you recommend a
   * tent"), the classifier extracted interest=shelter and the renderer went straight to
   * "I'd point you at our Tents & Shelters" — a recommendation with ZERO clarifying questions, which
   * is the one thing this use case is verified on. Knowing the answer is not a licence to skip the
   * question.
   *
   * So a recommendation always costs at least one question, and at most two — which is exactly the
   * range the brief allows:
   *   they named a category  -> one question (conditions), then recommend
   *   they named nothing     -> two questions (activity, then conditions), then recommend
   */
  if (intent === 'product_recommendation') {
    // If we've already walked someone through the clarifying questions once this session, a repeat ask
    // goes STRAIGHT to a recommendation — no re-interrogation ("you already asked that a lot"). The
    // brief's "ask 1-2 clarifying questions before recommending" is satisfied by that first pass; asking
    // again on every follow-up is the un-human thing. Use the newly named category, or the last one.
    if (state.recommendedInterest) {
      const interest = entities.interest ?? state.recommendedInterest;
      const base = render('product_recommendation', { interest }, opts);
      return {
        answer: await withVoice('recommendation', base, deps, text, interest, opts.returnsUrl, shoppingContext(state.recentTurns, text)),
        state: { mode: 'normal', recommendedInterest: interest },
        via,
      };
    }
    if (entities.interest) {
      return {
        answer: await withVoice(
          'clarify_conditions',
          { text: PERSONA.recommendFollowUp, awaiting: 'recommend_conditions' },
          deps,
          text,
          undefined,
          opts.returnsUrl,
        ),
        state: { mode: 'awaiting_conditions', pendingInterest: entities.interest },
        via,
      };
    }
    return {
      answer: await withVoice(
        'clarify_activity',
        { text: PERSONA.recommendOpener, awaiting: 'recommend_activity' },
        deps,
        text,
        undefined,
        opts.returnsUrl,
      ),
      state: { mode: 'awaiting_activity' },
      via,
    };
  }

  // A shipping COMPARISON ("which is faster?", "what's the difference?") isn't about one tier — show
  // both, so the customer can see 3-5 vs 1-2 and decide for themselves. Without this, a follow-up that
  // the model tags with a single tier answers "which is faster?" with only one line (often the slower
  // one), and the compose guard rightly forbids the bot from editorialising the comparison in prose.
  if (
    intent === 'shipping_info' &&
    entities.shippingTier &&
    /\b(faster|slower|quicker|which|compare|comparison|difference|diff|versus|vs|better|best|options?)\b/i.test(text)
  ) {
    delete entities.shippingTier;
  }

  const base = render(intent, entities, opts);
  // Returns and shipping get a generated voice (facts spliced verbatim); everything else — handoff,
  // closing, fallback, and the order/askOrderNumber replies — stays deterministic.
  const purpose = generalPurpose(intent, entities);
  const answer = purpose
    ? await withVoice(purpose, base, deps, text, entities.interest, opts.returnsUrl)
    : base;

  // Work out where the conversation sits after this reply. Any understood turn clears the streak.
  // NB: read the flags off `base`, not `answer` — compose only rewrites text, never a flag, but basing
  // the state transition on the deterministic answer keeps the state machine provably compose-independent.
  let mode: Mode = 'normal';
  if (base.handoff) mode = 'live_agent';
  else if (base.awaiting === 'order_number') mode = 'awaiting_order';
  else if (base.awaiting === 'recommend_activity') mode = 'awaiting_activity';

  // No pendingInterest here: it is read only by `awaiting_conditions`, which is entered from the two
  // clarify-question branches above, and both set it themselves. Writing it on this path stored a value
  // nothing could ever read (it isn't part of the sticky Memory either, so it never survives the turn).
  const next: ConversationState = { mode };
  // Remember returns/shipping as the carryable topic for the NEXT turn's follow-up detector. Only these
  // two: their reply is static and verbatim, so re-answering a follow-up is always safe. Deliberately
  // not carried through the sticky Memory wrapper — leaving it unset on every other turn is what makes
  // it reflect only the immediately preceding turn, so a change of subject drops it automatically.
  if (intent === 'returns_exchanges' || intent === 'shipping_info') next.lastTopic = intent;

  return { answer, state: next, via };
}

/** The opening turn. Rendered locally — it costs no API call and works with no key. */
export function greeting(): Answer {
  return { text: PERSONA.greeting, showMenu: true };
}
