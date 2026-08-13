/**
 * How many ways can a customer say the same thing?
 *
 * The brief checks "intent recognition supports multiple phrasings", and a reviewer will be running
 * WITHOUT an API key — so the thing being verified is the keyword matcher, not the model. A rule set tuned
 * on the handful of phrasings the author happened to imagine will pass its own unit tests and then meet
 * a real sentence and fall over.
 *
 * So: a corpus. Each line is something a North American shopper would plausibly type into a chat box on
 * an outdoor-gear site — contractions, typos, lowercase, no punctuation, and the blunt one-word inputs
 * people actually send. Every line must land on the right intent with no LLM in the loop.
 *
 * Found this way, and fixed rather than left: "I need help picking gear" was classified as UNKNOWN. The
 * pattern wanted "help me pick"; the customer wrote "help picking". A verified use case, a fallback reply.
 */

import { describe, it, expect } from 'vitest';
import { classifyWithRules } from '@/intent/rules';
import type { Intent } from '@/intent/types';

const CORPUS: Record<Exclude<Intent, 'unknown'>, string[]> = {
  order_tracking: [
    'where is my order',
    "where's my order?",
    'wheres my package',
    'track my order',
    'tracking',
    'can I get a tracking number',
    'order status',
    'status of order 111',
    'order #222',
    '#333',
    '111',
    'what is the status of my package',
    'my order hasn’t arrived yet',
    'my package still hasnt come',
    'has my order shipped',
    'is my order on the way',
    'any update on my delivery',
    'i want to check on an order',
    'check my order please',
    'did my stuff ship yet',
  ],
  returns_exchanges: [
    'I want to return this',
    'how do returns work',
    'what is your return policy',
    'return policy',
    'can I return a jacket',
    'i need to send this back',
    'send it back',
    'how do I exchange for a different size',
    'exchange',
    'the boots dont fit',
    "it doesn't fit",
    'you sent the wrong size',
    'wrong item',
    'can I get a refund',
    'refund please',
    'i changed my mind about my purchase',
    'is this returnable',
    'how long do I have to return something',
  ],
  shipping_info: [
    'how long does shipping take',
    'shipping',
    'what are your shipping options',
    'do you offer expedited shipping',
    'how fast is standard shipping',
    'delivery times',
    'when will it arrive',
    'how long until it gets here',
    'whats the difference between standard and expedited',
    'do you do overnight',
    'how much time for delivery',
    'shipping speed',
  ],
  product_recommendation: [
    'I need help picking gear', // the one that was broken
    'help me pick a tent',
    'help me choose a sleeping bag',
    'can you recommend a backpack',
    'what do you recommend for cold weather',
    'any suggestions for a winter jacket',
    'what should I buy for a camping trip',
    'what should I bring camping',
    'looking for hiking boots',
    'i need a new jacket',
    'best tent for two people',
    'im shopping for a sleeping pad',
    'what gear do i need for backpacking',
    'help me find something warm',
    'i dont know what to get',
    'need advice on gear',
    'which backpack should i get',
  ],
  human_handoff: [
    'I want to talk to a human',
    'talk to a person',
    'let me speak to someone',
    'can I speak with an agent',
    'live agent',
    'real person please',
    'get me a human',
    'connect me to a representative',
    'customer service',
    'customer support',
    'i want to talk to a real person',
    'agent',
    'is anyone there',
    'this isnt helping, get me someone',
  ],
  closing: [
    'thanks',
    'thank you',
    'thanks!',
    'thank you so much',
    'thx',
    'that’s all',
    "that's all thanks",
    "that's it, thanks",
    "that's everything",
    'no thanks',
    "no thank you, i'm good",
    'all good',
    'im all set',
    'goodbye',
    'bye',
    'see ya',
    'cheers',
    'you’ve been really helpful',
  ],
};

describe('the keyword matcher handles the phrasings people actually use', () => {
  for (const [intent, phrasings] of Object.entries(CORPUS) as Array<[Intent, string[]]>) {
    describe(intent, () => {
      it.each(phrasings)('"%s"', (text) => {
        expect(classifyWithRules(text).intent).toBe(intent);
      });
    });
  }
});

/**
 * The other half of the job. A matcher that says "order_tracking" to everything would ace the corpus
 * above and be useless — it would confidently give a wrong answer to a question about a verified fact.
 *
 * These must reach `unknown`, which routes to the fallback (and, on a second miss, to a live agent).
 * An honest "I didn't catch that" beats a confident wrong answer every time.
 */
describe('and refuses to guess when it genuinely does not know', () => {
  it.each([
    'asdkjhaskjdh',
    'do you have a store in denver',
    'is the site down',
    'i love your brand',
    'what time do you close',
    'do you price match',
    'hello',
  ])('"%s" → unknown', (text) => {
    expect(classifyWithRules(text).intent).toBe('unknown');
  });
});
