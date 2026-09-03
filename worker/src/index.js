/*
 *  WarEra tools API proxy - Cloudflare Worker
 *
 *  The browser must never see the game API token, so every game-data
 *  request goes through here: the Worker holds the token(s) as a secret,
 *  injects one server-side, and adds the CORS headers the game API does
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
 *  API key pool
 *
 *  The game API rate-limits per key, so several keys can be pooled to raise
 *  the ceiling. Keys are picked uniformly at random per request rather than
 *  drained one at a time, minimising state, keeping each key further from its
 *  limits, and leaving some headroom free for bursts of requests.
 *
 *  A key that does come back 429 is parked in `cooling` and skipped until it
 *  expires. That map is per-isolate, so each isolate relearns a bad key within
 *  a request or two.
 */
const cooling = new Map(); // key -> epoch ms at which it may be used again

const COOL_DEFAULT_MS = 60_000;
const COOL_MAX_MS     = 300_000;

// Accepts either the multi-key secret or the original single-key one, so a
// deploy that has not had WARERA_API_KEYS set yet keeps working.
function apiKeys(env) {
  const raw = env.WARERA_API_KEYS || env.WARERA_API_KEY || '';
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
}

function isCooling(key, now) {
  const until = cooling.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    cooling.delete(key);
    return false;
  }
  return true;
}

/*
 *  Prefers a key that is neither cooling nor already tried on this request.
 *  Falls back to any untried key, then to anything at all: a request against
 *  a rate-limited key still has a chance of succeeding (the window may have
 *  rolled over), which beats returning an error we invented ourselves.
 */
function pickKey(keys, tried) {
  const now = Date.now();
  const fresh = keys.filter(k => !tried.includes(k) && !isCooling(k, now));
  const untried = fresh.length ? fresh : keys.filter(k => !tried.includes(k));
  const pool = untried.length ? untried : keys;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Retry-After is either delta-seconds or an HTTP date; anything unparseable
// falls back to the default cooldown.
function coolFor(header) {
  if (!header) return COOL_DEFAULT_MS;
  const secs = Number(header);
  const ms = Number.isFinite(secs)
    ? secs * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return COOL_DEFAULT_MS;
  return Math.min(ms, COOL_MAX_MS);
}

function markCooling(key, retryAfter) {
  cooling.set(key, Date.now() + coolFor(retryAfter));
}

/*
 *  Seconds until the first key in the pool frees up, for the Retry-After we
 *  hand back on a pool-wide 429. Falls back to the default cooldown if
 *  nothing is parked (the limit was hit without us recording it).
 */
function soonestCooldownSecs(keys) {
  const now = Date.now();
  const waits = keys.map(k => cooling.get(k)).filter(u => u !== undefined && u > now);
  const ms = waits.length ? Math.min(...waits) - now : COOL_DEFAULT_MS;
  return Math.max(1, Math.ceil(ms / 1000));
}

function coolingCount(keys) {
  const now = Date.now();
  return keys.filter(k => isCooling(k, now)).length;
}

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
  // Retry-After is not CORS-safelisted; without this the tools can't read it.
  h.set('Access-Control-Expose-Headers', 'Retry-After');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(body, status, origin) {
  const h = corsHeaders(origin);
  h.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers: h });
}

/*
 *  Upstream proxy. `keys` is the API key pool for token-gated upstreams; pass
 *  null for the ones that need no auth.
 */
async function proxy(request, env, origin, base, prefix, keys = null) {
  const url = new URL(request.url);
  const path = url.pathname.slice(prefix.length); // keeps the leading '/'
  const target = `${base}${path}${url.search}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!STRIPPED.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('User-Agent', UPSTREAM_UA);

  // Buffer the body rather than streaming it through. These are small tRPC
  // JSON payloads, and a streamed ReadableStream body needs the `duplex`
  // option, which is not portable across the Workers and Node fetch stacks.
  // Buffering also makes the key-failover retry below possible at all.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  // One retry on 429, on a different key. More than that would just queue up
  // behind a limit that is ours in aggregate, and the client retries too.
  const maxAttempts = keys ? Math.min(2, keys.length) : 1;
  const tried = [];
  let upstream;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let key = null;
    if (keys) {
      key = pickKey(keys, tried);
      tried.push(key);
      headers.set('x-api-key', key);
    }

    try {
      upstream = await fetch(target, { method: request.method, headers, body });
    } catch (err) {
      // Network-level failure. 502 so shared.js isTransientError retries it.
      return json({ error: { message: `upstream unreachable: ${err.message}` } }, 502, origin);
    }

    if (upstream.status !== 429 || !key) break;

    markCooling(key, upstream.headers.get('Retry-After'));
    // Last attempt: pass the 429 through, so shared.js sees the real status.
    if (attempt === maxAttempts) break;
    upstream.body?.cancel();
  }

  // Pass the upstream status and body through untouched - the tools read
  // tRPC's own error envelope, and shared.js keys retry off the status.
  const out = new Headers(upstream.headers);
  for (const [name, value] of corsHeaders(origin)) out.set(name, value);
  out.delete('set-cookie');

  // Pool-wide 429: tell the client how long the whole pool is parked for, so
  // it can say something better than "HTTP 429". Upstream's own Retry-After
  // wins if it sent one.
  if (upstream.status === 429 && keys && !out.has('Retry-After')) {
    out.set('Retry-After', String(soonestCooldownSecs(keys)));
  }
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
      const keys = apiKeys(env);
      return json({
        ok: true,
        token: keys.length > 0,
        keys: keys.length,
        cooling: coolingCount(keys),
      }, 200, origin);
    }
    if (url.pathname.startsWith('/trpc/')) {
      const keys = apiKeys(env);
      if (!keys.length) return json({ error: 'game API token not configured' }, 503, origin);
      return proxy(request, env, origin, GAME_API, '/trpc', keys);
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
