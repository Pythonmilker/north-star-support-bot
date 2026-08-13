/**
 * Order lookup.
 *
 * The brief supplies three fixed orders, which is right for a demo and useless for a real
 * shop. So lookup sits behind an interface with two implementations, exactly like the intent layer:
 *
 *   MockOrderProvider  the brief's data. The default. What the demo and the whole test suite run on.
 *   HttpOrderProvider  the shop's real order API, via `data-order-endpoint`.
 *
 * The renderer never learns which one answered. It is handed a status string and prints it verbatim,
 * so a real order system inherits the same guarantee the mock data has: the model cannot reword it.
 *
 * One deliberate asymmetry with the intent layer. When the LLM fails we silently fall back to keyword
 * matching, because a worse guess at intent is still a useful answer. When an order API fails we do
 * NOT fall back to bundled data, because that would tell a customer their real order is "Shipped,
 * arriving tomorrow" on the strength of a fixture. Wrong data is worse than no data. We say we cannot
 * check and offer a human.
 */

export type OrderLookup =
  /** Found. `status` is printed verbatim. */
  | { ok: true; status: string }
  /** Definitively no such order. Distinct from "we could not check". */
  | { ok: true; status: null }
  /** The lookup itself failed: network, 5xx, timeout, malformed response. */
  | { ok: false; reason: 'unavailable' };

export interface OrderProvider {
  readonly name: 'mock' | 'http';
  lookup(orderId: string): Promise<OrderLookup>;
}

/** The brief's three orders. Cannot fail, which is why the demo needs nothing configured. */
export function createMockOrderProvider(orders: Record<string, string>): OrderProvider {
  return {
    name: 'mock',
    lookup(orderId: string): Promise<OrderLookup> {
      const status = orders[orderId];
      return Promise.resolve(status ? { ok: true, status } : { ok: true, status: null });
    },
  };
}

const TIMEOUT_MS = 6000;

/**
 * The shop's own order API.
 *
 *   GET {endpoint}?order={id}   ->  200 { "status": "Shipped, arriving tomorrow" }
 *                                   404                       (no such order)
 *
 * The endpoint is called from the customer's browser, so it must be safe to call from there: no
 * secrets, no PII beyond the order number the customer already typed, CORS pinned to the shop's own
 * origin. A shop that needs authenticated lookups should proxy this server-side, the same way the
 * LLM key is proxied (see proxy/).
 */
export function createHttpOrderProvider(endpoint: string): OrderProvider {
  return {
    name: 'http',

    async lookup(orderId: string): Promise<OrderLookup> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const url = new URL(endpoint);
        url.searchParams.set('order', orderId);

        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        // A 404 is an answer, not a failure: this order does not exist.
        if (res.status === 404) return { ok: true, status: null };
        if (!res.ok) return { ok: false, reason: 'unavailable' };

        const body = (await res.json()) as { status?: unknown };

        // The response is untrusted input. It is about to be printed to a customer, so it must be a
        // plain non-empty string. Anything else is treated as a failed lookup rather than rendered.
        if (typeof body.status !== 'string' || !body.status.trim()) {
          return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, status: body.status };
      } catch {
        // Network error, DNS, CORS, timeout. All the same to the customer.
        return { ok: false, reason: 'unavailable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
