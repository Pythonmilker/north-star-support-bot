/**
 * The two seams that turn this from a demo into something a real shop could run:
 * the shop's own business data, and the shop's own order system.
 *
 * Both are untrusted inputs. A config endpoint is a URL someone typed into an HTML attribute, and an
 * order API is a server we don't control. Whatever comes back from either one is about to be shown to a
 * customer, so it gets validated on the way in — that's most of what these tests are checking.
 *
 * The other half is the failure behaviour, and it is deliberately NOT the same in both cases:
 *
 *   config endpoint down  ->  keep serving, on the built-in data. A CMS outage must not take down the
 *                             shop's support chat.
 *   order API down        ->  do NOT answer. Say we can't check, hand to a human. Telling a customer
 *                             their real order "shipped, arriving tomorrow" on the strength of a fixture
 *                             is worse than admitting we don't know.
 *
 * Wrong data is worse than no data — but only when the data is about *them*.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore, resetStore, store, DEFAULTS } from '@/data/store';
import { createHttpOrderProvider, createMockOrderProvider } from '@/orders';
import { handleTurn, initialState } from '@/orchestrator';
import { PERSONA } from '@/persona';

afterEach(() => {
  resetStore();
  vi.unstubAllGlobals();
});

describe('a shop can replace the business data without touching the code', () => {
  it('overrides the values the renderer prints', async () => {
    configureStore({
      returnPolicy: {
        window: '14-day returns',
        condition: 'Items must be unopened',
        packaging: 'Receipt required',
      },
      shipping: { standard: 'Standard: 2 days', expedited: 'Expedited: same day' },
    });

    const returns = await handleTurn('what is your return policy?', initialState);
    expect(returns.answer.text).toContain('14-day returns');
    expect(returns.answer.text).toContain('Receipt required');

    const shipping = await handleTurn('how long is shipping?', initialState);
    expect(shipping.answer.text).toContain('Expedited: same day');
  });

  it('overrides the returns link, so it points at the shop’s real returns page', async () => {
    configureStore({ returnsUrl: 'https://shop.example/start-a-return' });
    const turn = await handleTurn('I want to return a jacket', initialState);
    expect(turn.answer.link?.href).toBe('https://shop.example/start-a-return');
  });

  it('leaves anything the shop did not override alone', () => {
    configureStore({ shipping: { standard: 'Standard: 2 days', expedited: 'Expedited: same day' } });
    // They said nothing about returns, so returns are untouched.
    expect(store().returnPolicy).toEqual(DEFAULTS.returnPolicy);
  });

  it('resets cleanly, so one page load cannot poison the next', () => {
    configureStore({ returnsUrl: 'https://shop.example/returns' });
    resetStore();
    expect(store()).toEqual(DEFAULTS);
  });

  /**
   * Config arrives over the network from a URL in an HTML attribute. It is not trusted input. A CMS with
   * an empty field must not blank out the return policy on a live storefront, and a CMS returning the
   * wrong TYPE must not put `[object Object]` in front of a customer.
   */
  it('ignores empty and malformed fields rather than rendering them', async () => {
    configureStore({
      shipping: { standard: '', expedited: '   ' },
      returnsUrl: 42,
      categories: ['not', 'a', 'map'],
    } as never);

    const turn = await handleTurn('how long is shipping?', initialState);
    expect(turn.answer.text).toContain(DEFAULTS.shipping.standard);
    expect(store().returnsUrl).toBe(DEFAULTS.returnsUrl);
    expect(store().categories).toEqual(DEFAULTS.categories);
  });
});

describe('order lookup against a real order API', () => {
  const OK = (status: string) =>
    new Response(JSON.stringify({ status }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('prints the shop’s status verbatim, exactly as it prints the mock data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(OK('Out for delivery — with the driver now')));

    const turn = await handleTurn('where is order 111', initialState, {
      orders: createHttpOrderProvider('https://shop.example/orders'),
    });

    expect(turn.answer.text).toContain('Out for delivery — with the driver now');
  });

  it('sends the order number the customer typed and nothing else', async () => {
    const fetchMock = vi.fn().mockResolvedValue(OK('Shipped'));
    vi.stubGlobal('fetch', fetchMock);

    await createHttpOrderProvider('https://shop.example/orders').lookup('111');

    expect(fetchMock.mock.calls[0]![0]).toBe('https://shop.example/orders?order=111');
  });

  it('treats a 404 as "no such order", which is an answer, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const result = await createHttpOrderProvider('https://shop.example/orders').lookup('999');
    expect(result).toEqual({ ok: true, status: null });
  });

  /**
   * The important one. When we cannot check, we say we cannot check.
   *
   * The tempting bug is to fall back to the bundled order fixtures the way the intent layer falls back to
   * keyword matching. It is not the same thing: a worse guess at what someone *meant* is still useful; a
   * confident wrong answer about *their order* is a support ticket and a lost customer.
   */
  it.each([
    ['the server is down', () => Promise.resolve(new Response(null, { status: 503 }))],
    ['the network is gone', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the response is garbage', () => Promise.resolve(new Response('{"status": 42}', { status: 200 }))],
  ])('escalates to a human when %s, instead of guessing from bundled data', async (_label, impl) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));

    const turn = await handleTurn('where is order 111', initialState, {
      orders: createHttpOrderProvider('https://shop.example/orders'),
    });

    expect(turn.answer.text).toContain(PERSONA.orderLookupFailed);
    expect(turn.state.mode).toBe('live_agent');
    // The bundled status for #111. It must NOT appear — that is the whole point.
    expect(turn.answer.text).not.toContain('Shipped, arriving tomorrow');
  });

  it('still leaves a way back to the main menu after that escalation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    const failed = await handleTurn('where is order 111', initialState, {
      orders: createHttpOrderProvider('https://shop.example/orders'),
    });
    const back = await handleTurn('menu', failed.state);

    expect(back.state.mode).toBe('normal');
    expect(back.answer.showMenu).toBe(true);
  });
});

describe('the default: no order API configured', () => {
  it('answers from the brief’s mock data, which is what a reviewer will see', async () => {
    const turn = await handleTurn('where is order 111', initialState, {
      orders: createMockOrderProvider(DEFAULTS.orders),
    });
    expect(turn.answer.text).toContain('Shipped, arriving tomorrow');
  });
});
