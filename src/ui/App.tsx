/**
 * The chat panel.
 *
 * Ported from the shape of the prior BotInterface, with its four bugs fixed:
 *   - Enter is guarded on `loading` (the original disabled the button but not the key handler, so
 *     holding Enter fired concurrent requests that raced each other into setMessages)
 *   - `setLoading(false)` lives in a `finally`
 *   - messages are keyed by id, not array index
 *   - the host page's scroll is never touched
 *
 * Bot text is rendered with textContent semantics (JSX children), never innerHTML — this widget runs
 * on someone else's page and must not become their XSS vector.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { handleTurn, greeting, initialState, type ConversationState } from '@/orchestrator';
import { renderFallback, type Answer } from '@/answer/render';
import type { IntentProvider } from '@/intent/types';
import type { OrderProvider } from '@/orders';
import { PERSONA } from '@/persona';
import { ChatIcon, CloseIcon } from './icons';

interface Message {
  id: number;
  role: 'bot' | 'user';
  answer: Answer;
}

export interface AppProps {
  provider: IntentProvider | undefined;
  position: 'bottom-right' | 'bottom-left';
  /** Host-supplied returns URL. The brief mandates the link but gives no address. */
  returnsUrl: string | undefined;
  /** Where a "Shop …" button on a recommendation points. */
  shopUrl: string | undefined;
  /** Where order numbers are looked up. Undefined means the bundled mock data. */
  orders: OrderProvider | undefined;
  /** Opt in to generated, human-feeling replies (facts still spliced verbatim). */
  conversational: boolean;
}

let nextId = 0;

export function App({ provider, position, returnsUrl, shopUrl, orders, conversational }: AppProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [convo, setConvo] = useState<ConversationState>(initialState);
  const [messages, setMessages] = useState<Message[]>([
    { id: nextId++, role: 'bot', answer: greeting() },
  ]);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  // On open: focus the composer, and jump the log to the newest message. The panel is remounted each
  // time it opens (it's `{open && …}`), so its log starts scrolled to the TOP and the messages-change
  // effect above doesn't re-fire (the messages are unchanged). Without this, reopening a chat with
  // history lands you on the oldest message. Instant jump, not a smooth scroll — the user should just
  // find themselves at the latest reply, not watch it race down from the top.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [open]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;

      setMessages((m) => [...m, { id: nextId++, role: 'user', answer: { text } }]);
      setInput('');
      setLoading(true);

      try {
        const turn = await handleTurn(text, convo, { provider, orders, conversational, render: { returnsUrl, shopUrl } });
        setConvo(turn.state);
        // Degradation to the keyword matcher is INVISIBLE to the customer by design — the answer is
        // still correct, and "matched by keyword / offline mode" is meaningless (and faintly alarming)
        // to them. If the LLM was configured but this turn fell back, note it for the operator only.
        if (provider && turn.via === 'rules') {
          // eslint-disable-next-line no-console
          console.debug('[north-star-bot] this turn was answered by the keyword matcher (LLM unavailable).');
        }
        setMessages((m) => [...m, { id: nextId++, role: 'bot', answer: turn.answer }]);
      } catch {
        // The orchestrator is built not to throw, but if it ever did, the customer still gets an
        // answer rather than a dead panel.
        setMessages((m) => [
          ...m,
          { id: nextId++, role: 'bot', answer: renderFallback() },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [convo, loading, provider, returnsUrl, shopUrl, orders, conversational],
  );

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    // Guarded on `loading` — this is the bug that let held-Enter fire overlapping requests.
    if (e.key === 'Enter' && !e.shiftKey && !loading) {
      e.preventDefault();
      void send(input);
    }
  };

  const inLiveAgent = convo.mode === 'live_agent';

  return (
    <div class={position === 'bottom-left' ? 'pos-left' : 'pos-right'}>
      {open && (
        <div class="panel" role="dialog" aria-label="North Star Support Bot">
          <div class="header">
            <div>
              <div class="title">{PERSONA.name}</div>
              <div class="sub">Gear, orders &amp; returns</div>
            </div>
            <button class="close" onClick={() => setOpen(false)} aria-label="Close chat">
              <CloseIcon />
            </button>
          </div>

          {inLiveAgent && (
            <div class="agent-banner" role="status">
              ● {PERSONA.liveAgentBadge} — connected
            </div>
          )}

          <div class="log" ref={logRef} role="log" aria-live="polite" aria-atomic="false">
            {messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
            {loading && (
              <div class="typing" aria-label="Typing">
                <i /> <i /> <i />
              </div>
            )}
          </div>

          {/* One persistent quick-action bar above the composer — the same options the fallback and the
              handoff route-back rely on, now always one tap away instead of repeated under every reply. */}
          <nav class="menu-bar" aria-label="Quick actions">
            {PERSONA.menu.map((label) => (
              <button
                key={label}
                type="button"
                class="chip"
                disabled={loading}
                onClick={() => void send(label)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div class="composer">
            <input
              ref={inputRef}
              value={input}
              placeholder="Ask about an order, return, or gear…"
              aria-label="Message"
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <button onClick={() => void send(input)} disabled={loading || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}

      <button
        class="launcher"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close support chat' : 'Open support chat'}
        aria-expanded={open}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>
    </div>
  );
}

/** One message. The link is an affordance the renderer asked for — never model-authored HTML. The quick
 *  actions no longer live here (they moved to the persistent bar above the composer). */
function Bubble({ message }: { message: Message }): JSX.Element {
  const { role, answer } = message;
  return (
    <div class={`msg ${role}`}>
      {answer.text}
      {answer.link && (
        <div>
          <a class="link-btn" href={answer.link.href} target="_blank" rel="noopener noreferrer">
            {answer.link.label}
          </a>
        </div>
      )}
    </div>
  );
}

/** Recommendation and returns links are the only affordances the renderer surfaces; nothing here ever
 *  asks the customer for a key or any credential. */
