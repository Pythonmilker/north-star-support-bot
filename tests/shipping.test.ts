/**
 * Shipping: always the two timeframes; a human for anything more specific.
 *
 * Shipping can't promise a delivery DATE — a static widget has no idea when an order was placed or where
 * the parcel is. So the rule is simple: give "3-5 business days" / "1-2 business days" verbatim, and for any
 * question those two lines can't answer (a specific date, a rush, a guarantee, coverage) hand off to a human
 * rather than guess. Never reason a delivery date, never promise one.
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState } from '@/orchestrator';
import type { Classification, ClassifyResult, IntentProvider } from '@/intent/types';
import { SHIPPING } from '@/data/store';

/** A fake LLM that always classifies shipping_info (so specific-shipping phrasings reach the shipping path). */
function shippingProvider(): IntentProvider {
  return {
    name: 'llm',
    classify(): Promise<ClassifyResult> {
      return Promise.resolve({
        ok: true,
        value: { intent: 'shipping_info', entities: {}, confidence: 0.95 } as Classification,
      });
    },
    // no compose → the deterministic renderer answers.
  };
}

describe('a basic shipping question gives both tiers, nothing more', () => {
  it('"how long does shipping take?" → both timeframes, no human-offer clutter (keyless)', async () => {
    const { answer } = await handleTurn('how long does shipping take?', initialState, {});
    expect(answer.text).toContain(SHIPPING.standard);
    expect(answer.text).toContain(SHIPPING.expedited);
    expect(answer.text).not.toMatch(/live agent/i);
  });
});

describe('a specific delivery question gives both tiers + a human offer, never a promise', () => {
  const deps = { provider: shippingProvider(), conversational: true };
  const specifics = [
    'will it arrive by Friday?',
    'can you rush it?',
    'do you ship internationally?',
    'when exactly will it get here?',
    'can you guarantee delivery before the weekend?',
    'i need it thursday', // bare weekday — must NOT reach compose (review finding)
    'will it be here friday',
  ];
  for (const q of specifics) {
    it(`"${q}" → both timeframes + a live-agent offer, no promise`, async () => {
      const { answer } = await handleTurn(q, { mode: 'normal' }, deps);
      expect(answer.text).toContain(SHIPPING.standard);
      expect(answer.text).toContain(SHIPPING.expedited);
      expect(answer.text).toMatch(/live agent/i);
      // never a fabricated guarantee or delivery promise
      expect(answer.text).not.toMatch(/guarantee|absolutely|we'?ll (get|have|deliver|make sure)/i);
    });
  }
});
