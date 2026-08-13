/**
 * Product recommendation — reasoning over the WHOLE ask, not the last word.
 *
 * The observed gap: "i need pants" → "fishing" → "winter" produced "We don't carry winter-specific gear"
 * — the out-of-catalogue reply only saw the last word ("winter") and invented a reason. Fix: the
 * recommendation / out-of-catalogue compose is given the customer's full ask (their recent messages) plus
 * the real category list, so it reasons honestly ("we don't have a full winter clothing line, but our
 * Insulated Jackets & Layers works for cold trips") instead of guessing from a fragment.
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState, type ConversationState } from '@/orchestrator';
import { validateAndFill } from '@/answer/compose';
import type { Classification, ClassifyResult, ComposeResult, IntentProvider } from '@/intent/types';

describe('1. the out-of-catalogue guard allows a real category name but still voids invented specs', () => {
  it('permits naming "Insulated Jackets & Layers" (the word "insulated" is a category name, not a spec)', () => {
    const out = validateAndFill(
      'For cold-weather trips our Insulated Jackets & Layers can help.\n{{CATEGORY_LIST}}',
      'out_of_catalogue',
      {},
    );
    expect(out).not.toBeNull();
  });

  it('still voids an invented product spec (waterproof / lightweight)', () => {
    expect(validateAndFill('We have waterproof gear for that.\n{{CATEGORY_LIST}}', 'out_of_catalogue', {})).toBeNull();
    expect(validateAndFill('Our lightweight options are great.\n{{CATEGORY_LIST}}', 'out_of_catalogue', {})).toBeNull();
  });
});

describe('2. the recommendation flow hands the compose the FULL shopping ask', () => {
  /** A fake LLM: classifies the first message as a recommendation, and records every compose context. */
  function recProvider() {
    const composeCalls: Array<{ purpose: string; context: string | undefined }> = [];
    const provider: IntentProvider = {
      name: 'llm',
      classify(): Promise<ClassifyResult> {
        return Promise.resolve({
          ok: true,
          value: { intent: 'product_recommendation', entities: {}, confidence: 0.9 } as Classification,
        });
      },
      compose(purpose, _text, context): Promise<ComposeResult> {
        composeCalls.push({ purpose, context });
        const msg = purpose === 'out_of_catalogue' ? "That's outside our lineup.\n{{CATEGORY_LIST}}" : 'Got it — and what conditions?';
        return Promise.resolve({ ok: true, value: msg });
      },
    };
    return { provider, composeCalls };
  }

  it('"i need pants" / "fishing" / "winter" → the out-of-catalogue compose sees ALL three, not just "winter"', async () => {
    const { provider, composeCalls } = recProvider();
    const deps = { provider, conversational: true };
    let state: ConversationState = initialState;
    for (const msg of ['i need pants', 'fishing', 'winter']) {
      state = (await handleTurn(msg, state, deps)).state;
    }
    const ooc = composeCalls.find((c) => c.purpose === 'out_of_catalogue');
    expect(ooc).toBeTruthy();
    // The full ask is in the reasoning context — so the model can't invent "winter-specific gear".
    expect(ooc!.context).toMatch(/pants/i);
    expect(ooc!.context).toMatch(/fishing/i);
    expect(ooc!.context).toMatch(/winter/i);
    // …and the category list is in there too, so it reasons over what we DO carry.
    expect(ooc!.context).toMatch(/Insulated Jackets & Layers/);
  });
});
