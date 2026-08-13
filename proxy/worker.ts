/**
 * The LLM proxy — the deployment mode where the API key never enters the browser.
 *
 * A key in the page is readable. That is not a bug in this widget, it is how browsers work: any key the
 * page can use, the page's reader can copy. Rotating it is easy (see README), but rotating a key is not
 * the same as protecting it. If you want it protected, it has to live somewhere the customer's browser
 * cannot reach. That is this file.
 *
 *   browser  --{ "text": "where is order 111" }-->  worker  --{ full request + key }-->  OpenRouter
 *
 * THE MISTAKE THIS FILE EXISTS TO AVOID. The obvious proxy just forwards whatever the browser posts and
 * bolts the key on. That doesn't protect anything — it converts your key into a free, public, unmetered
 * LLM endpoint for anyone who reads the URL out of your page source. It is worse than the key being
 * public, because now the abuse is invisible to you and billed to you.
 *
 * So this proxy accepts ONE field: the customer's text. The prompt, the schema, the model, and the token
 * limit are all decided here, on the server, from `protocol.ts`. There is no field a caller can set that
 * changes what we ask the model. The worst an abuser can do with a stolen proxy URL is classify their own
 * sentences into one of six support intents, at your expense, rate-limited, from an origin you allowed.
 *
 * Four controls, in order of how much work they do:
 *
 *   1. Server-owned request     the proxy cannot be repurposed as a general LLM. This is the big one.
 *   2. Origin pin               other people's websites can't call it. Fails CLOSED: no config, no service.
 *   3. Spend cap on the key     set it at OpenRouter. This is your real, authoritative ceiling.
 *   4. Rate limit               see the note on it below; it is a speed bump, not a wall.
 *
 * Deploy: see proxy/README.md. It is one `wrangler deploy` and one `wrangler secret put`.
 */

import { OPENROUTER_ENDPOINT, MAX_INPUT_CHARS, ALLOWED_MODELS, buildClassificationBody } from '../src/transport/protocol';

export interface Env {
  /** `wrangler secret put OPENROUTER_API_KEY`. Never in wrangler.toml, never in git. */
  OPENROUTER_API_KEY: string;
  /** Comma-separated origins allowed to call this proxy, e.g. "https://northstar.example". */
  ALLOWED_ORIGINS: string;
  /** Optional. Must be one of ALLOWED_MODELS; anything else falls back to the default. */
  MODEL?: string;
}

const DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

/** Per-IP requests allowed in the window below. A support chat is a human typing; this is generous. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * A deliberately simple limiter, and an honest note about it.
 *
 * This Map lives in the Worker isolate, and Cloudflare runs many isolates. So the effective limit is
 * "RATE_LIMIT per IP per isolate", not a strict global — a determined attacker spraying across edge
 * locations gets more than 30/min. It is a speed bump against the realistic case (one script hammering
 * one endpoint), not a wall against a distributed one.
 *
 * The wall is control #3: the hard monthly spend cap on the OpenRouter key. That is the number that
 * actually bounds your loss, and it is the one to get right. If you want a strict distributed limit here
 * too, bind Cloudflare's rate-limiting product or a Durable Object — but do not skip the spend cap and
 * assume this Map is protecting you. It isn't, and pretending otherwise is how people get a surprise bill.
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Keep the Map from growing without bound across a long-lived isolate.
  if (hits.size > 10_000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }

  return recent.length > RATE_LIMIT;
}

/**
 * Exact-match the Origin against the allowlist. No wildcards, no suffix matching: `endsWith('.example.com')`
 * is a classic hole, because `evil-example.com` ends with it too.
 *
 * Fails closed. If ALLOWED_ORIGINS is unset, nothing is allowed — an unconfigured security control must
 * not silently degrade into an open one.
 */
function allowedOrigin(origin: string | null, env: Env): string | undefined {
  if (!origin) return undefined;
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : undefined;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    // Caches must not serve one origin's CORS response to another origin.
    Vary: 'Origin',
  };
}

/** Errors carry no CORS headers on purpose: a disallowed origin should learn nothing from the response. */
function deny(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pickModel(env: Env): string {
  const requested = env.MODEL;
  return requested && (ALLOWED_MODELS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_MODEL;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get('Origin'), env);
    if (!origin) return deny(403, 'origin not allowed');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return deny(405, 'method not allowed');
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (rateLimited(ip, Date.now())) {
      // 429 is the code the widget reads as "degrade to the keyword matcher". The customer still gets
      // a correct answer; they just get it from rules instead of the model.
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }

    let text: unknown;
    try {
      text = ((await request.json()) as { text?: unknown }).text;
    } catch {
      return deny(400, 'invalid json');
    }
    if (typeof text !== 'string' || !text.trim()) {
      return deny(400, 'text required');
    }
    if (text.length > MAX_INPUT_CHARS) {
      // Past this it isn't a support question, it's someone using your key as a compute budget.
      return deny(413, 'text too long');
    }

    // Everything below is decided HERE, not by the caller. `text` is the only thing they contributed.
    const upstream = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(buildClassificationBody(pickModel(env), text)),
    });

    // Pass OpenRouter's response through untouched, so the widget parses proxied and direct replies with
    // exactly the same code. Note what is NOT forwarded: upstream headers. Those can carry rate-limit and
    // account metadata we have no business handing to a browser.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  },
};
