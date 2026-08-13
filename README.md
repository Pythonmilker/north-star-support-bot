# North Star Support Bot

North Star Support Bot is an embeddable chat widget for an outdoor and camping gear store. It tracks orders, explains returns and shipping, recommends a product category, and hands off to a live agent, following the conversation across turns. It loads from one `<script>` tag and needs no backend.

It builds to 62 kB, 23 kB gzipped.

## Try it

```bash
pnpm install
pnpm build
```

Then open `demo/index.html` in a browser. The launcher is in the bottom-right corner.

No key is needed. The bot answers from its keyword matcher, which handles every flow below on its own. Add an OpenRouter key (see [The API key](#the-api-key)) and a model reads free-form phrasing instead.

The demo's script tag also carries `data-conversational`, so with a key the model writes the reply as prose rather than picking a template. It still never writes a business fact: those are `{{SLOT}}` tokens it emits, and `src/answer/compose.ts` substitutes the verbatim value afterward, discarding the whole reply if anything fails to resolve. Without a key that layer is inert and the deterministic renderer answers. Facts are byte-identical either way.

Type any of these:

- `where's my order 111` returns `Order #111 — Status: Shipped, arriving tomorrow`. Also try `222`, `333`, and an unknown number.
- `what's your return policy` gives the 30-day, unused, original-packaging policy and a Start a return button.
- `how do I start one` right after it stays on returns, following the thread.
- `how long does shipping take` gives standard (3-5 business days) and expedited (1-2 business days).
- `can you recommend a tent` asks a clarifying question or two, then names a product category with a Shop button.
- `do you sell canoes` names the categories the store carries.
- `get me a live agent`, then `menu`, enters the simulated live-agent state with a way back.

The facts (order statuses, return policy, shipping times, category names) are byte-for-byte the store's data; only the phrasing around them varies, and `tests/verbatim.test.ts` checks that.

## Embedding

```html
<script src="north-star-bot.js"></script>
```

One tag, on any page: a static site, WordPress, anywhere. The widget renders inside a Shadow DOM, isolated from the host page's styles. Every setting is an optional attribute:

```html
<script src="north-star-bot.js"
        data-returns-url="https://yourstore.com/returns"
        data-shop-url="https://yourstore.com/shop"
        data-config-url="https://yourstore.com/bot-config.json"
        data-order-endpoint="https://yourstore.com/api/orders"
        data-conversational
        data-position="bottom-left"
        data-accent="#1e6e4e"></script>
```

| Attribute | Sets | Default |
|---|---|---|
| `data-returns-url` | the Start a return button's URL | `example.com` |
| `data-shop-url` | the Shop button's URL on a recommendation | none |
| `data-config-url` | the store's data as JSON (see [Changing the data](#changing-the-data)) | built-in data |
| `data-order-endpoint` | the order API, `GET ?order=111` returning `{"status":"..."}` | the three demo orders |
| `data-conversational` | the generative voice, which needs a key | off |
| `data-position` | `bottom-right` or `bottom-left` | `bottom-right` |
| `data-accent` | the launcher and header color | `#1e6e4e` |
| `data-api-key`, `data-proxy-url` | the LLM key, or a proxy for it (see [The API key](#the-api-key)) | none |

To mount it yourself, add `data-manual` and call `NorthStarBot.init({ target: '#support' })`.

## Changing the data

The store's data is configuration. Point `data-config-url` at a JSON file shaped like `StoreData` in `src/data/store.ts`:

```json
{
  "returnPolicy": { "window": "14-day returns" },
  "shipping": { "expedited": "Expedited shipping: next business day" }
}
```

Order statuses, the return policy, shipping times, categories, and the returns URL are each overridable, and a field you leave out keeps its default. Change a value, reload, and the bot says the new one, with no rebuild. For live order lookups, set `data-order-endpoint` to the store's order API. If a config URL is unreachable the bot keeps serving its built-in data; if an order lookup fails it offers a live agent.

## Building from source

You need this to change the widget's behavior: its voice (`src/persona.ts`), the phrasings its keyword matcher recognizes (`src/intent/rules.ts`), the conversation logic (`src/orchestrator.ts`), or the UI (`src/ui/`). The data and the key are configuration (above), so changing either takes no rebuild.

Requires Node 18+ and **pnpm 11+** (pnpm 10 skips esbuild's install step; both are pinned in `package.json`).

```bash
pnpm install
pnpm build      # tsc --noEmit, then vite build
pnpm test       # 363 tests, plus 10 live-key checks (LIVE_LLM=1)
```

## The API key

The generative voice calls OpenRouter, so it needs a key. Set it on the script tag with `data-api-key`, in a sibling `<script>` as `window.NorthStarBotConfig = { apiKey: '...' }`, or via `NorthStarBot.init({ apiKey })`. Any of the three works; no key ships in this repo.

A key in the page is visible to anyone who opens devtools, so use a spend-capped, disposable one. To keep the key off the page, deploy `proxy/` (a small Cloudflare Worker) and point `data-proxy-url` at it; the browser then holds no key. Either way, if the key or proxy is unavailable the bot answers from its keyword matcher. `tests/no-secrets.test.ts` keeps credentials out of the source tree.

The model is `anthropic/claude-haiku-4.5` (about $0.0005 a message; override with `data-model`), backed by `openai/gpt-4o-mini` and then `openrouter/auto`, a floating router that keeps the LLM working as individual models are retired. OpenRouter accepts three models per request, so the chain is capped at three. The keyword matcher is the floor beneath all of them.

## Commands

```
pnpm install      install dependencies
pnpm build        write dist/north-star-bot.js
pnpm test         run the suite (363 tests; 10 live-key checks need LIVE_LLM=1)
pnpm typecheck    tsc --noEmit, strict
pnpm dev          vite dev server
```

## Project layout

```
src/
  data/store.ts            business data and the site owner's overrides
  answer/render.ts         the module that emits deterministic text
  answer/compose.ts        the generative layer, fills {{SLOT}} tokens or falls back
  config.ts                runtime config and key resolution
  intent/types.ts          intent enum and the classifier's output schema
  intent/rules.ts          keyword matcher, used whenever there is no key
  orders/index.ts          order lookup, mock data or the store's API
  transport/protocol.ts    prompt and schema, shared by the widget and the proxy
  transport/openrouter.ts  the LLM call, every failure typed
  orchestrator.ts          conversation state, memory, and the fallback chain
  persona.ts               brand voice, kept in code
  ui/                       Preact panel, styles injected into the shadow root
  embed.tsx                script-tag entry point
proxy/worker.ts            optional server that keeps the key out of the browser
demo/index.html            storefront that hosts the widget, open this one
demo/isolation-test.html   the same widget on a hostile page, a Shadow DOM proof
demo/returns.html          the returns page the widget links to
tests/                     363 tests
```

## Known limitations

- The returns URL and the product categories are the two values the store's spec requires but does not supply. Both are marked `ASSUMPTION` in `src/data/store.ts`: the returns URL defaults to `example.com` (set `data-returns-url` to the store's real page), and the six categories are subdivisions of "outdoor apparel and camping gear". Everything else in `store.ts` is transcribed from the store's data and checked by `tests/verbatim.test.ts`.
- Order data is the three demo orders unless `data-order-endpoint` is set.
- The live-agent state is simulated; there is no ticketing or chat backend behind it.
- Model IDs are current names that vendors retire over time. They are configuration (`data-model` and the list in `src/transport/protocol.ts`), and `openrouter/auto` plus the keyword matcher keep the bot answering in the meantime.
- The widget needs Shadow DOM, so it does not run in IE11 (unsupported since 2022). On a browser without it, the launcher does not appear and the rest of the page is untouched.

## How it works

The model reads each message and picks an intent; the code writes the answer from the data in `src/data/store.ts`, so the business facts are always exact. With `data-conversational`, the model phrases the reply and the code fills the facts into it. Order status and the live-agent handoff are always written by code. On any network or key failure, the keyword matcher answers.
