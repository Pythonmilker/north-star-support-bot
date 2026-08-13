/**
 * Conversational memory — the bot carries a little context across turns so it doesn't feel forgetful:
 *   1. the last order number, so "where's my order?" needn't re-ask for a number just given;
 *   2. that it already ran the clarifying questions, so a repeat gear ask doesn't re-interrogate.
 *
 * Memory is sticky but resets on "menu". And — the sanity check the requirement demands — memory only
 * RE-USES what already exists (provided order data; documented category tags). It never invents new data
 * and never upgrades a category into a specific product or price.
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState, type ConversationState } from '@/orchestrator';
import { ORDER_STATUS, PRODUCT_CATEGORIES } from '@/data/store';

/** Replay a conversation on the rule path (no LLM), threading state like the UI does. */
async function converse(inputs: string[]) {
  let state: ConversationState = initialState;
  const replies: string[] = [];
  for (const input of inputs) {
    const t = await handleTurn(input, state);
    state = t.state;
    replies.push(t.answer.text);
  }
  return { replies, state };
}

describe('1. remembers the last order number', () => {
  it('answers "where\'s my order?" with the number already given, instead of re-asking', async () => {
    const { replies } = await converse(['where is my order 111', "where's my order?"]);
    expect(replies[0]).toContain(ORDER_STATUS['111']);
    // The second turn gave no number, but it re-uses #111 rather than asking "what's your order number?".
    expect(replies[1]).toContain(ORDER_STATUS['111']);
    expect(replies[1]).not.toMatch(/what'?s your order number/i);
  });

  it('still asks for a number when none was ever given', async () => {
    const { replies } = await converse(['track my order']);
    expect(replies[0]).toMatch(/order number/i);
  });

  it('does NOT remember an invalid order number (so it never re-uses a typo)', async () => {
    const { replies } = await converse(['order 999', "where's my order?"]);
    // #999 is invalid → not remembered → the follow-up asks for a number rather than re-showing "invalid".
    expect(replies[1]).toMatch(/order number/i);
  });

  it('"menu" clears the remembered order (a fresh conversation asks again)', async () => {
    const { replies } = await converse(['order 111', 'menu', "where's my order?"]);
    expect(replies[2]).toMatch(/order number/i);
  });
});

describe('2. does not re-interrogate on a repeat recommendation', () => {
  it('asks the clarifying questions the FIRST time, then recommends directly on a repeat', async () => {
    const { replies } = await converse([
      'recommend a tent', // Q1
      'cold and wet', // → recommends Tents & Shelters, remembers it
      'what about hiking boots?', // repeat ask — should NOT re-interrogate
    ]);
    expect(replies[0]).toMatch(/conditions|heading out/i); // first pass DID ask
    expect(replies[1]).toContain(PRODUCT_CATEGORIES.shelter); // first recommendation
    // The repeat goes straight to a category, no clarifying question.
    expect(replies[2]).toContain(PRODUCT_CATEGORIES.footwear);
    expect(replies[2]).not.toMatch(/what conditions|heading out to do/i);
  });

  it('"menu" resets, so the next recommendation asks its questions again', async () => {
    const { replies } = await converse([
      'recommend a tent',
      'cold and wet', // recommends, remembers
      'menu',
      'recommend a jacket', // fresh session → must ask again
    ]);
    expect(replies[3]).toMatch(/conditions|heading out/i);
  });
});

describe('3. sanity: memory never crosses the invented-data line', () => {
  it('a remembered recommendation is still a CATEGORY, never a specific product or price', async () => {
    const { replies } = await converse(['recommend a tent', 'cold and wet', 'what about boots']);
    const repeat = replies[2]!;
    // It names one of the documented category tags…
    expect(Object.values(PRODUCT_CATEGORIES).some((c) => repeat.includes(c))).toBe(true);
    // …and never a fabricated SKU, model name, or price.
    expect(repeat).not.toMatch(/\$\d|\bmodel\b|\bSKU\b|\bversion\b/i);
    expect(repeat).not.toMatch(/\d/); // no numbers at all in a deterministic recommendation
  });

  it('order memory only ever re-shows PROVIDED status data, verbatim', async () => {
    const { replies } = await converse(['order 222', "where's my order?"]);
    // Both the original and the remembered answer are the exact provided status — nothing invented.
    expect(replies[0]).toContain(ORDER_STATUS['222']);
    expect(replies[1]).toContain(ORDER_STATUS['222']);
  });
});
