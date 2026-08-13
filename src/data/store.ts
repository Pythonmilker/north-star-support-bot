/**
 * SINGLE SOURCE OF TRUTH for all business data.
 *
 * Two things live here, and the distinction is the whole design:
 *
 *   DEFAULTS   the values transcribed verbatim from the client's brief. Frozen. Verified for exact
 *              accuracy. `tests/verbatim.test.ts` asserts byte-equality against them.
 *
 *   the store  what the widget actually renders: DEFAULTS, with any overrides the site owner supplies.
 *              A shop changes its shipping times without touching code, redeploying, or rebuilding.
 *
 * What does NOT change is the rule that made the defaults safe in the first place: none of this ever
 * enters an LLM prompt. A model that is shown a fact will eventually reword it. Code reads these
 * values and prints them; the model only ever classifies intent.
 *
 * This object is also the seam a CMS or database plugs into. Point `data-config-url` at an endpoint
 * that returns this shape and an admin can edit prices in a dashboard, with the bot still incapable of
 * misquoting them. The database replaces the constant. It does not replace the rule that code answers.
 */

export interface StoreData {
  /** Order number to status. In production, prefer a real order endpoint (see src/orders/). */
  orders: Record<string, string>;
  /** Asked after a delivered order. The brief buries this as "(ask follow-up if needed)". */
  deliveredFollowUp: string;
  returnPolicy: { window: string; condition: string; packaging: string };
  shipping: { standard: string; expedited: string };
  /** Where "Start a return" points. The brief mandates the link and supplies no URL. */
  returnsUrl: string;
  /** Interest tag to display name. Keys must match InterestTag in src/intent/types.ts. */
  categories: Record<string, string>;
}

/** The brief's data, verbatim. Frozen so a stray mutation cannot rewrite a verified fact at runtime. */
export const DEFAULTS: StoreData = Object.freeze({
  orders: Object.freeze({
    '111': 'Shipped, arriving tomorrow',
    '222': 'Processing, ships in 24 hours',
    '333': 'Delivered',
  }),
  deliveredFollowUp: 'Did everything arrive in good shape? I can help with a return if you need one.',
  returnPolicy: Object.freeze({
    window: '30-day returns',
    condition: 'Items must be unused',
    packaging: 'Original packaging required',
  }),
  shipping: Object.freeze({
    standard: 'Standard shipping: 3-5 business days',
    expedited: 'Expedited shipping: 1-2 business days',
  }),
  /**
   * example.com is IANA-reserved for illustration and returns HTTP 200. Not `example.com/returns`
   * (404), and not an invented subdomain (no DNS, so the customer gets a browser error page — which
   * is exactly the bug an earlier version of this file shipped).
   */
  returnsUrl: 'https://example.com',
  /**
   * ASSUMPTION. The brief requires "Recommend product category" and supplies no catalogue. It names no
   * category and gives no count; the word occurs once in the whole brief, in the singular. Each of
   * these is a subdivision of the brief's own words, "outdoor apparel and camping gear".
   */
  categories: Object.freeze({
    shelter: 'Tents & Shelters',
    sleep: 'Sleeping Bags & Pads',
    packs: 'Backpacks & Daypacks',
    insulation: 'Insulated Jackets & Layers',
    footwear: 'Hiking Footwear',
    cooking: 'Camp Kitchen & Cooking',
  }),
}) as StoreData;

/** What the widget is currently rendering from. Starts as the brief's data. */
let active: StoreData = DEFAULTS;

/**
 * Apply the site owner's overrides. Shallow per section, so a shop can change only its shipping copy
 * and inherit everything else.
 *
 * Every value is coerced to a string and empty values are dropped, because this data may arrive over
 * the network from a CMS. A config endpoint is not a trusted input: it must not be able to inject an
 * object, a function, or a null into something the renderer will print.
 */
export function configureStore(overrides?: Partial<StoreData> | null): void {
  if (!overrides || typeof overrides !== 'object') {
    active = DEFAULTS;
    return;
  }

  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() ? v : fallback;

  const strMap = (v: unknown, fallback: Record<string, string>): Record<string, string> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim()) out[k] = val;
    }
    return Object.keys(out).length ? out : fallback;
  };

  active = {
    orders: strMap(overrides.orders, DEFAULTS.orders),
    deliveredFollowUp: str(overrides.deliveredFollowUp, DEFAULTS.deliveredFollowUp),
    returnPolicy: {
      window: str(overrides.returnPolicy?.window, DEFAULTS.returnPolicy.window),
      condition: str(overrides.returnPolicy?.condition, DEFAULTS.returnPolicy.condition),
      packaging: str(overrides.returnPolicy?.packaging, DEFAULTS.returnPolicy.packaging),
    },
    shipping: {
      standard: str(overrides.shipping?.standard, DEFAULTS.shipping.standard),
      expedited: str(overrides.shipping?.expedited, DEFAULTS.shipping.expedited),
    },
    returnsUrl: str(overrides.returnsUrl, DEFAULTS.returnsUrl),
    categories: strMap(overrides.categories, DEFAULTS.categories),
  };
}

/** The data the renderer prints. */
export function store(): StoreData {
  return active;
}

/** Drop back to the brief's data. Used by the tests so one case can't leak config into the next. */
export function resetStore(): void {
  active = DEFAULTS;
}

/* ------------------------------------------------------------------------------------------------
 * Named exports of the brief's values. These are what the accuracy tests assert against, and they
 * always mean "what the brief said", never "what the shop later configured".
 * --------------------------------------------------------------------------------------------- */

export const ORDER_STATUS = DEFAULTS.orders;
export const DELIVERED_FOLLOW_UP = DEFAULTS.deliveredFollowUp;
export const RETURN_POLICY = DEFAULTS.returnPolicy;
export const SHIPPING = DEFAULTS.shipping;
export const DEFAULT_RETURNS_URL = DEFAULTS.returnsUrl;
export const PRODUCT_CATEGORIES = DEFAULTS.categories;

/** Every verbatim, verified string in one list — the fixture the accuracy tests assert against. */
export const VERBATIM_STRINGS: readonly string[] = [
  DEFAULTS.orders['111']!,
  DEFAULTS.orders['222']!,
  DEFAULTS.orders['333']!,
  DEFAULTS.returnPolicy.window,
  DEFAULTS.returnPolicy.condition,
  DEFAULTS.returnPolicy.packaging,
  DEFAULTS.shipping.standard,
  DEFAULTS.shipping.expedited,
];
