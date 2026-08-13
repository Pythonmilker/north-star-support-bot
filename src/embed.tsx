/**
 * The embed entry point — the only file the host page ever touches.
 *
 *   <script src="north-star-bot.js"></script>
 *
 * That's the whole integration. It works on a static site with no npm, no build, and no framework,
 * which is the entire design constraint. Everything (Preact included) is compiled into this bundle.
 *
 * We are a GUEST on someone else's page:
 *   - all markup lives inside a Shadow DOM, so their CSS can't reach in and ours can't leak out
 *   - one namespaced global, `window.NorthStarBot`
 *   - idempotent: including the script twice must not produce two widgets
 *   - if we throw, we throw quietly — a broken support widget must never break the client's site
 *
 * CONFIGURING A REAL SHOP. All optional; with none of it the bot still answers every question.
 *
 *   data-config-url      business data as JSON (policy, shipping, categories). A CMS plugs in here.
 *   data-order-endpoint  the shop's real order API. Without it, the bundled fixture data is used.
 *   data-returns-url     where "Start a return" points.
 *   data-proxy-url       server-side LLM proxy. THE SECURE OPTION: the key never enters the browser.
 *   data-api-key         an LLM key in the page. Readable by anyone with devtools. Rotate freely.
 */

import { render as preactRender } from 'preact';
import { App } from '@/ui/App';
import { styles } from '@/ui/styles';
import { resolveConfig, type InitOptions, type WidgetConfig } from '@/config';
import { configureStore, store, type StoreData } from '@/data/store';
import { createOpenRouterProvider } from '@/transport/openrouter';
import { createMockOrderProvider, createHttpOrderProvider, type OrderProvider } from '@/orders';
import type { IntentProvider } from '@/intent/types';

const MOUNTED_FLAG = '__northStarBotMounted';
const CONTAINER_ID = 'north-star-support-bot';

/** Grab our own <script> tag while it's still executing, so we can read its data-* attributes. */
const currentScript = document.currentScript as HTMLScriptElement | null;
const scriptDataset: DOMStringMap = currentScript?.dataset ?? {};

interface BotHandle {
  init(options?: InitOptions): void;
  destroy(): void;
}

function buildIntentProvider(config: WidgetConfig): IntentProvider | undefined {
  // No key and no proxy → no LLM. That is a supported, fully-working configuration: the orchestrator
  // simply runs on the deterministic matcher, which answers every verified question correctly.
  if (!config.apiKey && !config.proxyUrl) return undefined;
  return createOpenRouterProvider(config);
}

function buildOrderProvider(config: WidgetConfig): OrderProvider {
  return config.orderEndpoint
    ? createHttpOrderProvider(config.orderEndpoint)
    : createMockOrderProvider(store().orders);
}

/**
 * Load business data from the shop's config endpoint, if they named one.
 *
 * Deliberately fail-soft. A CMS being down must not take the support widget down with it: on any
 * failure the bot keeps running on its built-in data. Stale prices are a worse answer than live ones,
 * and an infinitely better one than a broken chat box on the shop's storefront.
 */
async function loadRemoteConfig(url: string): Promise<void> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as Partial<StoreData>;
    // configureStore validates every field: a config endpoint is not a trusted input.
    configureStore(data);
  } catch {
    // Keep the built-in data.
  }
}

function mount(options: InitOptions = {}): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[MOUNTED_FLAG]) return; // idempotent — a page that includes us twice still gets one widget
  w[MOUNTED_FLAG] = true;

  const config = resolveConfig(scriptDataset, options);

  // Inline data beats the built-in defaults; a config URL (fetched below) beats that in turn.
  if (options.data) configureStore(options.data);

  const host = document.createElement('div');
  host.id = CONTAINER_ID;
  // The host element itself is inert and unstyled; everything real happens inside the shadow root.
  (options.target ? (document.querySelector(options.target) ?? document.body) : document.body).appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = styles(config.accent);
  shadow.appendChild(styleEl);

  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);

  const draw = (cfg: WidgetConfig) => {
    preactRender(
      <App
        provider={buildIntentProvider(cfg)}
        orders={buildOrderProvider(cfg)}
        position={cfg.position}
        returnsUrl={cfg.returnsUrl}
        shopUrl={cfg.shopUrl}
        conversational={cfg.conversational}
      />,
      mountPoint,
    );
  };

  draw(config);

  // Render immediately from built-in data, then re-render if the shop's config arrives. A customer
  // never waits on a CMS round-trip to see a chat widget.
  if (config.configUrl) {
    void loadRemoteConfig(config.configUrl).then(() => draw(config));
  }
}

function safeMount(options?: InitOptions): void {
  try {
    mount(options);
  } catch (err) {
    // Never let our failure surface on the client's page. Log for us; stay silent for their users.
    // eslint-disable-next-line no-console
    console.error('[north-star-bot] failed to mount:', err);
  }
}

const handle: BotHandle = {
  init: (options) => safeMount(options),
  destroy: () => {
    document.getElementById(CONTAINER_ID)?.remove();
    (window as unknown as Record<string, unknown>)[MOUNTED_FLAG] = false;
  },
};

(window as unknown as Record<string, unknown>)['NorthStarBot'] = handle;

/**
 * Auto-mount unless the host page explicitly opted out with data-manual. A static site should get a
 * working widget from the script tag alone — but a page that wants to call init() with its own config
 * can still do so.
 *
 * The readyState guard matters: a <script> in <head> runs before <body> exists, so appending to
 * document.body would throw.
 */
if (scriptDataset['manual'] === undefined) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => safeMount(), { once: true });
  } else {
    safeMount();
  }
}
