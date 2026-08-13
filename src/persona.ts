/**
 * Brand persona as CODE, not as a prompt.
 *
 * The brief checks tone: "friendly, helpful, outdoorsy, concise" for North American outdoor
 * consumers. The obvious move is to put that in a system prompt — but our model only ever emits a
 * classification, never prose. So the voice lives here, in the phrasebook the renderer draws from.
 *
 * This is strictly better than a prompt: the voice is identical whether the LLM is answering, the
 * rule-matcher is answering, or the network is down. A prompt-based persona simply vanishes on the
 * fallback path (which is exactly what happens in the prior codebase).
 *
 * ── VARIETY WITHOUT GENERATION ─────────────────────────────────────────────────────────────────
 * A phrasebook with exactly one string per branch reads like a recording — the same sentence every
 * time. So the FACT-FREE wrapper copy (leads, acknowledgements, fallbacks, closings) is now a POOL of
 * hand-written on-brand variants, and the renderer picks one deterministically from a per-turn seed.
 *
 * The line is drawn at one question: does a verified or business fact live in this string? If yes, it
 * stays a single verbatim value that code prints byte-for-byte (statuses, policy, shipping, category
 * names). If no, it may vary. Variety lives entirely in the fact-free garnish; the facts never move.
 * Because selection is deterministic (a pure function of the seed), every variant is still testable.
 */

/** Fact-free warm lead-ins for the order-status reply, by status class. Never assert a fact — the
 *  verbatim status is printed on its own line right below. No digits, no logistics claims. */
export const ORDER_LEADS = {
  shipped: ['Good news!', 'Great news —', "Here's the latest:"],
  processing: ['Hang tight —', "Here's where things stand:", 'On it —'],
  delivered: ['All done!', "That one's wrapped up —", 'Great news —'],
  /** Any status a real order API returns that we can't classify. Warm but neutral. */
  neutral: ["Here's the latest on that one:", 'Got it —', 'Sure thing —'],
} as const;

export type OrderLeadClass = keyof typeof ORDER_LEADS;

export const PERSONA = {
  name: 'North Star Support Bot',

  greeting:
    "Hey there — North Star Support Bot here. I can track an order, sort out a return, talk shipping, or help you find the right gear. What do you need?",

  /** Shown as the menu of things the bot can actually do. Doubles as the fallback's escape hatch. */
  menu: [
    'Track an order',
    'Returns & exchanges',
    'Shipping info',
    'Find the right gear',
    'Talk to a human',
  ] as const,

  /**
   * Fallback pool. The brief requires a clear "I didn't understand" AND options or escalation. Every
   * variant does both: it plainly signals non-understanding and points at the menu / a live agent.
   */
  didNotUnderstandVariants: [
    "Sorry — I didn't quite catch that. I can help with any of these, or hand you to a live agent:",
    "Hmm, I didn't quite get that one. Here's what I can help with, or I can pass you to a live agent:",
    "I'm not sure I followed. I can help with any of these, or hand you to a live agent:",
  ] as const,

  /** Said when repeated misses trigger the fallback route into the Live Agent state. */
  escalatingAfterFallback:
    "Sorry, I'm still not following — let me get you to someone who can help properly.",

  /** Handoff copy. The brief requires the handoff be clearly communicated — kept single and stable. */
  handoffIntro:
    "You're being connected to a live agent — hang tight, someone from the North Star crew will be right with you.",

  /** The handoff must never be a dead end: the brief requires a route back. */
  handoffReturn:
    "While you wait, I'm still here — say \"menu\" any time to head back and keep going with me.",

  liveAgentBadge: 'Live Agent',

  /** Order-tracking flow. */
  askOrderNumber: "Sure thing — what's your order number?",

  /**
   * The verbatim status line. The verified status string is printed UNCHANGED here; a warm lead sits on
   * the line above it (see ORDER_LEADS). Labelled "Status:" so the provided data is unmistakable even
   * with the friendly lead-in — accuracy stays front and centre.
   */
  orderLine: (orderId: string, status: string) => `Order #${orderId} — Status: ${status}`,

  invalidOrder:
    "I can't find an order with that number. Double-check the digits for me, or I can pass you to a live agent.",

  /**
   * The shop's order system did not answer. Deliberately NOT the same as "no such order", and
   * deliberately not a fallback to bundled data: telling a customer their real order shipped, on the
   * strength of a fixture, is worse than admitting we cannot check.
   */
  orderLookupFailed:
    "I can't reach our order system right now, so I don't want to guess at your status. Let me get you to a live agent who can look it up properly.",

  /** Recommendation flow — the clarifying questions are kept single/stable (they drive the state machine). */
  recommendOpener: 'Happy to help you gear up. What are you heading out to do?',
  recommendFollowUp: 'Got it — and what conditions are you expecting out there?',

  /**
   * The clarifying questions ran but nothing matched a category we carry (e.g. a customer asking about
   * a canoe — we sell camping/hiking gear, not watercraft). Be HONEST — "we don't carry that", not the
   * generic "I didn't understand" — and signpost what we DO carry so it's a helpful pointer, not a
   * dead end. The category list is pulled live from store(), so it always reflects the real catalogue.
   */
  recommendNoMatchIntro: [
    "I'm not finding the right fit in our gear for that. Here's what we carry:",
    "Hmm — that's not quite in our lineup, but here's what we do carry:",
  ] as const,
  recommendNoMatchOutro: 'Tell me which sounds closest, or I can connect you to a live agent.',
  /** Result wrapper pool. Every variant carries the verbatim ${category} — only the framing varies. */
  recommendResultVariants: [
    (category: string) =>
      `Based on that, I'd point you at our ${category} — that's the right shelf for what you're planning.`,
    (category: string) => `For that, our ${category} is where I'd start you off.`,
    (category: string) => `Sounds like our ${category} is your best bet — that's where I'd look first.`,
  ] as const,

  /** Returns flow. The opener is fact-free garnish; the three policy bullets below it are verbatim. */
  returnsOpeners: [
    'Here’s how returns work with us:',
    'Easy — here’s the returns rundown:',
    'Sure thing. Our return policy in a nutshell:',
  ] as const,
  returnsLinkLabel: 'Start a return here:',
  exchangesNote:
    'Exchanges follow the same policy — same 30-day window, unused, in the original packaging.',

  /**
   * When the customer is asking whether THEIR specific situation qualifies (a lost box, a used item, past
   * the window, "will you honor it?"), we don't decide their case — we can't promise an outcome the policy
   * might not allow. We lay out the conditions plainly and hand the judgement call to a human. Honest, and
   * a real way forward instead of a bare policy dump.
   */
  returnsEligibilityIntro: 'Happy to help you sort this out. A return needs to meet all three of these:',
  returnsEligibilityOutro:
    'If your situation doesn\'t quite line up with those, just say "live agent" and I\'ll connect you with someone who can take a closer look at your case.',

  /** Shipping. Opener is garnish; the tier lines below are verbatim. */
  shippingOpeners: [
    'Here are our shipping options:',
    'Here’s how our shipping shakes out:',
    'We keep shipping simple:',
  ] as const,

  /**
   * Shipping can't promise a delivery DATE — we don't know when an order was placed, and a static widget
   * has no live carrier data. So for anything beyond the two standard timeframes (a specific date, a rush,
   * a guarantee), we give the timeframes and hand off to a human rather than guess.
   */
  shippingHumanOffer:
    'For a specific delivery date or anything more particular, a live agent can help — just say "live agent".',

  /** A goodbye or thank-you pool. Warm, brief, and always leaves the door open — never a dead stop. */
  closingVariants: [
    "Anytime — glad I could help. I'm right here if anything else comes up. Happy trails!",
    "You bet! I'm right here if you need anything else. Take care out there!",
    "Happy to help. Give me a shout any time — safe travels!",
  ] as const,
} as const;
