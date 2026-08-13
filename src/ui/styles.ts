/**
 * The widget's stylesheet, as a string injected INTO the shadow root.
 *
 * Not Tailwind, not a .css import. Two reasons:
 *   - Tailwind classes resolve against the HOST page's build. On a stranger's static site there is
 *     no build, so every utility class would silently render as nothing.
 *   - A separate .css emit would break the "one <script> tag" promise, and couldn't reach inside the
 *     shadow root anyway.
 *
 * Note `:host { all: initial }`. Inherited properties (font, colour, line-height) cross the shadow
 * boundary even though selectors don't — so without this we'd quietly inherit the host's typography.
 * We reset, then set our own.
 */

export function styles(accent: string): string {
  return `
:host {
  all: initial;
  font-family: -apple-system, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif;
  --ns-accent: ${accent};
  --ns-ink: #1b2620;
  --ns-muted: #5a6b5f;
  --ns-line: #dde4dc;
  --ns-surface: #ffffff;
  --ns-bot-bg: #f1f5f1;
  --ns-radius: 12px;
}

*, *::before, *::after { box-sizing: border-box; }

.launcher {
  position: fixed; bottom: 20px; z-index: 2147483000;
  width: 56px; height: 56px; border-radius: 50%;
  border: none; cursor: pointer;
  background: var(--ns-accent); color: #fff;
  display: grid; place-items: center;
  box-shadow: 0 4px 16px rgba(0,0,0,.22);
  transition: transform .15s ease;
}
.launcher:hover { transform: scale(1.05); }
.launcher:focus-visible { outline: 3px solid var(--ns-accent); outline-offset: 3px; }
.pos-right .launcher, .pos-right .panel { right: 20px; }
.pos-left  .launcher, .pos-left  .panel { left: 20px; }

.panel {
  position: fixed; bottom: 88px; z-index: 2147483000;
  width: 370px; max-width: calc(100vw - 40px);
  height: 540px; max-height: calc(100vh - 120px);
  background: var(--ns-surface); color: var(--ns-ink);
  border: 1px solid var(--ns-line); border-radius: var(--ns-radius);
  box-shadow: 0 12px 40px rgba(0,0,0,.18);
  display: flex; flex-direction: column; overflow: hidden;
  font-size: 14px; line-height: 1.5;
}

.header {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px; background: var(--ns-accent); color: #fff; flex: none;
}
.header .title { font-weight: 600; font-size: 15px; }
.header .sub { font-size: 12px; opacity: .85; }
.header .close {
  margin-left: auto; background: none; border: none; color: #fff;
  cursor: pointer; padding: 4px; border-radius: 6px; display: grid; place-items: center;
}
.header .close:hover { background: rgba(255,255,255,.18); }
.header .close:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

.agent-banner {
  padding: 8px 16px; background: #fff8e6; border-bottom: 1px solid #f0dfae;
  color: #7a5a12; font-size: 12.5px; font-weight: 600; flex: none;
}

.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }

.msg { max-width: 85%; padding: 10px 13px; border-radius: var(--ns-radius); white-space: pre-wrap; word-wrap: break-word; }
.msg.bot  { background: var(--ns-bot-bg); align-self: flex-start; border-bottom-left-radius: 4px; }
.msg.user { background: var(--ns-accent); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }

/* Inline links inside message text — NOT the .link-btn call-to-action button (excluded, or these more
   specific selectors would override its white-on-accent styling and paint it green-on-green: invisible). */
.msg a:not(.link-btn) { color: inherit; font-weight: 600; }
.msg.bot a:not(.link-btn) { color: var(--ns-accent); }

.link-btn {
  display: inline-block; margin-top: 8px; padding: 7px 12px;
  background: var(--ns-accent); color: #fff; text-decoration: none;
  border-radius: 8px; font-size: 13px; font-weight: 600;
}
.link-btn:focus-visible { outline: 2px solid var(--ns-ink); outline-offset: 2px; }

/* Persistent quick-action bar, sitting just above the composer. An even 2-up grid so the pills are all
   the same width and aligned; the last action ("Talk to a human") spans the full width, keeping the
   handoff route always one tap away. Replaces the old chip cluster that repeated under every reply. */
.menu-bar {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
  padding: 8px 12px; border-top: 1px solid var(--ns-line); background: #fafbfa; flex: none;
}
.chip {
  width: 100%; padding: 7px 10px; border: 1px solid var(--ns-line); background: #fff;
  border-radius: 999px; font-size: 12.5px; font-weight: 500; color: var(--ns-ink);
  cursor: pointer; font-family: inherit; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.chip:last-child { grid-column: 1 / -1; }
.chip:hover:not(:disabled) { border-color: var(--ns-accent); color: var(--ns-accent); }
.chip:focus-visible { outline: 2px solid var(--ns-accent); outline-offset: 1px; }
.chip:disabled { opacity: .5; cursor: default; }

.typing { display: flex; gap: 4px; padding: 12px 13px; align-self: flex-start; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--ns-muted); animation: ns-bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }
@keyframes ns-bounce { 0%,60%,100% { opacity:.3; transform: translateY(0);} 30% { opacity:1; transform: translateY(-3px);} }

.composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--ns-line); flex: none; }
.composer input {
  flex: 1; padding: 10px 12px; border: 1px solid var(--ns-line);
  border-radius: 9px; font: inherit; font-size: 14px; color: var(--ns-ink); background: #fff;
}
.composer input:focus { outline: 2px solid var(--ns-accent); outline-offset: -1px; border-color: var(--ns-accent); }
.composer button {
  padding: 10px 14px; border: none; border-radius: 9px;
  background: var(--ns-accent); color: #fff; cursor: pointer; font: inherit; font-weight: 600;
}
.composer button:disabled { opacity: .45; cursor: not-allowed; }
.composer button:focus-visible { outline: 2px solid var(--ns-ink); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .launcher, .typing i { transition: none; animation: none; }
}

@media (max-width: 420px) {
  .panel { width: calc(100vw - 24px); height: calc(100vh - 100px); }
  .pos-right .panel, .pos-left .panel { left: 12px; right: 12px; }
  /* On a narrow phone two columns would squeeze the longer labels to an ellipsis — stack them one per
     row instead, still even, still full-width, nothing truncated. */
  .menu-bar { grid-template-columns: 1fr; }
}
`;
}
