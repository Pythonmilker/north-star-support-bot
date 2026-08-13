/**
 * Conversation-level tests: the four required use cases + fallback + handoff, driven the way a real
 * customer would — raw utterances in, rendered replies out.
 *
 * Crucially these run through the RULE matcher, with no LLM and no API key. That is the point: this
 * file is proof that the deterministic core alone satisfies the verified criteria. The LLM layer added
 * later can only improve intent recognition; it can never be load-bearing for correctness.
 */

import { describe, it, expect } from 'vitest';
import { classifyWithRules } from '@/intent/rules';
import { render, type Answer } from '@/answer/render';
import { ORDER_STATUS, RETURN_POLICY, SHIPPING, DEFAULT_RETURNS_URL } from '@/data/store';
import { CONFIDENCE_THRESHOLD } from '@/intent/types';
import { PERSONA } from '@/persona';

/** One customer turn: classify, then render — exactly what the orchestrator will do. */
function say(text: string): Answer {
  const c = classifyWithRules(text);
  const intent = c.confidence >= CONFIDENCE_THRESHOLD ? c.intent : 'unknown';
  return render(intent, c.entities);
}

describe('use case 1 — order tracking', () => {
  it.each([
    'Where is my order?',
    'Track my package',
    'order status',
    "wheres my stuff",
    "my order hasn't arrived",
  ])('recognises "%s" as order tracking and asks for the number', (utterance) => {
    expect(say(utterance).awaiting).toBe('order_number');
  });

  it.each([
    ['order 111', ORDER_STATUS['111']],
    ['#222', ORDER_STATUS['222']],
    ['can you check order #333', ORDER_STATUS['333']],
  ])('"%s" returns the verbatim status', (utterance, expected) => {
    expect(say(utterance).text).toContain(expected);
  });

  it('an unknown order number is rejected without inventing a status', () => {
    const reply = say('order 999');
    expect(reply.text).toMatch(/can't find an order/i);
    for (const status of Object.values(ORDER_STATUS)) expect(reply.text).not.toContain(status);
  });
});

describe('use case 2 — returns & exchanges', () => {
  it.each(['I want to return this', 'how do refunds work', "it doesn't fit", 'can I exchange it'])(
    '"%s" explains the policy AND surfaces a link',
    (utterance) => {
      const reply = say(utterance);
      expect(reply.text).toContain(RETURN_POLICY.window);
      expect(reply.text).toContain(RETURN_POLICY.condition);
      expect(reply.text).toContain(RETURN_POLICY.packaging);
      expect(reply.link?.href).toBe(DEFAULT_RETURNS_URL);
    },
  );
});

describe('use case 3 — product recommendations', () => {
  it('asks a clarifying question BEFORE recommending', () => {
    const reply = say('can you recommend something');
    expect(reply.awaiting).toBe('recommend_activity');
    // It must not leap straight to a category.
    expect(reply.text).not.toMatch(/Tents|Sleeping|Backpacks/);
  });

  it('recommends a CATEGORY (not a SKU) once it knows the interest', () => {
    const reply = say("I'm looking for a tent for camping");
    expect(reply.text).toContain('Tents & Shelters');
  });
});

describe('use case 4 — human handoff', () => {
  it.each(['I want to talk to a human', 'get me a live agent', 'customer service please'])(
    '"%s" triggers handoff on explicit request',
    (utterance) => {
      const reply = say(utterance);
      expect(reply.handoff).toBe(true);
      expect(reply.text).toMatch(/live agent/i);
    },
  );

  it('an explicit human request beats a co-occurring topical keyword', () => {
    // "return" would otherwise score as returns_exchanges — but the customer asked for a person.
    expect(say('I want to return this, get me a human').handoff).toBe(true);
  });

  it('the handoff is never a dead end — it always offers a way back', () => {
    const reply = say('let me speak to someone');
    expect(reply.showMenu).toBe(true);
    expect(reply.text).toMatch(/menu/i);
  });
});

describe('shipping — verified, but not one of the four use cases (the audit trap)', () => {
  it.each(['how long does shipping take', 'what are your delivery options', 'shipping'])(
    '"%s" is answerable even though it has no dedicated use case',
    (utterance) => {
      const reply = say(utterance);
      expect(reply.text).toContain(SHIPPING.standard);
      expect(reply.text).toContain(SHIPPING.expedited);
    },
  );

  it('answers a specific expedited question with the exact timeframe', () => {
    expect(say('how fast is expedited shipping').text).toContain(SHIPPING.expedited);
  });
});

describe('fallback', () => {
  it.each(['do you have a store in Denver', 'what is the weather like', 'asdfghjkl'])(
    '"%s" falls back rather than guessing',
    (utterance) => {
      const reply = say(utterance);
      // The reply is one of the fallback variants — any of the pool is acceptable, none is guessing.
      expect(PERSONA.didNotUnderstandVariants).toContain(reply.text);
      // The brief requires options OR escalation — an apology alone is a fail.
      expect(reply.showMenu).toBe(true);
    },
  );

  /**
   * The fallback copy now varies (a pool, not one line), so pin the CONTRACT every variant must hold
   * rather than any single wording: it plainly signals non-understanding, and it offers a way forward.
   */
  it('every fallback variant signals non-understanding and offers a route on', () => {
    for (const variant of PERSONA.didNotUnderstandVariants) {
      expect(variant).toMatch(/didn'?t quite (catch|get)|not sure I follow/i);
      expect(variant.toLowerCase()).toContain('live agent');
    }
  });

  it('never emits a business fact on the fallback path', () => {
    const reply = say('completely unrelated gibberish query');
    for (const status of Object.values(ORDER_STATUS)) expect(reply.text).not.toContain(status);
  });
});
