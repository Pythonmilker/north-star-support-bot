/**
 * THE ANTI-DRIFT TEST *
 * This test exists because of a real regression found in this developer's own prior codebase:
 * a tool designed as `answer_faq({ topic })` shipped as `answer_faq({ topic, answer })`. One extra
 * field, and the LLM silently took ownership of the factual payload — exactly the failure this
 * deliverable is verified against.
 *
 * So we make it structurally impossible rather than merely forbidden. This test walks the JSON
 * Schema we hand the model and fails if ANY property could carry free text. If a future change
 * (mine, yours, or a well-meaning "let the model phrase it nicely" refactor) opens that door, the
 * build breaks here.
 */

import { describe, it, expect } from 'vitest';
import { CLASSIFICATION_JSON_SCHEMA, INTENTS, INTEREST_TAGS } from '@/intent/types';

type JsonSchemaNode = {
  type?: string;
  enum?: readonly unknown[];
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  required?: readonly string[];
};

/** Collect every string-typed leaf in the schema, with its path. */
function stringLeaves(node: JsonSchemaNode, path = '$'): Array<{ path: string; node: JsonSchemaNode }> {
  const found: Array<{ path: string; node: JsonSchemaNode }> = [];
  if (node.type === 'string') found.push({ path, node });
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...stringLeaves(child, `${path}.${key}`));
  }
  return found;
}

/** Collect every object node, with its path. */
function objectNodes(node: JsonSchemaNode, path = '$'): Array<{ path: string; node: JsonSchemaNode }> {
  const found: Array<{ path: string; node: JsonSchemaNode }> = [];
  if (node.type === 'object') found.push({ path, node });
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...objectNodes(child, `${path}.${key}`));
  }
  return found;
}

const schema = CLASSIFICATION_JSON_SCHEMA as unknown as JsonSchemaNode;

describe('the model cannot author customer-facing text', () => {
  it('every string field in the schema is constrained by an enum or a pattern', () => {
    const unconstrained = stringLeaves(schema)
      .filter(({ node }) => !node.enum && !node.pattern)
      .map(({ path }) => path);

    // A bare `{ type: 'string' }` anywhere is a hole the model can pour prose through.
    expect(
      unconstrained,
      `Unconstrained string field(s) found: ${unconstrained.join(', ')}. ` +
        `Every string the model emits must be an enum or a strict pattern — otherwise it can author a fact.`,
    ).toEqual([]);
  });

  it('has no field whose name suggests it carries prose', () => {
    const forbidden = ['answer', 'text', 'message', 'reply', 'response', 'content', 'summary', 'explanation'];
    const names = stringLeaves(schema).map(({ path }) => path.split('.').pop()!.toLowerCase());
    const offenders = names.filter((n) => forbidden.includes(n));

    expect(
      offenders,
      `Field(s) named ${offenders.join(', ')} would invite the model to write the answer. ` +
        `The renderer owns all customer-facing text — see src/answer/render.ts.`,
    ).toEqual([]);
  });

  it('forbids additional properties at every level, so the model cannot invent a field', () => {
    for (const { path, node } of objectNodes(schema)) {
      expect(node.additionalProperties, `${path} must set additionalProperties: false`).toBe(false);
    }
  });

  it('constrains intent to the closed set', () => {
    expect(schema.properties?.intent?.enum).toEqual([...INTENTS]);
  });

  it('constrains the recommendation interest to the closed tag set', () => {
    expect(schema.properties?.entities?.properties?.interest?.enum).toEqual([...INTEREST_TAGS]);
  });

  it('restricts orderId to digits only — never a status, never a sentence', () => {
    const orderId = schema.properties?.entities?.properties?.orderId;
    expect(orderId?.pattern).toBe('^[0-9]{1,10}$');
    expect(new RegExp(orderId!.pattern!).test('111')).toBe(true);
    expect(new RegExp(orderId!.pattern!).test('Shipped, arriving tomorrow')).toBe(false);
  });

  it('includes "unknown" so the model always has an honest way out', () => {
    // Without an explicit escape hatch, a classifier will force-fit an input into a wrong intent.
    expect(INTENTS).toContain('unknown');
  });
});
