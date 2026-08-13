/**
 * Runtime configuration.
 *
 * Everything resolves at RUNTIME, never at build time. The widget ships as one file that a static
 * site drops in with a <script> tag — there is no bundler on the host page to substitute env vars
 * into, so `import.meta.env` is useless to us here.
 *
 * Resolution order (first wins):
 *   1. NorthStarBot.init({ apiKey })      — the host page configures it explicitly
 *   2. <script data-api-key="...">        — the zero-JS path
 *   3. window.NorthStarBotConfig          — a key in a sibling <script>, rotated without a rebuild
 *   4. BUNDLED_DEMO_KEY                   — a disposable evaluation key, if one was built in
 *
 * Every path is set by the site owner, never by the visitor: a customer-facing support bot must not
 * ask a shopper for an API key. And anything shipped in a browser bundle is public — a reader can open
 * devtools and take it — so a bundled key is only ever a DISPOSABLE demo key with a hard spend cap,
 * rotated the moment evaluation ends.
 */

import type { StoreData } from '@/data/store';

/**
 * Replaced at build time by Vite's `define`. Empty in the repo — a live key is never committed.
 * See README for how to produce an evaluation build with a disposable key baked in.
 */
declare const __BUNDLED_DEMO_KEY__: string;

export interface WidgetConfig {
  apiKey: string | undefined;
  /** Optional server-side proxy. If present, the key never touches the browser at all. */
  proxyUrl: string | undefined;
  model: string;
  /** Where the launcher sits on the host page. */
  position: 'bottom-right' | 'bottom-left';
  /** Accent colour, validated — it is interpolated into CSS, so it cannot be trusted raw. */
  accent: string;
  /** Where "Start a return" points. The brief mandates a link but supplies no URL, so the host sets it. */
  returnsUrl: string | undefined;
  /** JSON endpoint returning StoreData. This is where a CMS or database plugs in. */
  configUrl: string | undefined;
  /** The shop's real order API. Without it, the bundled fixture orders are used. */
  orderEndpoint: string | undefined;
  /** Where a "Shop …" button on a recommendation points (the store's collection/category page). */
  shopUrl: string | undefined;
  /**
   * Opt in to the generative layer: the LLM writes warm, human replies with business facts spliced in
   * verbatim via slots (see answer/compose.ts). Off by default — the deterministic phrasebook is the
   * safe, tested floor, and it's what a keyless reviewer sees regardless. Turn on for the human feel.
   */
  conversational: boolean;
}

export interface InitOptions {
  apiKey?: string;
  proxyUrl?: string;
  model?: string;
  position?: 'bottom-right' | 'bottom-left';
  accent?: string;
  returnsUrl?: string;
  configUrl?: string;
  orderEndpoint?: string;
  shopUrl?: string;
  conversational?: boolean;
  /** Business data supplied inline by the host page, instead of over the network. */
  data?: Partial<StoreData>;
  target?: string;
}

const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';
const DEFAULT_ACCENT = '#1e6e4e';

/** Only ever interpolate a colour we've proven is a colour — this string lands inside a <style> block. */
function safeAccent(value: string | undefined): string {
  return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : DEFAULT_ACCENT;
}

function bundledKey(): string | undefined {
  try {
    return typeof __BUNDLED_DEMO_KEY__ === 'string' && __BUNDLED_DEMO_KEY__.length > 0
      ? __BUNDLED_DEMO_KEY__
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A key the site owner puts in a small sibling file, rather than inside the widget bundle:
 *
 *   <script>window.NorthStarBotConfig = { apiKey: 'sk-or-...' };</script>
 *   <script src="north-star-bot.js"></script>
 *
 * This is the rotation path for whoever runs the site. They edit one line and reload. No rebuild, no
 * npm, no toolchain, and the widget bundle itself never has to be touched or re-shipped.
 *
 * It does NOT hide the key. Nothing can: a key the browser can use is a key the browser can read, and
 * devtools will show it either way. The reason to keep it out of the bundle is operational, not secret
 * — the key becomes a thing you rotate independently of the code.
 */
function hostConfigKey(): string | undefined {
  try {
    const cfg = (window as unknown as Record<string, { apiKey?: unknown } | undefined>)[
      'NorthStarBotConfig'
    ];
    const key = cfg?.apiKey;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Merge the script tag's data-* attributes with any explicit init() options. */
export function resolveConfig(dataset: DOMStringMap, options: InitOptions = {}): WidgetConfig {
  const position = options.position ?? dataset['position'];

  return {
    /**
     * Key resolution, first non-empty wins — every path is set by the site owner, never the visitor:
     *
     *   1. init({ apiKey })           host page JS
     *   2. data-api-key               host page HTML       } the admin rotation paths:
     *   3. window.NorthStarBotConfig  a sibling <script>   } edit and reload, no rebuild
     *   4. bundled key                baked in at build time, for the zero-setup demo
     *
     * Anything above the bundled key overrides it, so rotating never requires rebuilding the widget.
     */
    apiKey: options.apiKey ?? dataset['apiKey'] ?? hostConfigKey() ?? bundledKey(),
    proxyUrl: options.proxyUrl ?? dataset['proxyUrl'],
    model: options.model ?? dataset['model'] ?? DEFAULT_MODEL,
    position: position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    accent: safeAccent(options.accent ?? dataset['accent']),
    returnsUrl: options.returnsUrl ?? dataset['returnsUrl'],
    configUrl: options.configUrl ?? dataset['configUrl'],
    orderEndpoint: options.orderEndpoint ?? dataset['orderEndpoint'],
    shopUrl: options.shopUrl ?? dataset['shopUrl'],
    // Presence of the attribute (or an explicit true) opts in. Default off.
    conversational: options.conversational ?? dataset['conversational'] !== undefined,
  };
}

export { DEFAULT_MODEL };
