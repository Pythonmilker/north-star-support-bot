/**
 * THE ACCURACY TEST *
 * The brief checks "accuracy of responses based on provided data" and requires order tracking to
 * follow the mock data EXACTLY. This test asserts that every verified fact leaves the renderer
 * byte-for-byte identical to `store.ts` — no paraphrase, no re-casing, no "helpful" rewording.
 *
 * It is deliberately literal. If someone later routes a response through an LLM for polish, or
 * hand-types a status string into a component, this test fails — which is the entire point.
 */

import { describe, it, expect } from 'vitest';
import {
  ORDER_STATUS,
  RETURN_POLICY,
  SHIPPING,
  DEFAULT_RETURNS_URL,
  VERBATIM_STRINGS,
  DELIVERED_FOLLOW_UP,
} from '@/data/store';
import { render } from '@/answer/render';
import { PERSONA, ORDER_LEADS } from '@/persona';

describe('order statuses are emitted verbatim', () => {
  it.each([
    ['111', ORDER_STATUS['111']],
    ['222', ORDER_STATUS['222']],
    ['333', ORDER_STATUS['333']],
  ])('order #%s returns its exact status string', (orderId, expected) => {
    const answer = render('order_tracking', { orderId });
    expect(answer.text).toContain(expected);
  });

  it('order #111 says exactly "Shipped, arriving tomorrow"', () => {
    expect(render('order_tracking', { orderId: '111' }).text).toContain('Shipped, arriving tomorrow');
  });

  it('order #222 says exactly "Processing, ships in 24 hours"', () => {
    expect(render('order_tracking', { orderId: '222' }).text).toContain('Processing, ships in 24 hours');
  });

  it('order #333 says "Delivered" AND fires the required follow-up', () => {
    // The brief writes this as "Delivered (ask follow-up if needed)" — the parenthetical is a requirement,
    // and it is the single easiest sub-step in the whole contract to miss.
    const answer = render('order_tracking', { orderId: '333' });
    expect(answer.text).toContain('Delivered');
    expect(answer.text).toContain(DELIVERED_FOLLOW_UP);
  });

  it('an unknown order number takes the invalid-order branch and never invents a status', () => {
    const answer = render('order_tracking', { orderId: '999' });
    for (const status of Object.values(ORDER_STATUS)) {
      expect(answer.text).not.toContain(status);
    }
    expect(answer.showMenu).toBe(true);
  });

  it('asks for the order number when none was given', () => {
    expect(render('order_tracking', {}).awaiting).toBe('order_number');
  });
});

describe('return policy states all three verified conditions verbatim', () => {
  const answer = render('returns_exchanges');

  it.each([RETURN_POLICY.window, RETURN_POLICY.condition, RETURN_POLICY.packaging])(
    'includes "%s"',
    (condition) => {
      expect(answer.text).toContain(condition);
    },
  );

  it('provides an actual returns LINK, not just policy prose', () => {
    // "Provide returns link" is its own numbered sub-requirement of the Return & Exchanges use case.
    expect(answer.link?.href).toBe(DEFAULT_RETURNS_URL);
  });

  it('the host page can point the link at its own returns page', () => {
    // The brief mandates a returns link and supplies no URL, so the address is configuration, not data.
    // A store sets data-returns-url; this asserts that value actually reaches the rendered link.
    const configured = render('returns_exchanges', {}, { returnsUrl: 'https://yourstore.com/returns' });
    expect(configured.link?.href).toBe('https://yourstore.com/returns');
  });

  it('falls back to a URL that resolves rather than one that fails DNS', () => {
    // An invented subdomain (northstar-outfitters.example.com) does not resolve, so a reviewer clicking
    // the button got a browser error. example.com is IANA-reserved for illustration and returns 200.
    expect(DEFAULT_RETURNS_URL).toBe('https://example.com');
    expect(DEFAULT_RETURNS_URL).not.toMatch(/northstar-outfitters/);
  });

  it('acknowledges exchanges, since the use case is titled "Return & Exchanges"', () => {
    expect(answer.text.toLowerCase()).toContain('exchange');
  });
});

describe('shipping timeframes are emitted verbatim', () => {
  it('lists both tiers when the customer is not specific', () => {
    const text = render('shipping_info').text;
    expect(text).toContain(SHIPPING.standard);
    expect(text).toContain(SHIPPING.expedited);
  });

  it.each([
    ['standard', SHIPPING.standard],
    ['expedited', SHIPPING.expedited],
  ] as const)('answers a specific ask about %s shipping exactly', (tier, expected) => {
    expect(render('shipping_info', { shippingTier: tier }).text).toContain(expected);
  });
});

describe('no verified string is ever mutated anywhere in the renderer', () => {
  // Belt and braces: render every intent, concatenate everything the customer could see, and assert
  // that each verified fact appears only in its exact form. Catches a stray "3–5" en-dash, a lowercased
  // "shipped", a stripped comma — the small mutations that a human eye slides right past.
  const allText = (
    [
      render('order_tracking', { orderId: '111' }),
      render('order_tracking', { orderId: '222' }),
      render('order_tracking', { orderId: '333' }),
      render('returns_exchanges'),
      render('shipping_info'),
      render('product_recommendation', { interest: 'shelter' }),
      render('human_handoff'),
      render('unknown'),
    ] as const
  )
    .map((a) => a.text)
    .join('\n');

  it.each(VERBATIM_STRINGS)('verified string "%s" appears exactly as written', (verified) => {
    expect(allText).toContain(verified);
  });

  it('uses a plain ASCII hyphen in the shipping ranges (not an en-dash)', () => {
    // A "smart" editor silently turning 3-5 into 3–5 would be a paraphrase of verified data.
    expect(SHIPPING.standard).toContain('3-5');
    expect(SHIPPING.expedited).toContain('1-2');
    expect(SHIPPING.standard).not.toMatch(/[–—]/);
    expect(SHIPPING.expedited).not.toMatch(/[–—]/);
  });
});

/**
 * The warm variant pools must never put a fact at risk. Variety lives ONLY in the fact-free garnish;
 * the verbatim data is printed unchanged whichever variant is picked. These tests sweep EVERY variant
 * (by seeding across a wide input space) and re-assert the accuracy guarantee holds for all of them —
 * the whole reason the enrichment was safe to add.
 */
describe('the variant pools never touch a verified fact', () => {
  // Enough distinct seeds to land on every variant of every pool (pools are size 2-3).
  const SEEDS = Array.from({ length: 40 }, (_, i) => `seed-input-number-${i}`);

  it('every order-status variant still shows the exact status, however warm the lead', () => {
    for (const orderId of ['111', '222', '333'] as const) {
      // Order leads are seeded by orderId, so render the same order many ways is stable — but assert the
      // verified status survives regardless.
      const answer = render('order_tracking', { orderId });
      expect(answer.text).toContain(ORDER_STATUS[orderId]);
      // And the "Status:" label is present so the provided data is unmistakable under the lead.
      expect(answer.text).toContain(`Status: ${ORDER_STATUS[orderId]}`);
    }
  });

  it('every returns variant still states all three policy conditions verbatim + the link', () => {
    for (const seed of SEEDS) {
      const a = render('returns_exchanges', {}, { seed });
      expect(a.text).toContain(RETURN_POLICY.window);
      expect(a.text).toContain(RETURN_POLICY.condition);
      expect(a.text).toContain(RETURN_POLICY.packaging);
      expect(a.link?.href).toBe(DEFAULT_RETURNS_URL);
    }
  });

  it('every shipping variant still lists both tiers verbatim', () => {
    for (const seed of SEEDS) {
      const a = render('shipping_info', {}, { seed });
      expect(a.text).toContain(SHIPPING.standard);
      expect(a.text).toContain(SHIPPING.expedited);
    }
  });

  it('every recommendation variant still names the exact category', () => {
    for (const seed of SEEDS) {
      const a = render('product_recommendation', { interest: 'shelter' }, { seed });
      expect(a.text).toContain('Tents & Shelters');
    }
  });
});

/**
 * The lead-ins are GARNISH — they must never assert a fact. A lead with a digit or a delivery claim in
 * it could contradict or pre-empt the verbatim status below it. This is the line that keeps the warmth
 * from ever becoming a second, unverified source of truth.
 */
describe('warm lead-ins carry no facts', () => {
  const allLeads = [
    ...ORDER_LEADS.shipped,
    ...ORDER_LEADS.processing,
    ...ORDER_LEADS.delivered,
    ...ORDER_LEADS.neutral,
  ];

  it.each(allLeads)('order lead "%s" contains no digit', (lead) => {
    expect(lead).not.toMatch(/\d/);
  });

  it.each([...PERSONA.returnsOpeners, ...PERSONA.shippingOpeners])(
    'opener "%s" contains no digit (numbers belong only in the verbatim lines)',
    (opener) => {
      expect(opener).not.toMatch(/\d/);
    },
  );
});

/**
 * Selection is deterministic (a pure function of the seed) — no Math.random. This is what keeps a
 * "generated-feeling" bot fully testable and reproducible: the same turn always renders identically.
 */
describe('variant selection is deterministic', () => {
  it('the same intent + same seed renders byte-identical text', () => {
    for (const intent of ['returns_exchanges', 'shipping_info', 'unknown', 'closing'] as const) {
      const a = render(intent, {}, { seed: 'a stable seed' });
      const b = render(intent, {}, { seed: 'a stable seed' });
      expect(a.text).toBe(b.text);
    }
  });

  it('different seeds can surface different wrappers (the pools are actually used)', () => {
    const rendered = new Set(
      Array.from({ length: 30 }, (_, i) => render('unknown', {}, { seed: `x${i}` }).text),
    );
    // With a 3-variant pool and 30 seeds, we expect to see more than one wrapping.
    expect(rendered.size).toBeGreaterThan(1);
  });
});
