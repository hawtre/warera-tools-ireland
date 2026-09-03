/* ═══════════════════════════════════════════════════════════════════
 *  SHARED UTILITIES
 *  Loaded before every tool. Defines the data layer (trpc proxy),
 *  formatting helpers, and the step/status panel constructors used by
 *  MU and the Advisor.
 * ═══════════════════════════════════════════════════════════════════ */
/*
 *  Every external API the site touches goes through one Cloudflare Worker,
 *  and WORKER_BASE is the only place its origin is configured — the route
 *  constants below and each tool's own Worker URLs all derive from it.
 *
 *  On localhost it points at `wrangler dev` (worker/README.md) so local work
 *  runs on a development API key instead of production's quota. Aim a page
 *  at a different Worker with ?proxy=<origin>, which sticks for the tab:
 *  #advisor?proxy=https://warera-proxy.0x5ca1ab1e.workers.dev
 *
 *  The param is `proxy`, not `worker`: a "worker" in this game is a player
 *  (see worker.getWorkers, clock-in wages), so ?worker=<username> is an easy
 *  thing to type by mistake. Anything that isn't an http(s) URL is ignored
 *  with a console warning rather than stored, so a stray value can't quietly
 *  break every request in the tab.
 */
const WORKER_PROD = 'https://warera-proxy.0x5ca1ab1e.workers.dev';
const WORKER_BASE = (() => {
  const isProxyUrl = v => {
    try {
      const { protocol } = new URL(v);
      return protocol === 'http:' || protocol === 'https:';
    } catch { return false; }
  };

  const hashQuery = location.hash.split('?')[1] || '';
  const raw = new URLSearchParams(hashQuery).get('proxy')
           || new URLSearchParams(location.search).get('proxy');
  let override = null;
  if (raw && isProxyUrl(raw)) override = raw;
  else if (raw) console.warn(`ignoring ?proxy=${raw} — not an http(s) URL`);

  let saved = null;
  try {
    if (override) sessionStorage.setItem('proxyBase', override);
    saved = sessionStorage.getItem('proxyBase');
  } catch { /* storage blocked; an override still applies to this load */ }
  const chosen = override || saved;
  if (chosen) return chosen.replace(/\/+$/, '');
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://localhost:8787'
    : WORKER_PROD;
})();

const API_BASE         = `${WORKER_BASE}/trpc`;
const WARERASTATS_BASE = `${WORKER_BASE}/warerastats`;
const GAME_BASE        = 'https://app.warera.io';

// Canonical Ireland country ID. Shared by the MU tool's citizenship
// filter and the Irish-only gate on personal tools (clockin, advisor).
const IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v.toLocaleString(undefined, {maximumFractionDigits: 0});
  return String(v);
}
function fmt(v, dp = 2) {
  if (!isFinite(v)) return '0';
  return v.toFixed(dp).replace(/\.?0+$/, '');
}
function flag(code) {
  if (!code || code.length !== 2) return '🌐';
  return code.toUpperCase().split('').map(c =>
    String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1F1E6)
  ).join('');
}
function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Read the bypass flag from the URL. Lifts Irish-only restrictions
 * for admin/debugging. Works whether the param sits inside the hash
 * (e.g. #clockin?u=foo&bypass=1) or before it (?bypass=1#clockin).
 */
function hasBypassFlag() {
  const hashQuery = location.hash.split('?')[1] || '';
  return new URLSearchParams(hashQuery).get('bypass') === '1'
      || new URLSearchParams(location.search).get('bypass') === '1';
}

/**
 * Enforces the Irish-citizens-only restriction. Throws a friendly
 * error if the user is non-Irish and the bypass flag isn't set.
 * Pass null/undefined country (e.g. unresolved user) to let it
 * through — the failure mode of the resolution path is its own
 * error and we don't want to double up.
 */
function enforceIrishOnly(country, username) {
  if (hasBypassFlag()) return;
  if (country == null) return;
  if (country === IRELAND_COUNTRY_ID) return;
  throw new Error(`This tool is for Irish citizens only. "${username}" is not an Irish citizen.`);
}

/*
 *  Transient errors are worth retrying. Covers raw HTTP 5xx plus proxy
 *  responses that embed an upstream 5xx in the message body, and 429.
 *
 *  429 belongs here because the game API rate-limits per API token, not per
 *  caller: `ratelimit-policy: 500;w=60`, i.e. 500 requests per rolling
 *  minute, shared by everyone the Worker proxies for. Exceeding it is a
 *  "come back shortly", not a failure of the request - so retrying is right,
 *  but ONLY paired with the Retry-After honouring in _retryDelayMs(). A 429
 *  retried on the plain 400ms backoff just burns the remaining attempts
 *  inside a window that has ~18s left to run.
 */
function isTransientError(err) {
  if (err && (err.status === 429 || (err.status >= 500 && err.status < 600))) return true;
  const msg = String(err?.message || '').toLowerCase();
  return /http (429|50[234])|no available server|timed? ?out|fetch failed|network ?error/.test(msg);
}

/*
 *  How long to wait before retrying, in ms, or null to stop trying.
 *
 *  A rate-limited response tells us exactly how long to wait, so prefer that
 *  over guessing.
 *
 *  The ceiling has to clear a whole rate-limit window. The policy is 500
 *  requests per 60s, so Retry-After is as large as the window is wide - burn
 *  the quota at the START of a window and the API asks for 59s. A tighter cap
 *  looks reasonable and then quietly defeats the entire retry: measured
 *  against the live API, a 30s cap turned a rate-limited 100-user fetch into
 *  100 nulls without a single retry. Waiting is the lesser evil, because the
 *  alternative is silently wrong data - but the wait is announced via
 *  onRateLimit so a tool can say so rather than appear hung.
 *
 *  Note the browser can only read Retry-After if the Worker exposes it via
 *  Access-Control-Expose-Headers (it does). Against a proxy that doesn't,
 *  err.retryAfterMs is simply absent and a 429 falls back to a fixed wait -
 *  still far better than 400ms, which is guaranteed to be too early.
 */
const TRPC_RETRY_MAX_WAIT_MS      = 65_000;  // one full 60s window, plus slack
const TRPC_RATE_LIMIT_WAIT_MS     = 5_000;   // fallback when Retry-After is unreadable

function _retryDelayMs(err, attempt) {
  const advised = err?.retryAfterMs
    ?? (err?.status === 429 ? TRPC_RATE_LIMIT_WAIT_MS : null);
  const delay = advised ?? 400 * attempt;
  return delay > TRPC_RETRY_MAX_WAIT_MS ? null : delay;
}

/*
 *  Read the server's own advice on when to come back. Retry-After is either
 *  seconds or an HTTP date; ratelimit-reset (seconds until the window rolls)
 *  is the fallback the game API also sends.
 */
/*
 *  Announce a rate-limit wait. The tools' step panels are the right place to
 *  surface this, so trpcMany takes an onRateLimit callback; this is the
 *  fallback so a wait is never completely silent.
 */
let _onRateLimit = null;

/** @param {?function(number, number):void} fn Called with (waitMs, itemCount). */
function setRateLimitHandler(fn) { _onRateLimit = typeof fn === 'function' ? fn : null; }

/** @returns {?function} The handler currently installed, if any. */
function getRateLimitHandler() { return _onRateLimit; }

function _trpcRateLimited(waitMs, itemCount, label) {
  if (_onRateLimit) { _onRateLimit(waitMs, itemCount); return; }
  console.warn(`[trpc] rate limited on ${label}; waiting ${Math.round(waitMs / 1000)}s`);
}

function _retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw != null && raw !== '') {
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const reset = Number(headers?.get?.('ratelimit-reset'));
  if (Number.isFinite(reset)) return Math.max(0, reset * 1000);
  return null;
}

// async function trpc(endpoint, input = {}, { retry = false, timeoutMs = null } = {}, attempt = 1) {
//   const MAX_ATTEMPTS = retry ? 3 : 1;
//   const url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(input))}`;
//   const ctrl = timeoutMs ? new AbortController() : null;
//   const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
//   try {
//     const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
//     if (!res.ok) {
//       const err = new Error(`${endpoint} → HTTP ${res.status}`);
//       err.status = res.status;
//       throw err;
//     }
//     const json = await res.json();
//     if (json && !Array.isArray(json) && json.error) {
//       const msg = json.error.message || json.error.data?.message || 'unknown error';
//       throw new Error(`${endpoint} → ${String(msg).slice(0, 120)}`);
//     }
//     const item = Array.isArray(json) ? json[0] : json;
//     return item?.result?.data ?? item;
//   } catch (e) {
//     if (e.name === 'AbortError') throw new Error(`${endpoint} → timed out`);
//     if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
//       await new Promise(r => setTimeout(r, 400 * attempt));
//       return trpc(endpoint, input, { retry, timeoutMs }, attempt + 1);
//     }
//     throw e;
//   } finally {
//     if (t) clearTimeout(t);
//   }
// }

/* ── Session request cache ──────────────────────────────────────────
 *  In-flight dedup is always on: concurrent identical requests share one
 *  promise (pure win, no staleness). The resolved cache, serving a past
 *  value for idempotent endpoints with a TTL, is OFF by default so the
 *  live tools behave exactly as before (Refresh stays fresh). The toolkit
 *  shell switches it on via setTrpcCache(true) to harmonise calls across
 *  tools and let its background prefetch warm data before a username is
 *  typed, then switches it off (clearing it) on leave. Volatile endpoints
 *  are never resolved-cached.
 */
const TRPC_CACHE_TTL_MS = 90_000;
const TRPC_VOLATILE = new Set([
  'transaction.getPaginatedTransactions',
  'worker.getWorkers',
]);
let _trpcCacheOn = false;
const _trpcInflight = new Map();
const _trpcResolved = new Map();

/*
 *  Cap on resolved entries. Per-item caching turns one entry per batch into
 *  one per input, so a few citizen sweeps can hold thousands. The payload is
 *  the same either way - these are the same value objects the coarse entry
 *  held - but the map itself needs a bound, because nothing else evicts:
 *  the TTL is enforced on read, so an entry nobody asks for again would sit
 *  there until setTrpcCache(false) cleared the lot.
 */
const TRPC_CACHE_MAX_ENTRIES = 5_000;

/** Distinguishes "not cached" from a cached null/undefined value. */
const TRPC_CACHE_MISS = Symbol('trpc cache miss');

/*
 *  One key scheme for both modes. A batch item is stored under the key it
 *  would have had as a scalar call, which is what lets the two share: a
 *  batched user.getUserLite fills the cache for a later single lookup of the
 *  same user, and vice versa.
 */
function _trpcKey(endpoint, input, batch = false) {
  return `${batch ? 'batch' : 'single'}|${endpoint}|${JSON.stringify(input ?? {})}`;
}

function _cacheSet(key, value) {
  // Delete first so insertion order tracks most-recent write, making the
  // overflow eviction below drop genuinely old entries rather than
  // frequently-refreshed ones that merely got there early.
  _trpcResolved.delete(key);
  _trpcResolved.set(key, { value, ts: Date.now() });
  if (_trpcResolved.size <= TRPC_CACHE_MAX_ENTRIES) return;

  const now = Date.now();
  for (const [k, entry] of _trpcResolved) {
    if (now - entry.ts >= TRPC_CACHE_TTL_MS) _trpcResolved.delete(k);
  }
  while (_trpcResolved.size > TRPC_CACHE_MAX_ENTRIES) {
    const oldest = _trpcResolved.keys().next().value;
    if (oldest === undefined) break;
    _trpcResolved.delete(oldest);
  }
}

/**
 * Look up one input's cached value.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object} input The single input, in scalar form.
 * @param {boolean} [fresh=false] Skip the read (but keep the entry).
 * @returns {*|symbol} The cached value, or TRPC_CACHE_MISS.
 */
function _trpcCachedItem(endpoint, input, fresh = false) {
  if (fresh || !_trpcResolvable(endpoint)) return TRPC_CACHE_MISS;
  const key = _trpcKey(endpoint, input);
  const entry = _trpcResolved.get(key);
  if (!entry) return TRPC_CACHE_MISS;
  if (Date.now() - entry.ts >= TRPC_CACHE_TTL_MS) {
    _trpcResolved.delete(key);        // evict on read; nothing else sweeps
    return TRPC_CACHE_MISS;
  }
  return entry.value;
}

/*
 *  Store each fulfilled item of a batch under its own key. Rejections are
 *  never cached: a 404 is usually permanent, but a 404 that was really a
 *  blip would otherwise stick for the whole TTL, and the saving isn't worth
 *  serving a wrong absence.
 */
function _cacheBatchItems(endpoint, inputs, settled) {
  if (!_trpcResolvable(endpoint)) return;
  for (let i = 0; i < settled.length; i++) {
    if (settled[i]?.status === 'fulfilled') {
      _cacheSet(_trpcKey(endpoint, inputs[i]), settled[i].value);
    }
  }
}

/**
 * Enable or disable the optional 90-second resolved-value cache.
 *
 * In-flight deduplication is independent of this switch and remains active.
 * Disabling the cache immediately clears all resolved values; it does not
 * cancel requests that are already running. Volatile endpoints listed in
 * TRPC_VOLATILE are never resolved-cached, even while caching is enabled.
 *
 * @param {boolean} on Whether resolved responses may be reused.
 * @returns {void}
 */
function setTrpcCache(on) {
  _trpcCacheOn = !!on;
  if (!on) _trpcResolved.clear();
}

/** @returns {boolean} Whether this endpoint may use the resolved cache. */
function _trpcResolvable(endpoint) {
  return _trpcCacheOn && !TRPC_VOLATILE.has(endpoint);
}

/**
 * Call a game API tRPC query through the shared proxy.
 *
 * Scalar mode (the default):
 *   trpc('user.getUserLite', { userId }, { retry: true })
 *
 * `inputOrInputs` must be one non-array, JSON-serialisable tRPC input. The
 * promise resolves to the unwrapped `result.data` value. Transport, HTTP, and
 * tRPC procedure errors reject the promise.
 *
 * Batch mode:
 *   trpc('user.getUserLite', [{ userId: a }, { userId: b }], { batch: true })
 *
 * `inputOrInputs` must be an array of inputs for the SAME endpoint. One HTTP
 * batch request is sent and the promise resolves to an array in the same order
 * using Promise.allSettled's shape:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 * An item-level error therefore does not reject the whole batch. Keep batches
 * modest because all encoded inputs are placed in the request URL.
 *
 * Exact concurrent calls share one in-flight promise. When setTrpcCache(true)
 * is active, successful results are resolved-cached PER INPUT, under the key
 * that input would have had as a scalar call - so a batch fills the cache for
 * later single lookups and for any overlapping list, and one failed item no
 * longer stops its neighbours being cached. Failed items are never cached.
 * `fresh: true` skips the resolved-cache read but still shares an identical
 * in-flight request and stores the new response.
 *
 * `retry: true` allows up to three attempts for transient failures. For batch
 * mode, a transient item error retries the complete batch; after the final
 * attempt, any remaining item errors are returned as rejected results.
 *
 * @param {string} endpoint tRPC procedure name, e.g. `user.getUserLite`.
 * @param {Object|Object[]} [inputOrInputs={}] One input, or an input array when batching.
 * @param {Object} [options]
 * @param {boolean} [options.batch=false] Send all array entries in one HTTP batch.
 * @param {boolean} [options.retry=false] Retry transient failures, up to three attempts.
 * @param {number|null} [options.timeoutMs=null] Abort each HTTP attempt after this many milliseconds.
 * @param {boolean} [options.fresh=false] Bypass a resolved cached value for this call.
 * @returns {Promise<*>} Unwrapped data in scalar mode; settled results in batch mode.
 * @throws {TypeError} If `batch` is not boolean or the input shape does not match it.
 */
function trpc(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
  fresh = false,
} = {}) {
  if (typeof batch !== 'boolean') throw new TypeError('tRPC batch option must be a boolean');
  if (batch && !Array.isArray(inputOrInputs)) {
    throw new TypeError('Batch tRPC input must be an array');
  }
  if (!batch && Array.isArray(inputOrInputs)) {
    throw new TypeError('Scalar tRPC input must not be an array');
  }
  if (batch && !inputOrInputs.length) return Promise.resolve([]);

  const key = _trpcKey(endpoint, inputOrInputs, batch);

  // Serve a fresh-enough resolved value when caching is on for this endpoint.
  if (_trpcResolvable(endpoint) && !fresh) {
    const hit = _trpcResolved.get(key);
    if (hit && Date.now() - hit.ts < TRPC_CACHE_TTL_MS) return Promise.resolve(hit.value);
  }
  // Share an identical request already in flight.
  if (_trpcInflight.has(key)) return _trpcInflight.get(key);

  const p = _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, 1)
    .then(value => {
      // A batch caches per item rather than as one all-or-nothing blob, so a
      // single bad item no longer discards the other 99, and the successes
      // are reusable by any overlapping list or scalar lookup later.
      if (batch) _cacheBatchItems(endpoint, inputOrInputs, value);
      else if (_trpcResolvable(endpoint)) _cacheSet(key, value);
      return value;
    })
    .finally(() => { _trpcInflight.delete(key); });
  _trpcInflight.set(key, p);
  return p;
}

function _trpcResponseError(item, label) {
  if (!item?.error) return null;
  const msg = item.error.message || item.error.data?.message || 'unknown error';
  const err = new Error(`${label} → ${String(msg).slice(0, 120)}`);
  const status = item.error.data?.httpStatus ?? item.error.data?.status ?? item.error.status;
  if (Number.isInteger(status)) err.status = status;
  return err;
}

function _trpcResponseValue(item) {
  return item?.result?.data ?? item;
}

/**
 * Build the URL for one same-endpoint batch request.
 *
 * Procedure names are comma-separated and inputs are encoded as a numerically
 * indexed object, as required by the proxy's tRPC batch protocol. Everything
 * rides in the URL, which is why trpcMany() measures this to size its chunks.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object[]} inputs Batch inputs.
 * @returns {string} The absolute request URL.
 */
function _trpcBatchUrl(endpoint, inputs) {
  const endpoints = inputs.map(() => endpoint).join(',');
  const indexedInputs = Object.fromEntries(
    inputs.map((input, index) => [index, input ?? {}])
  );
  return `${API_BASE}/${endpoints}?batch=1&input=${encodeURIComponent(JSON.stringify(indexedInputs))}`;
}

/**
 * Execute one scalar or same-endpoint batch HTTP request.
 *
 * This is the wire-format and retry layer behind trpc(); callers should use
 * trpc() so validation, in-flight deduplication, and resolved caching apply.
 * Inputs have already been validated by trpc(). In batch mode, procedure names
 * are comma-separated and inputs are encoded as a numerically indexed object,
 * as required by the proxy's tRPC batch protocol.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object|Object[]} inputOrInputs Validated scalar or batch input.
 * @param {Object} options Normalised execution options.
 * @param {boolean} [options.batch=false] Select batch URL and response semantics.
 * @param {boolean} [options.retry=false] Permit up to three transient attempts.
 * @param {number|null} [options.timeoutMs=null] Per-attempt abort timeout.
 * @param {number} [attempt=1] Current attempt number; used internally for retries.
 * @returns {Promise<*>} Unwrapped scalar data or ordered settled batch results.
 */
async function _trpcExec(endpoint, inputOrInputs = {}, {
  batch = false,
  retry = false,
  timeoutMs = null,
} = {}, attempt = 1) {
  const MAX_ATTEMPTS = retry ? 3 : 1;
  const label = batch ? `${endpoint} batch` : endpoint;
  let url;
  if (batch) {
    url = _trpcBatchUrl(endpoint, inputOrInputs);
  } else {
    url = `${API_BASE}/${endpoint}?input=${encodeURIComponent(JSON.stringify(inputOrInputs))}`;
  }
  const ctrl = timeoutMs ? new AbortController() : null;
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) {
      // A 429 here means every key in the proxy's pool is rate-limited, not
      // just one - the proxy already retries a limited key on another. It is
      // deliberately not treated as transient: the retry backoff below is
      // ~400ms, far short of the limit window, so retrying would only add
      // load. Say how long to wait instead and let the caller surface it.
      let err;
      if (res.status === 429) {
        const secs = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(secs) && secs > 0 ? ` Try again in ~${secs}s.` : '';
        err = new Error(`${label} → rate limited. All API keys are busy.${wait}`);
      } else {
        err = new Error(`${label} → HTTP ${res.status}`);
      }
      err.status = res.status;
      const retryAfterMs = _retryAfterMs(res.headers);
      if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    const json = await res.json();
    if (batch) {
      if (!Array.isArray(json) || json.length !== inputOrInputs.length) {
        throw new Error(`${label} → malformed response`);
      }
      const settled = json.map((item, index) => {
        const reason = _trpcResponseError(item, `${endpoint}[${index}]`);
        return reason
          ? { status: 'rejected', reason }
          : { status: 'fulfilled', value: _trpcResponseValue(item) };
      });
      const transient = settled.find(result =>
        result.status === 'rejected' && isTransientError(result.reason)
      );
      if (transient && attempt < MAX_ATTEMPTS) throw transient.reason;
      return settled;
    }

    const item = Array.isArray(json) ? json[0] : json;
    const responseError = _trpcResponseError(item, endpoint);
    if (responseError) throw responseError;
    return _trpcResponseValue(item);
  } catch (e) {
    if (e.name === 'AbortError') e = new Error(`${label} → timed out`);
    if (attempt < MAX_ATTEMPTS && isTransientError(e)) {
      const delay = _retryDelayMs(e, attempt);
      if (delay != null) {
        if (e.status === 429) {
          _trpcRateLimited(delay, batch ? inputOrInputs.length : 1, label);
        }
        await new Promise(r => setTimeout(r, delay));
        return _trpcExec(endpoint, inputOrInputs, { batch, retry, timeoutMs }, attempt + 1);
      }
    }
    throw e;
  } finally {
    if (t) clearTimeout(t);
  }
}

/*
 *  Chunk limits for trpcMany.
 *
 *  A batch carries everything in the URL, so URL SIZE is what actually
 *  constrains a batch and it's what we pack against. The Worker runtime
 *  rejects a request whose URL exceeds 16 KB with a bare 500 - measured
 *  against the live proxy, 15,726 chars still answers 200 and 16,058 already
 *  500. TRPC_MANY_URL_BUDGET keeps ~25% clear of that cliff.
 *
 *  Packing by bytes rather than by count is what lets small inputs ride in
 *  big batches: the budget buys ~290 user.getUserLite inputs (~41 chars each)
 *  but only ~75 transaction.getPaginatedTransactions inputs (~160 chars
 *  each). A fixed count would have to be sized for the worst shape and would
 *  waste most of the URL on the best one.
 *
 *  TRPC_MANY_MAX_CHUNK is then a backstop, not the sizing rule. Two things
 *  scale with batch size besides the URL: the response (50 transaction
 *  inputs already return ~1.1 MB) and the blast radius, since a batch that
 *  fails outright takes every input in it down. 100 keeps both bounded on
 *  the cheap endpoints where the byte budget alone would allow far more.
 *
 *  Several chunks then go out at a bounded concurrency, so a 600-citizen
 *  sweep doesn't open a dozen sockets at once against the request budget.
 */
const TRPC_MANY_URL_BUDGET  = 12_000;
const TRPC_MANY_MAX_CHUNK   = 100;
const TRPC_MANY_CONCURRENCY = 4;

/*
 *  Repair passes for a chunk that came back with retryable failures. Total
 *  attempts per input is 1 + this, matching the 3 of scalar retry.
 */
const TRPC_MANY_REPAIR_PASSES = 2;

/**
 * Fetch one endpoint for many inputs using tRPC HTTP batching.
 *
 * This is the bulk counterpart to trpc(): instead of one request per input,
 * inputs are packed into batches by URL size and the batches are issued
 * `concurrency` at a time. A list of 200 users costs 2 requests rather than
 * 200, which is the difference between a sweep that finishes and one that
 * trips the API rate limit.
 *
 * The result is flat, in the same order and of the same length as `inputs`,
 * using Promise.allSettled's shape:
 *   { status: 'fulfilled', value } | { status: 'rejected', reason }
 * Failure is per item: a chunk whose whole request fails yields rejected
 * results for just that chunk's inputs, and the other chunks still resolve.
 * With `retry` (the default), retryable failures are then re-sent as a batch
 * of just the failures - so one bad item in a chunk of 100 costs one small
 * repair request, not a re-pull of all 100. Rate-limited retries wait as
 * long as the server's Retry-After asks.
 * Callers therefore never need a try/catch around trpcMany itself.
 *
 * @param {string} endpoint tRPC procedure name, e.g. `user.getUserLite`.
 * @param {Object[]} inputs One input per desired result; `[]` resolves to `[]`.
 * @param {Object} [options]
 * @param {number} [options.urlBudget=12000] Max URL length per batch; the primary sizing rule.
 * @param {number} [options.maxChunk=100] Backstop cap on inputs per batch.
 * @param {number} [options.concurrency=4] Batches in flight at once.
 * @param {boolean} [options.retry=true] Re-send retryable failures as a repair batch.
 * @param {number|null} [options.timeoutMs=30000] Abort each HTTP attempt after this long.
 * @param {boolean} [options.fresh=false] Bypass cached values; still caches what it fetches.
 * @param {function(number, number):void} [options.onProgress] Called with (done, total) after each batch.
 * @param {function(number, number):void} [options.onRateLimit] Called with (waitMs, itemCount) before a rate-limit wait.
 * @returns {Promise<Array<{status: string, value?: *, reason?: *}>>} Settled results, input order.
 * @throws {TypeError} If `inputs` is not an array.
 */
async function trpcMany(endpoint, inputs, {
  urlBudget   = TRPC_MANY_URL_BUDGET,
  maxChunk    = TRPC_MANY_MAX_CHUNK,
  concurrency = TRPC_MANY_CONCURRENCY,
  retry       = true,
  timeoutMs   = 30_000,
  fresh       = false,
  onProgress  = null,
  onRateLimit = null,
} = {}) {
  if (!Array.isArray(inputs)) throw new TypeError('trpcMany inputs must be an array');
  const total = inputs.length;
  if (!total) return [];

  const results = new Array(total);

  // Serve whatever is already cached, and only fetch the rest. The cache is
  // per item, so this hits on overlapping lists and on anything a scalar call
  // or an earlier, differently-chunked sweep already fetched.
  const pending = [];
  for (let i = 0; i < total; i++) {
    const cached = _trpcCachedItem(endpoint, inputs[i], fresh);
    if (cached === TRPC_CACHE_MISS) pending.push(i);
    else results[i] = { status: 'fulfilled', value: cached };
  }

  let done = total - pending.length;
  if (done) onProgress?.(done, total);
  if (!pending.length) return results;

  // Pack each chunk up to the URL budget, with maxChunk as a backstop. The
  // budget is measured against the URL actually built for the request, so the
  // guard can't drift from the wire format. A single input that blows the
  // budget on its own still goes out alone - splitting it further isn't
  // possible, and letting the server reject it beats dropping it silently.
  // Chunks carry original indices, since cache hits leave gaps in the list.
  const chunks = [];
  let current = [];
  for (const index of pending) {
    current.push(index);
    const overBudget = current.length > 1
      && _trpcBatchUrl(endpoint, current.map(i => inputs[i])).length > urlBudget;
    if (overBudget) {
      current.pop();
      chunks.push(current);
      current = [index];
    } else if (current.length >= maxChunk) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  let next = 0;

  /*
   *  Issue one batch, flattening a whole-batch failure (transport, HTTP,
   *  malformed response) into a rejected result per input so callers of
   *  runBatch only ever deal with one shape.
   *
   *  retry is false here on purpose: the inner retry re-sends the WHOLE
   *  batch, which at 100 inputs means re-pulling every good result to repair
   *  one bad one. repairChunk below re-sends only what failed instead.
   */
  async function runBatch(batchInputs) {
    try {
      return await trpc(endpoint, batchInputs, { batch: true, retry: false, timeoutMs, fresh });
    } catch (e) {
      return batchInputs.map(() => ({ status: 'rejected', reason: e }));
    }
  }

  /*
   *  Run a chunk, then re-send just the retryable failures.
   *
   *  Whole-batch and item-level failures repair through the same path: a
   *  dead batch is simply the case where every input needs repairing. Each
   *  pass waits as long as the failure itself advises - which for a 429 is
   *  the seconds left in the rate-limit window, read from Retry-After.
   *
   *  Permanent failures (404, 400) are never repaired; they'd fail
   *  identically and cost another request to learn nothing.
   */
  async function repairChunk(chunkInputs) {
    const settled = await runBatch(chunkInputs);
    if (!retry) return settled;

    for (let pass = 1; pass <= TRPC_MANY_REPAIR_PASSES; pass++) {
      const broken = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'rejected' && isTransientError(result.reason)) broken.push(i);
      }
      if (!broken.length) break;

      const reason = settled[broken[0]].reason;
      const delay = _retryDelayMs(reason, pass);
      if (delay == null) break;   // advised wait too long to sit through
      if (reason?.status === 429) {
        if (onRateLimit) onRateLimit(delay, broken.length);
        else _trpcRateLimited(delay, broken.length, `${endpoint} (${broken.length} inputs)`);
      }
      await new Promise(r => setTimeout(r, delay));

      const repaired = await runBatch(broken.map(i => chunkInputs[i]));
      broken.forEach((target, k) => { settled[target] = repaired[k]; });
    }
    return settled;
  }

  async function pump() {
    while (next < chunks.length) {
      const indices = chunks[next++];
      const settled = await repairChunk(indices.map(i => inputs[i]));
      indices.forEach((target, k) => { results[target] = settled[k]; });
      done += indices.length;
      onProgress?.(done, total);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, chunks.length) }, pump
  ));
  return results;
}

/**
 * trpcMany, unwrapped: resolves to plain values with `fallback` in place of
 * any rejected entry. Use it for the common case where a failed item should
 * simply drop out of the results rather than be reported.
 *
 * @param {string} endpoint tRPC procedure name.
 * @param {Object[]} inputs One input per desired result.
 * @param {Object} [options] As trpcMany, plus:
 * @param {*} [options.fallback=null] Value to substitute for a rejected item.
 * @returns {Promise<Array<*>>} Values in input order, `fallback` where an item failed.
 */
async function trpcManyValues(endpoint, inputs, { fallback = null, ...options } = {}) {
  const settled = await trpcMany(endpoint, inputs, options);
  return settled.map(result => result.status === 'fulfilled' ? result.value : fallback);
}

/*
 *  A rate-limit wait can be most of a minute (the window is 60s wide), which
 *  is long enough that a silent pause reads as a hung tool. So the panel
 *  grows a step for it: injected when the wait starts, counting down, removed
 *  when it ends. It's transient rather than markup because it belongs to no
 *  particular pipeline - any step can be the one that gets rate limited.
 *
 *  The panel registers itself as the rate-limit handler while it's visible
 *  (reset() on, hide()/fadeOut() off), so the wait surfaces in whichever tool
 *  is actually running without any of its call sites passing a callback.
 *
 *  Its state is `waiting`, deliberately not `active`: markActiveAsError()
 *  targets the active step, and a rate-limit pause must not swallow the error
 *  marker for the real step underneath.
 */
function makeRateLimitStep(rootEl) {
  let row = null, timer = null, expiry = null, endsAt = 0;

  function clear() {
    if (timer) { clearInterval(timer); timer = null; }
    if (expiry) { clearTimeout(expiry); expiry = null; }
    if (row) { row.remove(); row = null; }
    endsAt = 0;
  }

  function tick() {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    if (left <= 0) { clear(); return; }
    row.querySelector('.step-count').textContent = `${left}s`;
  }

  function show(waitMs, itemCount) {
    // Concurrent batches can each get rate limited; one row, latest deadline.
    endsAt = Math.max(endsAt, Date.now() + waitMs);
    if (!row) {
      row = document.createElement('div');
      row.className = 'step';
      row.dataset.state = 'waiting';
      row.dataset.step = 'ratelimit';
      row.innerHTML =
        '<div class="step-icon"></div>' +
        '<div class="step-body">' +
          '<div class="step-title">Rate limited by the game API</div>' +
          '<div class="step-sub"></div>' +
        '</div>' +
        '<div class="step-count"></div>';
      rootEl.appendChild(row);
    }
    const what = Number.isFinite(itemCount) ? `${itemCount} request${itemCount === 1 ? '' : 's'}` : 'requests';
    row.querySelector('.step-sub').textContent = `Waiting for the limit to reset, then retrying ${what}.`;
    tick();
    // The 1s interval only animates the countdown; removal is pinned to the
    // deadline itself, so the row can't outlive the wait by up to a tick.
    if (!timer) timer = setInterval(tick, 1000);
    if (expiry) clearTimeout(expiry);
    expiry = setTimeout(clear, Math.max(0, endsAt - Date.now()));
  }

  return { show, clear };
}

function makeSteps(rootEl) {
  const rateLimit = makeRateLimitStep(rootEl);

  function setStep(n, state, { sub, count } = {}) {
    const el = rootEl.querySelector(`.step[data-step="${n}"]`);
    if (!el) return;
    el.dataset.state = state;
    if (sub   !== undefined) el.querySelector('.step-sub').textContent   = sub   ?? '';
    if (count !== undefined) el.querySelector('.step-count').textContent = count ?? '';
  }
  function reset() {
    rootEl.classList.remove('hidden', 'fading');
    rateLimit.clear();
    // This panel owns rate-limit reporting for as long as it's on screen.
    setRateLimitHandler(rateLimit.show);
    for (const step of rootEl.querySelectorAll('.step')) {
      step.dataset.state = 'pending';
      step.querySelector('.step-sub').textContent = '';
      step.querySelector('.step-count').textContent = '';
    }
  }
  function markActiveAsError(message) {
    const active = rootEl.querySelector('.step[data-state="active"]');
    if (active) {
      active.dataset.state = 'error';
      active.querySelector('.step-sub').textContent = message;
    }
  }
  function fadeOut(delay = 1200) {
    release();
    setTimeout(() => rootEl.classList.add('fading'), delay);
    setTimeout(() => rootEl.classList.add('hidden'), delay + 500);
  }
  function hide() { release(); rootEl.classList.add('hidden'); }

  // Stop reporting into a panel the user can no longer see. Only give up the
  // global handler if it's still ours - another tool may have claimed it.
  function release() {
    rateLimit.clear();
    if (getRateLimitHandler() === rateLimit.show) setRateLimitHandler(null);
  }

  return { setStep, reset, markActiveAsError, fadeOut, hide };
}

function makeStatus(el) {
  return function setStatus(text, isError = false) {
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
  };
}
