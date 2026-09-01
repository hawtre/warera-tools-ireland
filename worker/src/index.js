/*
 *  WarEra tools API proxy - Cloudflare Worker
 *
 *  The browser must never see the game API token, so every game-data
 *  request goes through here: the Worker holds the token as a secret,
 *  injects it server-side, and adds the CORS headers the game API does
 *  not send. Routes:
 *
 *    /trpc/*             -> https://api2.warera.io/trpc/*   (+ x-api-key)
 *    /warerastats/*      -> https://api.warerastats.io/*    (no token)
 *    /waitlist-update    -> GitHub repository_dispatch: waitlist-update
 *    /deal-config-submit -> GitHub repository_dispatch: deal-config-submit
 *    /notify-discord     -> Discord webhook
 */

const GAME_API        = 'https://api2.warera.io/trpc';
const WARERASTATS_API = 'https://api.warerastats.io';

// The game API 403s on an empty User-Agent, and the client's own UA is
// not forwarded (it identifies the player's browser, not this service).
const UPSTREAM_UA = 'warera-tools-proxy (+https://github.com/hawtre/warera-tools-ireland)';

// Headers we never forward upstream: auth material the client has no
// business setting (we supply our own), and hop-by-hop / CF-managed ones.
const STRIPPED = new Set([
  'x-api-key', 'authorization', 'cookie', 'host', 'origin', 'referer',
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'user-agent',
]);

/*
 *  ALLOWED_ORIGINS is a comma-separated list. A request with no Origin
 *  (curl, the GitHub Actions log scripts) is allowed through - CORS only
 *  constrains browsers, and blocking it would break the data logs.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : false;
}

function corsHeaders(origin) {
  const h = new Headers();
  if (origin) {
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
  } else {
    h.set('Access-Control-Allow-Origin', '*');
  }
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(body, status, origin) {
  const h = corsHeaders(origin);
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers: h });
}

// Upstream proxy
async function proxy(request, env, origin, base, prefix, extraHeaders = {}) {
  const url = new URL(request.url);
  const path = url.pathname.slice(prefix.length); // keeps the leading '/'
  const target = `${base}${path}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('User-Agent', UPSTREAM_UA);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

  // Buffer the body rather than streaming it through. These are small tRPC
  // JSON payloads, and a streamed ReadableStream body needs the `duplex`
  // option, which is not portable across the Workers and Node fetch stacks.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, body });
  } catch (err) {
    // Network-level failure. 502 so shared.js isTransientError retries it.
    return json({ error: { message: `upstream unreachable: ${err.message}` } }, 502, origin);
  }

  // Pass the upstream status and body through untouched - the tools read
  // tRPC's own error envelope, and shared.js keys retry off the status.
  const out = new Headers(upstream.headers);
  for (const [name, value] of corsHeaders(origin)) out.set(name, value);
  out.delete('set-cookie');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// GitHub repository_dispatch
async function dispatch(request, env, origin, eventType) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
  if (!env.GITHUB_DISPATCH_TOKEN) return json({ error: 'dispatch not configured' }, 503, origin);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400, origin);
  }

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UPSTREAM_UA,
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    return json({ error: `github dispatch failed (${res.status}): ${detail}` }, 502, origin);
  }
  return json({ ok: true }, 202, origin);
}

// Discord dispatch
async function notifyDiscord(request, env, origin) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
  if (!env.DISCORD_WEBHOOK_URL) return json({ error: 'discord not configured' }, 503, origin);

  const body = await request.text();
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UPSTREAM_UA },
    body,
  });
  if (!res.ok) return json({ error: `discord failed (${res.status})` }, 502, origin);
  return json({ ok: true }, 202, origin);
}

// Router
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (origin === false) {
      return json({ error: 'origin not allowed' }, 403, null);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/healthz') {
      return json({ ok: true, token: Boolean(env.WARERA_API_KEY) }, 200, origin);
    }
    if (url.pathname.startsWith('/trpc/')) {
      if (!env.WARERA_API_KEY) return json({ error: 'game API token not configured' }, 503, origin);
      return proxy(request, env, origin, GAME_API, '/trpc', { 'x-api-key': env.WARERA_API_KEY });
    }
    if (url.pathname.startsWith('/warerastats/')) {
      return proxy(request, env, origin, WARERASTATS_API, '/warerastats');
    }
    if (url.pathname === '/waitlist-update') {
      return dispatch(request, env, origin, 'waitlist-update');
    }
    if (url.pathname === '/deal-config-submit') {
      return dispatch(request, env, origin, 'deal-config-submit');
    }
    if (url.pathname === '/notify-discord') {
      return notifyDiscord(request, env, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },
};
