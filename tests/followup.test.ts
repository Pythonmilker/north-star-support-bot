/**
 * Follow-up handling — the deterministic topic-carry.
 *
 * The reported bug: after the bot answers a topic, a short anaphoric follow-up ("how do I start
 * one?") lost all context, fell to the generic fallback, and a SECOND one escalated the customer
 * into a live-agent handoff. Every case here runs on the KEYWORD path (no provider) — the verified
 * keyless floor, and also exactly what the LLM path degrades to for these context-dependent
 * fragments (the model returns `unknown` with no history, so the carry catches both paths).
 *
 * The carry is deliberately conservative: it only ever RE-ANSWERS the immediately preceding
 * returns/shipping topic (a static, verbatim, idempotent reply), and only for a short anaphoric
 * message. A genuinely new or garbage turn still falls back and, if repeated, still escalates — the
 * fallback→handoff trigger the brief requires stays intact.
 */

import { describe, it, expect } from 'vitest';
import { handleTurn, initialState, type ConversationState, type Turn } from '@/orchestrator';
import { RETURN_POLICY, SHIPPING } from '@/data/store';

/** Replay a conversation on the rule path (no LLM), threading state like the UI does. */
async function converse(inputs: string[]) {
  let state: ConversationState = initialState;
  const turns: Turn[] = [];
  for (const input of inputs) {
    const t = await handleTurn(input, state);
    state = t.state;
    turns.push(t);
  }
  return { turns, replies: turns.map((t) => t.answer.text), state };
}

const hasFullReturnPolicy = (text: string) =>
  text.includes(RETURN_POLICY.window) &&
  text.includes(RETURN_POLICY.condition) &&
  text.includes(RETURN_POLICY.packaging);

describe('1. the reported reproduction: returns → two follow-ups no longer strands the customer', () => {
  it('"how do I start one?" after the return policy re-answers returns, not the fallback', async () => {
    const { turns, replies } = await converse(['what is your return policy?', 'how do I start one?']);
    // Turn 1 gave the policy…
    expect(hasFullReturnPolicy(replies[0]!)).toBe(true);
    // …and the anaphoric follow-up continues that topic instead of "I didn't catch that".
    expect(hasFullReturnPolicy(replies[1]!)).toBe(true);
    expect(replies[1]!).not.toMatch(/didn'?t (quite )?(catch|get|follow)|not sure/i);
    // It keeps the actionable link, and does NOT escalate.
    expect(turns[1]!.answer.link?.label).toBe('Start a return');
    expect(turns[1]!.state.mode).toBe('normal');
  });

  it('a SECOND follow-up ("is there a form to fill out?") also carries — and never escalates', async () => {
    const { turns, replies } = await converse([
      'what is your return policy?',
      'how do I start one?',
      'is there a form to fill out?',
    ]);
    expect(hasFullReturnPolicy(replies[2]!)).toBe(true);
    // The exact previous behaviour was: turn 2 fallback, turn 3 ESCALATE to live agent. Both gone.
    expect(turns[2]!.state.mode).toBe('normal');
    expect(turns.every((t) => t.state.mode !== 'live_agent')).toBe(true);
  });

  it('carries verbatim — the follow-up answer reproduces the policy byte-for-byte', async () => {
    const { replies } = await converse(['returns?', 'what about it?']);
    for (const line of [RETURN_POLICY.window, RETURN_POLICY.condition, RETURN_POLICY.packaging]) {
      expect(replies[1]!).toContain(line);
    }
  });
});

describe('2. shipping follow-ups carry too', () => {
  it('an anaphoric follow-up after shipping re-shows both tiers verbatim', async () => {
    const { replies } = await converse(['how does shipping work?', 'what about that?']);
    expect(replies[0]).toContain(SHIPPING.standard);
    expect(replies[1]).toContain(SHIPPING.standard);
    expect(replies[1]).toContain(SHIPPING.expedited);
  });
});

describe('3. the carry never mis-routes or masks a real fallback', () => {
  it('a follow-up that names a DIFFERENT topic is classified normally, not carried', async () => {
    // "how much is expedited?" matches the shipping intent, so it's never `unknown` → never carried
    // as a returns follow-up. The customer gets shipping, not the return policy re-dumped.
    const { replies } = await converse(['what is your return policy?', 'how much is expedited?']);
    expect(replies[1]).toContain(SHIPPING.expedited);
    expect(hasFullReturnPolicy(replies[1]!)).toBe(false);
  });

  it('two genuinely-unrecognised messages after a topic STILL escalate (fallback→handoff intact)', async () => {
    const { turns } = await converse([
      'what is your return policy?',
      'do you have a store in Denver',
      'what is the weather like there',
    ]);
    // Neither is a follow-up shape, so neither carries; the required escalation still fires.
    expect(turns[2]!.state.mode).toBe('live_agent');
  });

  it('a lone non-follow-up miss after a topic falls back (menu), and does not escalate on its own', async () => {
    const { turns } = await converse(['what is your return policy?', 'do you ship to antarctica']);
    expect(turns[1]!.state.mode).toBe('normal');
    expect(turns[1]!.answer.showMenu).toBe(true);
  });
});

describe('4. the carried topic never survives a change of subject', () => {
  it('"menu" clears the topic — a later anaphoric miss falls back, not carries', async () => {
    const { replies } = await converse(['what is your return policy?', 'menu', 'how do I start one?']);
    expect(hasFullReturnPolicy(replies[2]!)).toBe(false);
  });

  it('an intervening order lookup drops the returns topic', async () => {
    const { replies } = await converse(['what is your return policy?', 'order 111', 'what about it?']);
    // The topic is now the order, not returns — the returns policy is NOT re-dumped.
    expect(hasFullReturnPolicy(replies[2]!)).toBe(false);
  });

  it('a recommendation is never a carry target (no SKU/price hazard)', async () => {
    // Recommendation follow-ups are handled by recommendedInterest, never by the topic-carry — so a
    // vague "which one is best?" after a category does not re-run through the returns/shipping carry.
    const { replies } = await converse(['recommend a tent', 'cold and wet', 'which one is best?']);
    expect(hasFullReturnPolicy(replies[2]!)).toBe(false);
    expect(replies[2]).not.toContain(SHIPPING.standard);
  });
});

describe('5. the carry resets the fallback streak (so a real continuation never nudges toward handoff)', () => {
  it('returns → carry → one genuine miss shows the menu, it does NOT escalate', async () => {
    const { turns } = await converse([
      'what is your return policy?', // topic set
      'how do I start one?', // carries → streak reset
      'zxcvbnm', // one genuine miss → menu (streak 1), NOT escalation
    ]);
    expect(turns[2]!.state.mode).toBe('normal');
    expect(turns[2]!.answer.showMenu).toBe(true);
  });
});
