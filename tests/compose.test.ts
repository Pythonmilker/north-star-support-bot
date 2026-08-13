/**
 * THE COMPOSE SAFETY TEST *
 * The generative layer lets the model write prose, so the guarantee moves from "the schema can't express
 * a fact" to "the validator refuses any reply that isn't fact-safe". This file is that validator's proof.
 *
 * Two things must hold, always:
 *   1. A verified fact is byte-exact — it came from store() via slot substitution, never from the model.
 *   2. A raw {{token}}, a foreign/misused token, a missing datum, or a fabricated fact voids the reply and
 *      the deterministic renderer answers instead. A customer can never see a broken or invented reply.
 */

import { describe, it, expect } from 'vitest';
import { validateAndFill, composeOrRender } from '@/answer/compose';
import { renderReturns } from '@/answer/render';
import { RETURN_POLICY, SHIPPING, PRODUCT_CATEGORIES, DEFAULT_RETURNS_URL } from '@/data/store';
import type { ComposePurpose, ComposeResult, IntentProvider } from '@/intent/types';

describe('validateAndFill — the fact-safety gate', () => {
  it('fills an allowed, required token with the verbatim value', () => {
    const out = validateAndFill('Sure — here you go:\n{{RETURN_POLICY}}\nAnything else?', 'returns', {});
    expect(out).not.toBeNull();
    // Every verified policy condition survives byte-for-byte.
    expect(out).toContain(RETURN_POLICY.window);
    expect(out).toContain(RETURN_POLICY.condition);
    expect(out).toContain(RETURN_POLICY.packaging);
    // The warm prose the model wrote survives around it.
    expect(out).toContain('Anything else?');
    // And no brace ever remains.
    expect(out).not.toMatch(/\{\{|\}\}/);
  });

  it('fills shipping tokens with the exact timeframes', () => {
    const out = validateAndFill('Shipping options:\n{{SHIPPING_STANDARD}}\n{{SHIPPING_EXPEDITED}}', 'shipping_both', {});
    expect(out).toContain(SHIPPING.standard);
    expect(out).toContain(SHIPPING.expedited);
  });

  it('fills a recommendation category from the resolved interest', () => {
    const out = validateAndFill("You'll want our {{CATEGORY_RECOMMENDED}}!", 'recommendation', { interest: 'shelter' });
    expect(out).toContain(PRODUCT_CATEGORIES.shelter);
  });

  it('handles spaced tokens {{ TOKEN }} too', () => {
    const out = validateAndFill('{{ RETURN_POLICY }}', 'returns', {});
    expect(out).toContain(RETURN_POLICY.window);
    expect(out).not.toMatch(/\{\{|\}\}/);
  });

  // ── every reason it must fall back (return null) ────────────────────────────────────────────────

  it('rejects a token that is not in the registry at all', () => {
    expect(validateAndFill('{{RETURN_POLICY}} {{HACKED}}', 'returns', {})).toBeNull();
  });

  it('rejects a real token used for the WRONG purpose', () => {
    // SHIPPING_STANDARD is not allowed on a returns reply.
    expect(validateAndFill('{{RETURN_POLICY}} and {{SHIPPING_STANDARD}}', 'returns', {})).toBeNull();
  });

  it('rejects when a REQUIRED datum is missing', () => {
    expect(validateAndFill('Happy to help with returns!', 'returns', {})).toBeNull();
  });

  it('rejects a recommendation whose category cannot resolve (no interest)', () => {
    expect(validateAndFill('Try our {{CATEGORY_RECOMMENDED}}', 'recommendation', {})).toBeNull();
  });

  it('rejects a fabricated NUMBER in the model’s own prose', () => {
    // A digit outside a slot is an invented fact — the slots carry every real number.
    expect(validateAndFill('Returns are easy — you have 60 days!\n{{RETURN_POLICY}}', 'returns', {})).toBeNull();
  });

  it('rejects a fabricated price or promo claim', () => {
    expect(validateAndFill('{{SHIPPING_STANDARD}} — and shipping is free!', 'shipping_standard', {})).toBeNull();
    expect(validateAndFill('{{RETURN_POLICY}} ($5 restocking fee)', 'returns', {})).toBeNull();
  });

  it('rejects a malformed/unclosed brace so no raw token can ever leak', () => {
    // The opening braces don't form a valid token → never substituted → step-5 backstop voids it.
    expect(validateAndFill('Here: {{RETURN_POLICY} oops', 'returns', {})).toBeNull();
    expect(validateAndFill('{{RETURN_POLICY}} {{', 'returns', {})).toBeNull();
  });

  // ── fact-FREE purposes (fallback, closing, clarifying questions): no slots, but still can't fabricate ──

  it('accepts a clean fact-free reply (no slots) for a fallback', () => {
    const out = validateAndFill("I'm not sure I followed — want the menu, or a live agent?", 'fallback', {});
    expect(out).toBe("I'm not sure I followed — want the menu, or a live agent?");
  });

  it('accepts a clean clarifying question', () => {
    expect(validateAndFill('What are you heading out to do?', 'clarify_activity', {})).not.toBeNull();
  });

  it('rejects a fact-free reply that sneaks in a number (a fabricated fact)', () => {
    // A fallback should carry no data — a digit means the model invented something.
    expect(validateAndFill('Sorry! Call us at 555-1234.', 'fallback', {})).toBeNull();
    expect(validateAndFill('Happy trails! Come back within 7 days.', 'closing', {})).toBeNull();
  });

  it('rejects a slot token used on a fact-free purpose (none are allowed there)', () => {
    expect(validateAndFill('Confused! {{RETURN_POLICY}}', 'fallback', {})).toBeNull();
  });

  // ── the model ADJUDICATING a fact in its own prose (the non-numeric contradiction hole) ─────────────
  // Observed live: asked "do I need the original box?", the model wrote "The original box isn't required…"
  // directly above the slot line "Original packaging required". No digit/price/promo, so the number guard
  // missed it. The slot owns the facts; the prose must not restate or judge them.

  it('rejects the exact observed contradiction ("the original box isn\'t required")', () => {
    const template =
      "Great question! The original box isn't required—pack it however works best.\n{{RETURN_POLICY}}";
    expect(validateAndFill(template, 'returns', {})).toBeNull();
  });

  it('ALLOWS correct reasoning about a condition, but voids a CONTRADICTION of one', () => {
    // The model is now GIVEN the policy to reason over, so referencing a condition honestly is the whole
    // point and is allowed.
    expect(
      validateAndFill(
        "Since a return needs its original packaging, that one wouldn't meet the policy — a live agent can help.\n{{RETURN_POLICY}}",
        'returns',
        {},
      ),
    ).not.toBeNull();
    // Negating a required condition is still voided.
    expect(validateAndFill('No need to keep the packaging.\n{{RETURN_POLICY}}', 'returns', {})).toBeNull();
    expect(validateAndFill("The packaging isn't required.\n{{RETURN_POLICY}}", 'returns', {})).toBeNull();
    expect(validateAndFill('Returns are unlimited with no time limit.\n{{RETURN_POLICY}}', 'returns', {})).toBeNull();
  });

  it('rejects shipping prose that compares speeds or implies a cost', () => {
    expect(
      validateAndFill('Expedited is faster than standard.\n{{SHIPPING_STANDARD}}\n{{SHIPPING_EXPEDITED}}', 'shipping_both', {}),
    ).toBeNull();
    expect(validateAndFill('Standard is our cheapest option.\n{{SHIPPING_STANDARD}}', 'shipping_standard', {})).toBeNull();
  });

  it('rejects a recommendation that invents a product attribute', () => {
    expect(
      validateAndFill('Our {{CATEGORY_RECOMMENDED}} are the best — fully waterproof and lightweight!', 'recommendation', {
        interest: 'shelter',
      }),
    ).toBeNull();
  });

  it('still ACCEPTS a warm returns reply that frames without adjudicating', () => {
    const out = validateAndFill(
      "Happy to help! Here's the scoop:\n{{RETURN_POLICY}}\nHit the button below whenever you're ready.",
      'returns',
      {},
    );
    expect(out).not.toBeNull();
    expect(out).toContain(RETURN_POLICY.window);
    expect(out).toContain(RETURN_POLICY.condition);
    expect(out).toContain(RETURN_POLICY.packaging);
  });
});

/** A mock provider so composeOrRender can be exercised with no network. */
function mockProvider(compose: (p: ComposePurpose, t: string) => Promise<ComposeResult>): IntentProvider {
  return { name: 'llm', classify: async () => ({ ok: false, error: { kind: 'no_key' } }), compose };
}

describe('composeOrRender — always fails safe to the deterministic base', () => {
  const base = renderReturns();

  it('uses the composed text when it validates, but keeps every flag from the base', async () => {
    const provider = mockProvider(async () => ({ ok: true, value: 'Easy! {{RETURN_POLICY}} 🎒' }));
    const out = await composeOrRender('returns', base, provider, 'how do returns work', {});
    expect(out.text).toContain('Easy!');
    expect(out.text).toContain(RETURN_POLICY.window);
    // The verified returns LINK affordance is inherited from the base, never dropped by generation.
    expect(out.link?.href).toBe(DEFAULT_RETURNS_URL);
    expect(out.showMenu).toBe(true);
  });

  it('falls back to the base when the model fabricates a fact', async () => {
    const provider = mockProvider(async () => ({ ok: true, value: '{{RETURN_POLICY}} — 90 day window!' }));
    const out = await composeOrRender('returns', base, provider, 'returns?', {});
    expect(out).toEqual(base); // byte-identical to the deterministic reply
  });

  it('falls back to the base on a transport failure', async () => {
    const provider = mockProvider(async () => ({ ok: false, error: { kind: 'timeout' } }));
    const out = await composeOrRender('returns', base, provider, 'returns?', {});
    expect(out).toEqual(base);
  });

  it('falls back to the base when the provider has no compose method', async () => {
    const rulesOnly: IntentProvider = { name: 'rules', classify: async () => ({ ok: false, error: { kind: 'no_key' } }) };
    const out = await composeOrRender('returns', base, rulesOnly, 'returns?', {});
    expect(out).toEqual(base);
  });
});
