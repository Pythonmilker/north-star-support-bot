/**
 * The OpenRouter model fallback chain. If the primary model is deprecated/down/rate-limited, OpenRouter
 * routes to the next one, so the LLM path survives a whole model going away — the keyword matcher stays
 * the floor beneath the chain. These tests pin the invariants that keep the chain safe and useful.
 */

import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MODELS,
  MAX_CHAIN_MODELS,
  MODEL_FALLBACKS,
  modelChain,
  buildClassificationBody,
  buildComposeBody,
} from '@/transport/protocol';

describe('the model fallback chain', () => {
  it('every fallback is in the proxy spend-allowlist (so it cannot bill an unexpected model)', () => {
    for (const m of MODEL_FALLBACKS) {
      expect(ALLOWED_MODELS as readonly string[]).toContain(m);
    }
  });

  it('puts the caller’s primary first, then the fallbacks, deduped', () => {
    expect(modelChain('anthropic/claude-haiku-4.5')).toEqual([
      'anthropic/claude-haiku-4.5',
      ...MODEL_FALLBACKS,
    ]);
    // A custom primary (data-model) still leads, and never appears twice.
    const chain = modelChain('openai/gpt-4o-mini');
    expect(chain[0]).toBe('openai/gpt-4o-mini');
    expect(chain.filter((m) => m === 'openai/gpt-4o-mini')).toHaveLength(1);
  });

  it('sends a models ARRAY (not a scalar model) in both request builders', () => {
    const cls = buildClassificationBody('anthropic/claude-haiku-4.5', 'hi');
    expect(Array.isArray(cls['models'])).toBe(true);
    expect(cls['model']).toBeUndefined();

    const comp = buildComposeBody('anthropic/claude-haiku-4.5', 'returns', 'how do returns work');
    expect(Array.isArray(comp['models'])).toBe(true);
    expect(comp['model']).toBeUndefined();
  });

  it('keeps temperature when every named chain model accepts it (the default chain does)', () => {
    // haiku-4.5 + gpt-4o-mini + gemini-2.5-flash accept temperature; openrouter/auto sits last, where
    // sending it is safe (a reject there can only end the chain, never abort an earlier model).
    expect(buildClassificationBody('anthropic/claude-haiku-4.5', 'hi')['temperature']).toBe(0);
  });

  it('omits temperature when the chain includes a model that rejects it', () => {
    // A sampling-param-rejecting primary poisons the whole chain's temperature (one param, all models).
    // Sending it would 400 on that model and NOT fall through, so it must be omitted entirely.
    const body = buildClassificationBody('anthropic/claude-sonnet-5', 'hi');
    expect(body['temperature']).toBeUndefined();
    expect((body['models'] as string[])[0]).toBe('anthropic/claude-sonnet-5');
  });

  it('never seeds the chain with a sampling-rejecting fallback (which would kill temperature for all)', () => {
    const REJECTS = /claude-(sonnet-5|opus-4\.7)/i;
    // openrouter/auto is exempt: its routing target is unknown, but it is safe because it is LAST.
    for (const m of MODEL_FALLBACKS) if (m !== 'openrouter/auto') expect(REJECTS.test(m)).toBe(false);
  });

  it('never sends more than 3 models — OpenRouter 400s on a longer array, killing the whole call', () => {
    // This exact bug shipped once: a 4-model chain 400'd ("'models' array must have 3 items or fewer")
    // on every classification, and graceful degradation hid it — the keyword matcher answered, tests
    // stayed green, and the LLM path was dead. A malformed-request 400 does not fall through.
    expect(MAX_CHAIN_MODELS).toBe(3);
    for (const primary of [
      'anthropic/claude-haiku-4.5',
      'openai/gpt-4o-mini',
      'openrouter/auto',
      'some/other-model',
    ]) {
      expect(modelChain(primary).length).toBeLessThanOrEqual(MAX_CHAIN_MODELS);
      expect((buildClassificationBody(primary, 'hi')['models'] as string[]).length).toBeLessThanOrEqual(
        MAX_CHAIN_MODELS,
      );
      expect((buildComposeBody(primary, 'returns', 'hi')['models'] as string[]).length).toBeLessThanOrEqual(
        MAX_CHAIN_MODELS,
      );
    }
  });

  it('ends the chain with the floating openrouter/auto router (the perpetual last resort)', () => {
    // A non-versioned router that never 404s, so the LLM path outlives every named model above it. Last
    // on purpose: best-effort, so a temperature/schema reject there drops to the keyword floor.
    expect(MODEL_FALLBACKS[MODEL_FALLBACKS.length - 1]).toBe('openrouter/auto');
    const chain = modelChain('anthropic/claude-haiku-4.5');
    expect(chain[chain.length - 1]).toBe('openrouter/auto');
  });
});
