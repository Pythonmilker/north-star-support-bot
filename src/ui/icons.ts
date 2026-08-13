/**
 * Inline SVG icons.
 *
 * Not `lucide-react` — an icon library would pull a dependency (and its React runtime) into a bundle
 * that has to stay small enough to sit on a client's marketing page. Two icons don't justify that.
 * Inlining also means zero network requests, which keeps us working under a strict CSP and offline.
 */

import { h } from 'preact';
import type { JSX } from 'preact';

export function ChatIcon(): JSX.Element {
  return h(
    'svg',
    { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
  );
}

export function CloseIcon(): JSX.Element {
  return h(
    'svg',
    { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M18 6 6 18M6 6l12 12' }),
  );
}
