# The proxy

This is optional. The widget works without it — it just means the API key sits in the page.

Use this when you don't want that.

## The thing worth understanding first

A key in the page is readable. Not "readable if you're clever" — readable by anyone who presses F12. That
isn't a flaw in this widget; it's how browsers work. Any key the page can send to OpenRouter, the page's
reader can copy and send themselves.

Everything you can do about that falls into two buckets:

- **Rotate it easily.** Cap the spend, set an expiry, make swapping it a one-line edit. The widget already
  does this — see "Swapping the key" in the main README. If someone takes your key, you cancel it, paste in
  a new one, and you're done. Loss is bounded by the cap you set.
- **Never put it in the page.** That needs a server. This is the server.

Bucket one is fine for a demo, a pilot, or a low-traffic shop with a $10 cap. Bucket two is what you run
when the site is real.

## What this actually protects

The naive proxy is the one that takes whatever the browser posted, staples the key on, and forwards it.
**That protects nothing.** It turns your key into a free public LLM endpoint for anyone who reads the proxy
URL out of your page source — and it's *worse* than a key in the page, because now the abuse is invisible to
you and billed to you.

So this proxy accepts exactly one field:

```
POST /  { "text": "where is my order 111" }
```

That's it. The prompt, the JSON schema, the model, and the token cap are all decided on the server, in
[`../src/transport/protocol.ts`](../src/transport/protocol.ts). There is no field a caller can set that
changes what we ask the model.

The worst someone can do with a stolen proxy URL is sort their own sentences into one of six support
intents, at 30 requests a minute, from an origin you explicitly allowed, until your spend cap trips. That's
a nuisance. A general-purpose LLM billed to you is not.

## The four controls, honestly ranked

1. **The server owns the request.** The proxy can't be repurposed. This is the one doing the real work.
2. **Origin pin.** Only origins in `ALLOWED_ORIGINS` get a response. Exact string match — no wildcards, no
   suffix matching (`endsWith('.example.com')` also matches `evil-example.com`, which is how that goes
   wrong). Unset it and the proxy allows *nobody*; a security control with no config must fail closed.
3. **A hard spend cap on the OpenRouter key.** Set this in the OpenRouter dashboard. **This is your real
   ceiling** — the actual number that bounds what a bad day can cost you.
4. **The rate limit.** 30/min per IP. Read the comment in [`worker.ts`](worker.ts) before you trust it: the
   counter lives in one Worker isolate and Cloudflare runs many, so it's per-IP-per-isolate, not a strict
   global. It stops one script hammering one endpoint. It does not stop a distributed attacker. **That is
   what #3 is for.** If you want a strict global limit, bind Cloudflare's rate-limiting product or a Durable
   Object — but don't skip the spend cap and assume the counter has you covered.

## Deploying it

You need a Cloudflare account (free tier is plenty) and `wrangler`.

```bash
cd proxy

# 1. Say which site is allowed to call it. Edit wrangler.toml:
#    ALLOWED_ORIGINS = "https://your-shop.com"

# 2. Store the key. It goes in encrypted, not into any file.
pnpm dlx wrangler secret put OPENROUTER_API_KEY

# 3. Ship it.
pnpm dlx wrangler deploy
```

Wrangler prints a URL like `https://north-star-bot-proxy.you.workers.dev`. Point the widget at it:

```html
<script
  src="north-star-bot.js"
  data-proxy-url="https://north-star-bot-proxy.you.workers.dev"
></script>
```

Note what's gone: no `data-api-key`. The key is not in the page, not in the bundle, and not in your git
history. Open devtools on the live site and there's nothing to find.

Rotating it is `wrangler secret put OPENROUTER_API_KEY` again. No rebuild, no redeploy of the widget, no
change to the site.

## If the proxy goes down

The widget keeps working.

Every proxy failure — 403, 429, 500, timeout, DNS, you deleted the Worker — is a typed error the widget
already handles, and it falls back to the built-in keyword matcher. The customer still gets the right order
status, the right return policy, and the right shipping times. They just get them from rules instead of a
model, and they never see an error.

That's the same fallback that runs when there's no key at all, which is why it's well tested rather than a
theory: `pnpm test` exercises it.

## Not on Cloudflare?

The worker is standard `fetch(request) -> Response`. Vercel Edge, Deno Deploy, Netlify, a
Lambda behind API Gateway, or twenty lines of Express all work the same way. Keep the four controls. The
first one is the one people leave out.
