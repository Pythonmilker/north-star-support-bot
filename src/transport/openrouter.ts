/**
 * The LLM transport — the model's *only* job is to classify.
 *
 * Two ways to reach it, and the difference is entirely about where the key lives:
 *
 *   DIRECT   browser -> OpenRouter, with the key in the page. Zero infrastructure. The key is readable
 *            by anyone who opens devtools — that is a property of the browser, not a bug we can fix.
 *   PROXIED  browser -> your proxy -> OpenRouter, key held server-side. The browser never sees it.
 *            See proxy/. This is the mode a real shop should run.
 *
 * Same code path either way; only the URL, the headers, and the request body change. Proxied requests
 * carry ONLY the customer's text — the server owns the prompt, the schema, and the model, which is what
 * stops the proxy from becoming a free LLM for anyone who reads the URL out of the page source.
 *
 * Every failure is typed, never swallowed. The orchestrator needs to tell "no key" from "rate limited"
 * from "offline" so it can drop to the rule matcher — the prior codebase turned all of these into a chat
 * bubble reading "System error", which destroys exactly the information a fallback needs.
 */

import {
  type ClassifyFailure,
  type ClassifyResult,
  type ComposePurpose,
  type ComposeResult,
  type IntentProvider,
} from '@/intent/types';
import {
  OPENROUTER_ENDPOINT,
  buildClassificationBody,
  buildComposeBody,
  parseClassification,
  parseCompose,
} from '@/transport/protocol';
import type { WidgetConfig } from '@/config';

const TIMEOUT_MS = 8000;

type ContentResult = { ok: true; content: string } | { ok: false; error: ClassifyFailure };

/**
 * One request to the model, direct or proxied, reduced to "the completion text, or a typed failure".
 * Both classify and compose share it, so the fallback semantics (every failure kind) are identical.
 */
async function callModel(config: WidgetConfig, body: Record<string, unknown>, proxyBody: Record<string, unknown>): Promise<ContentResult> {
  if (!config.apiKey && !config.proxyUrl) {
    return { ok: false, error: { kind: 'no_key' } };
  }

  // A support widget that hangs is worse than one that keyword-matches instantly.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const proxied = Boolean(config.proxyUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!proxied && config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(config.proxyUrl ?? OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers,
      signal: controller.signal,
      // Proxied: the minimal server-decided payload. Direct: the full request, since there's no server.
      body: JSON.stringify(proxied ? proxyBody : body),
    });

    if (response.status === 401 || response.status === 403) return { ok: false, error: { kind: 'no_key' } };
    // 402 = out of credit. For a disposable demo key that's an expected end-of-life, not a bug.
    if (response.status === 429 || response.status === 402) return { ok: false, error: { kind: 'rate_limited' } };
    if (!response.ok) return { ok: false, error: { kind: 'bad_response', detail: `HTTP ${response.status}` } };

    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: { kind: 'bad_response', detail: 'empty completion' } };
    return { ok: true, content };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, error: { kind: 'timeout' } };
    // fetch() rejects on network failure — offline, DNS, CORS, blocked by an extension.
    return { ok: false, error: { kind: 'offline' } };
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenRouterProvider(config: WidgetConfig): IntentProvider {
  return {
    name: 'llm',

    async classify(text: string, history?: readonly string[]): Promise<ClassifyResult> {
      // history rides the DIRECT body only. The proxy body stays {text} by design (the server owns the
      // prompt/schema); giving the proxy follow-up context is a real-deployment follow-up, not needed for
      // the direct/baked-key path the demo and reviewer run on.
      const res = await callModel(config, buildClassificationBody(config.model, text, history), { text });
      if (!res.ok) return res;

      const classification = parseClassification(res.content);
      if (!classification) {
        // The model ignored the schema and wrote prose. We refuse to guess — the caller drops to the
        // rule matcher, which is deterministic and correct.
        return { ok: false, error: { kind: 'bad_response', detail: 'unparseable classification' } };
      }
      return { ok: true, value: classification };
    },

    async compose(purpose: ComposePurpose, text: string, context?: string): Promise<ComposeResult> {
      // The proxy doesn't yet speak compose (it accepts only {text}); on a proxied deployment the widget
      // simply uses the deterministic renderer. On the direct/baked-key path (the demo), compose runs.
      if (config.proxyUrl) return { ok: false, error: { kind: 'offline' } };

      const res = await callModel(config, buildComposeBody(config.model, purpose, text, context), { mode: 'compose', purpose });
      if (!res.ok) return res;

      const message = parseCompose(res.content);
      if (!message) return { ok: false, error: { kind: 'bad_response', detail: 'unparseable compose' } };
      return { ok: true, value: message };
    },
  };
}
