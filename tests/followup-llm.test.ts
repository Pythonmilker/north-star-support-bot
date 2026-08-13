/**
 * Follow-up handling on the LLM (keyed) path: conversation history + its guards.
 *
 * The classifier is given the customer's OWN recent messages so it can resolve a follow-up's
 * references. That power comes with three guards the review demanded, all tested here
 * with a scripted fake provider so the LLM path is deterministic:
 *
 *   - the classifier NEVER receives the bot's fact-bearing prose (only user turns) — a fact can't be
 *     copied into an entity from history;
 *   - an explicit "get me a human" is UPGRADED to handoff even if topical history mislabels it;
 *   - an orderId is only ever trusted from the CURRENT message, never resurrected from history.
 */

import { describe, it, expect } from 'vitest';
import {
  handleTurn,
  initialState,
  type ConversationState,
  type TurnDeps,
} from '@/orchestrator';
import type { Classification, ClassifyResult, IntentProvider } from '@/intent/types';
import { buildClassificationBody, HISTORY_MAX_TURNS } from '@/transport/protocol';
import { ORDER_STATUS, VERBATIM_STRINGS, SHIPPING } from '@/data/store';

/** A fake LLM whose classification is scripted, and which records the history it was handed. */
function fakeProvider(reply: Classification | ((text: string) => Classification)): {
  provider: IntentProvider;
  historySeen: (readonly string[] | undefined)[];
} {
  const historySeen: (readonly string[] | undefined)[] = [];
  const provider: IntentProvider = {
    name: 'llm',
    classify(text: string, history?: readonly string[]): Promise<ClassifyResult> {
      historySeen.push(history);
      const value = typeof reply === 'function' ? reply(text) : reply;
      return Promise.resolve({ ok: true, value });
    },
  };
  return { provider, historySeen };
}

describe('1. the classifier only ever sees the customer\'s own words — never a business fact', () => {
  it('history threaded into the request body contains no verified/store fact string', () => {
    // Even if a prior USER turn is present, the body is built from user text only; the bot's
    // fact-bearing replies never enter it. (Compose, the one generative surface, takes no history at all.)
    const body = buildClassificationBody('anthropic/claude-haiku-4.5', 'how do I start one?', [
      'what is your return policy?',
      'ok thanks',
    ]);
    const serialized = JSON.stringify(body);
    for (const fact of VERBATIM_STRINGS) {
      expect(serialized).not.toContain(fact);
    }
  });

  it('with no history the body is byte-identical to the single-turn request (verified path unchanged)', () => {
    const single = buildClassificationBody('anthropic/claude-haiku-4.5', 'where is my order 111');
    const emptyHist = buildClassificationBody('anthropic/claude-haiku-4.5', 'where is my order 111', []);
    expect(JSON.stringify(emptyHist)).toBe(JSON.stringify(single));
    // …and the user message is exactly the customer's text, nothing prepended.
    const userMsg = (single['messages'] as Array<{ role: string; content: string }>)[1]!;
    expect(userMsg.content).toBe('where is my order 111');
  });

  it('the classifier is actually handed the prior user turns (oldest→newest), capped', async () => {
    const { provider, historySeen } = fakeProvider({ intent: 'unknown', entities: {}, confidence: 0.9 });
    const deps: TurnDeps = { provider };
    let state: ConversationState = initialState;
    for (const input of ['one', 'two', 'three', 'four']) {
      state = (await handleTurn(input, state, deps)).state;
    }
    // The 4th classify call saw the previous three messages, capped to HISTORY_MAX_TURNS, newest last.
    const lastHistory = historySeen[historySeen.length - 1]!;
    expect(lastHistory.length).toBeLessThanOrEqual(HISTORY_MAX_TURNS);
    expect(lastHistory[lastHistory.length - 1]).toBe('three');
  });
});

describe('2. explicit handoff is upgraded even when history mislabels it', () => {
  it('a model that returns order_tracking for an explicit human request still reaches Live Agent', async () => {
    // Simulates topical history biasing the model toward order_tracking on "…talk to someone…".
    const { provider } = fakeProvider({
      intent: 'order_tracking',
      entities: { orderId: '111' },
      confidence: 0.95,
    });
    const state: ConversationState = { mode: 'normal', lastOrderId: '111' };
    const turn = await handleTurn('can I just talk to someone about this order', state, { provider });
    expect(turn.state.mode).toBe('live_agent');
    expect(turn.answer.handoff).toBe(true);
    // It must NOT have answered with the order status.
    expect(turn.answer.text).not.toContain(ORDER_STATUS['111']);
  });
});

describe('3. an orderId is trusted only from the current message, never resurrected from history', () => {
  it('"when will it arrive?" after #111 then #222 answers about #222, not the model\'s history-lifted #111', async () => {
    // The model (with history) hands back orderId "111", which is NOT in the current message. It must be
    // ignored, and the most-recent real order (#222) used instead.
    const { provider } = fakeProvider({
      intent: 'order_tracking',
      entities: { orderId: '111' },
      confidence: 0.95,
    });
    const state: ConversationState = { mode: 'normal', lastOrderId: '222' };
    const turn = await handleTurn('when will it arrive?', state, { provider });
    expect(turn.answer.text).toContain(ORDER_STATUS['222']);
    expect(turn.answer.text).not.toContain(ORDER_STATUS['111']);
  });

  it('an orderId the customer DID type in the current message is still honoured', async () => {
    const { provider } = fakeProvider({
      intent: 'order_tracking',
      entities: { orderId: '333' },
      confidence: 0.95,
    });
    const turn = await handleTurn('what about order 333', initialState, { provider });
    expect(turn.answer.text).toContain(ORDER_STATUS['333']);
  });
});

describe('4. a shipping comparison shows BOTH tiers, never just one', () => {
  it('"which one is faster?" answers with both tiers even if the model tagged a single one', async () => {
    // The model mis-tags "which is faster?" as the standard tier; a comparison must show both so the
    // customer can see 3-5 vs 1-2 (the compose guard forbids the bot from editorialising which is faster).
    const { provider } = fakeProvider({
      intent: 'shipping_info',
      entities: { shippingTier: 'standard' },
      confidence: 0.9,
    });
    const turn = await handleTurn('which one is faster?', initialState, { provider });
    expect(turn.answer.text).toContain(SHIPPING.standard);
    expect(turn.answer.text).toContain(SHIPPING.expedited);
  });
});
