/**
 * Returns REASONING — the agent understands the question AND the policy data.
 *
 * The model is handed the actual return-policy conditions, so it can answer the customer's real question
 * ("will you honor a return with no packaging?") honestly instead of reassuring blindly. The safety is no
 * longer "the model never sees a fact"; it's "the model reasons over the facts, and the validator refuses a
 * reply that PROMISES an outcome, CONTRADICTS a condition, or invents a number." The exact policy is always
 * shown verbatim via the slot, and a rejected reply falls back to the acknowledge-and-offer render.
 *
 * (This replaced the earlier bug where a blind model answered "Absolutely! We've got you covered" above
 * "Original packaging required" — a false promise. Giving the model the policy is what fixed it.)
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState } from '@/orchestrator';
import { validateAndFill } from '@/answer/compose';
import { RETURN_POLICY } from '@/data/store';
import type {
  Classification,
  ClassifyResult,
  ComposeResult,
  IntentProvider,
} from '@/intent/types';

/** A fake LLM that classifies returns and composes whatever `reply` is (a {{RETURN_POLICY}} is appended). */
function returnsProvider(reply: string): IntentProvider {
  return {
    name: 'llm',
    classify(): Promise<ClassifyResult> {
      return Promise.resolve({
        ok: true,
        value: { intent: 'returns_exchanges', entities: {}, confidence: 0.95 } as Classification,
      });
    },
    compose(): Promise<ComposeResult> {
      return Promise.resolve({ ok: true, value: `${reply} {{RETURN_POLICY}}` });
    },
  };
}

describe('1. the validator voids a promise or a contradiction, in isolation', () => {
  it('voids an outcome-promise', () => {
    expect(validateAndFill("Absolutely, we'll honor that!\n{{RETURN_POLICY}}", 'returns', {})).toBeNull();
    expect(validateAndFill('No worries — we can make an exception.\n{{RETURN_POLICY}}', 'returns', {})).toBeNull();
    expect(validateAndFill("Rest assured, you're all set.\n{{RETURN_POLICY}}", 'returns', {})).toBeNull();
  });

  it('voids a negated condition', () => {
    expect(validateAndFill("The packaging isn't required.\n{{RETURN_POLICY}}", 'returns', {})).toBeNull();
    expect(validateAndFill('No need for the original box.\n{{RETURN_POLICY}}', 'returns', {})).toBeNull();
  });

  it('voids the review\'s false affirmations and soft contradictions (returns)', () => {
    // These leaked past the first-cut guards in the acceptance review; each is now caught.
    for (const bad of [
      "Yes, that qualifies — you're all set to send it back!\n{{RETURN_POLICY}}",
      "Don't worry about the packaging on this one, we've got it.\n{{RETURN_POLICY}}",
      'Returning a used item is totally fine here.\n{{RETURN_POLICY}}',
      "Send it on back and we'll sort it out.\n{{RETURN_POLICY}}",
      'Of course we can take care of you.\n{{RETURN_POLICY}}',
    ]) {
      expect(validateAndFill(bad, 'returns', {})).toBeNull();
    }
  });

  it('voids a shipping reply implying free shipping, and a recommendation pricing claim', () => {
    expect(validateAndFill('Standard shipping is on the house!\n{{SHIPPING_STANDARD}}', 'shipping_standard', {})).toBeNull();
    expect(
      validateAndFill('Our {{CATEGORY_RECOMMENDED}} has great options at every price point!', 'recommendation', {
        interest: 'shelter',
      }),
    ).toBeNull();
  });

  it('ACCEPTS honest reasoning that references a condition correctly', () => {
    const out = validateAndFill(
      "Since a return needs its original packaging, this one wouldn't meet the policy as-is:\n{{RETURN_POLICY}}\nA live agent can look at your case.",
      'returns',
      {},
    );
    expect(out).not.toBeNull();
    expect(out).toContain(RETURN_POLICY.packaging);
  });
});

describe('2. a clean reasoned reply is used (returns now reasons over the policy)', () => {
  const deps = { provider: returnsProvider('REASONED-VOICE:'), conversational: true };
  // Both a plain policy question and an eligibility question route through the reasoning compose.
  for (const msg of ['what is your return policy?', 'I lost my packaging', 'so you will honor it?']) {
    it(`"${msg}" uses the reasoned voice, with the policy verbatim`, async () => {
      const turn = await handleTurn(msg, initialState, deps);
      expect(turn.answer.text).toContain('REASONED-VOICE'); // the model's reasoned prose is used
      expect(turn.answer.text).toContain(RETURN_POLICY.packaging); // and the exact policy is present
    });
  }
});

describe('3. a reply that promises or contradicts is voided → honest fallback', () => {
  it('a false promise on an eligibility probe → the acknowledge+offer fallback (with a human route)', async () => {
    const deps = { provider: returnsProvider("Absolutely! We'll honor that for you —"), conversational: true };
    const turn = await handleTurn('I lost my packaging, will you honor it?', initialState, deps);
    expect(turn.answer.text).not.toMatch(/absolutely|we'?ll honou?r/i); // the promise never reaches the customer
    expect(turn.answer.text).toContain(RETURN_POLICY.packaging); // the real condition is shown
    expect(turn.answer.text).toMatch(/live agent/i); // fell back to renderReturnsEligibility
  });

  it('a contradiction on an eligibility probe → fallback, no negated condition leaks', async () => {
    const deps = { provider: returnsProvider("No worries, the packaging isn't required —"), conversational: true };
    const turn = await handleTurn('I lost my packaging', initialState, deps);
    expect(turn.answer.text).not.toMatch(/isn'?t required/i);
    expect(turn.answer.text).toContain(RETURN_POLICY.packaging);
    expect(turn.answer.text).toMatch(/live agent/i);
  });
});

describe('4. the keyless floor still answers an eligibility probe honestly', () => {
  it('a returns eligibility probe with no provider shows the policy + a human offer, no promise', async () => {
    // No provider → deterministic. "return" makes it a returns turn; "used" makes it an eligibility probe →
    // the acknowledge-and-offer render answers.
    const turn = await handleTurn('can I return a used item without the box?', initialState, {});
    expect(turn.answer.text).toContain(RETURN_POLICY.packaging);
    expect(turn.answer.text).toMatch(/live agent/i);
    expect(turn.answer.text).not.toMatch(/absolutely|we'?ll honou?r/i);
  });

  it('"take my used tent back" is recognized as a RETURN (not a recommendation), keyless', async () => {
    // A customer returning something rarely types "return" — the keyword path must still catch it.
    const turn = await handleTurn('can you take my used tent back?', initialState, {});
    expect(turn.answer.text).toContain(RETURN_POLICY.packaging); // routed to returns, shows the policy
    expect(turn.answer.text).not.toMatch(/heading out to do|what conditions/i); // NOT the recommendation clarify
  });
});
