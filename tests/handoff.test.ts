/**
 * Handoff triggers on exactly the two things the brief names: an EXPLICIT request for a person, or a
 * fallback scenario (repeated non-understanding). It must NOT fire just because the model read the
 * customer as frustrated — that was inconsistent (some angry phrasings handed off, some didn't) and is
 * not a spec'd trigger. These tests pin the guard that keeps the LLM to the spec.
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState } from '@/orchestrator';
import type { Classification, IntentProvider } from '@/intent/types';

/** A stand-in LLM that always returns the classification we hand it — to simulate the model's guesses. */
function fakeLLM(value: Classification): IntentProvider {
  return { name: 'llm', classify: async () => ({ ok: true, value }) };
}
const handoff = (): Classification => ({ intent: 'human_handoff', entities: {}, confidence: 0.9 });

describe('the model cannot hand off on frustration alone', () => {
  it.each(['im enraged', 'you are useless', 'this bot sucks', 'i am so angry right now'])(
    'downgrades an inferred handoff for "%s" to the fallback path',
    async (text) => {
      // The LLM *says* human_handoff, but the customer never asked for a person.
      const turn = await handleTurn(text, initialState, { provider: fakeLLM(handoff()) });
      expect(turn.state.mode).not.toBe('live_agent'); // NOT an immediate handoff
      expect(turn.answer.text.toLowerCase()).toMatch(/didn'?t quite (catch|get)|not sure I follow/i);
    },
  );

  it('an inferred handoff still escalates after a SECOND miss (the fallback route to a human)', async () => {
    const provider = fakeLLM(handoff());
    const first = await handleTurn('im enraged', initialState, { provider });
    const second = await handleTurn('still enraged', first.state, { provider });
    // Two misses in a row → the spec's *fallback* handoff trigger fires, consistently.
    expect(second.state.mode).toBe('live_agent');
  });
});

describe('an explicit request still hands off immediately', () => {
  it.each(['talk to a human', 'get me a live agent', 'connect me with somebody', 'customer service please'])(
    '"%s" → Live Agent',
    async (text) => {
      // Even with the LLM claiming handoff, these are genuine explicit requests, so they survive the guard.
      const turn = await handleTurn(text, initialState, { provider: fakeLLM(handoff()) });
      expect(turn.state.mode).toBe('live_agent');
      expect(turn.answer.text.toLowerCase()).toContain('live agent');
    },
  );

  it('works with no LLM at all — the keyword path hands off on an explicit request', async () => {
    const turn = await handleTurn('I want to talk to a live agent', initialState);
    expect(turn.state.mode).toBe('live_agent');
  });
});
