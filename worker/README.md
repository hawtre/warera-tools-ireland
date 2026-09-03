# WarEra tools API proxy

Cloudflare Worker that fronts every external API the toolkit uses. It exists
for one reason: **the game API token must never reach the browser.** The Worker
holds it as a Cloudflare secret and injects it server-side, and adds the CORS
headers the upstream APIs don't send.

## Routes

| Path | Upstream | Token |
|------|----------|-------|
| `/trpc/*` | `https://api2.warera.io/trpc/*` | injects `x-api-key` from the key pool |
| `/warerastats/*` | `https://api.warerastats.io/*` | none needed |
| `/waitlist-update` | GitHub `repository_dispatch` → `waitlist-update` | `$GITHUB_DISPATCH_TOKEN` |
| `/deal-config-submit` | GitHub `repository_dispatch` → `deal-config-submit` | `$GITHUB_DISPATCH_TOKEN` |
| `/notify-discord` | `$DISCORD_WEBHOOK_URL` | webhook URL is the secret |
| `/healthz` | - | reports pool size and how many keys are cooling |

`/trpc` and `/warerastats` are transparent proxies: method, path, query and body
go upstream unchanged, and the upstream status and body come back unchanged.
`shared.js` reads tRPC's own error envelope and keys its retry
logic off the HTTP status, so rewriting either would break it.

The client's `Authorization`, `x-api-key` and `Cookie` headers are stripped
before forwarding, so a caller can't smuggle their own credentials upstream
through this proxy or override the injected token.

## The API key pool

`WARERA_API_KEYS` is a comma-separated list of game API tokens. The Worker
picks one **uniformly at random per request**, rather than draining one key
until it hits its limit and then moving on. Three reasons:

- A Worker has no shared state across isolates and colos, so tracking "which
  key is exhausted" would mean KV or a Durable Object on the hot path. Random
  selection needs no state at all and distributes just as evenly.
- Draining discovers the switchover by *failing* - the active key always sits
  at the edge of its limit, so you learn it is spent by eating 429s. Spreading
  evenly only touches a limit when total load exceeds total capacity.
- Every key stays far from its ceiling, so a burst (a cron log run firing while
  someone is on the dashboard) has the whole pool's headroom to absorb it,
  instead of one key's remainder.

When a request does come back `429`, the Worker parks that key for the duration
of its `Retry-After` (default 60s, capped at 5 minutes) and retries **once** on
a different key. A single limited key is therefore invisible to the client. The
cooldown map lives in isolate memory, which is deliberate: it costs nothing,
adds no latency, and each isolate relearns a bad key within a request or two.

If the retry also 429s, every key in the pool is limited. The 429 passes
through with a `Retry-After` giving the seconds until the first key frees up
(`Access-Control-Expose-Headers` lets the browser read it), and `shared.js`
turns that into `... → rate limited. All API keys are busy. Try again in ~45s.`,
which the tools already surface via `steps.markActiveAsError()`.

A pool-wide 429 is deliberately **not** retried client-side: `shared.js` backs
off ~400ms, nowhere near a rate-limit window, so retrying would only add load to
a pool that is already saturated. If you see this regularly, the pool is
undersized - add keys.

`GET /healthz` reports the pool state:

```json
{ "ok": true, "token": true, "keys": 3, "cooling": 0 }
```

`WARERA_API_KEY` (singular) is still read when `WARERA_API_KEYS` is unset, so an
existing deployment keeps working until you set the new secret.

The game API rate-limits **per key**, not per source IP, so pool size raises the
effective ceiling roughly linearly - a single Worker calling with N keys gets N
times the throughput.

## Which game endpoints actually need the token

Most read endpoints are public - `country.getAllCountries`, `country.getCountryById`
and `search.searchAnything` all answer unauthenticated. The rest return
`{"error":{"message":"API token required","code":-32001}}` with HTTP 401.
Known token-gated endpoints in use here: `worker.getWorkers` (clock-in wages)
and `transaction.getPaginatedTransactions` (wealth/tax logs).

Note the game API **403s on an empty User-Agent**. The Worker always sends its
own, and does not forward the browser's.

## Deploying

```bash
cd worker
pnpm install -g wrangler # or pnpx wrangler
wrangler login

wrangler secret put WARERA_API_KEYS         # required (comma-separated)
wrangler secret put GITHUB_DISPATCH_TOKEN   # optional (waitlist + deal submit)
wrangler secret put DISCORD_WEBHOOK_URL     # optional

wrangler deploy
```

Then edit `wrangler.toml`'s `ALLOWED_ORIGINS` to list the site's real origin(s)
and redeploy.

## Where the site references it

The deployed origin is `https://warera-proxy.0x5ca1ab1e.workers.dev`, and it is
already wired into the site. If the Worker ever moves again, these are the
files to change:

```bash
OLD="https://warera-proxy.0x5ca1ab1e.workers.dev"
NEW="https://your-new-worker.workers.dev"
grep -rl "$OLD" --include='*.js' --include='*.py' . | xargs sed -i "s|$OLD|$NEW|g"
```

That covers `js/shared.js` (`API_BASE`, `WARERASTATS_BASE`), the per-tool
fallbacks in `advisor.js`, `dashboard.js`, `daily-profit.js`,
`daily-profit-dev.js`, `tax-deal-dashboard.js`, `buddy-finder.js`, and the four
log scripts (`wealth_log.py`, `bunker_log.py`, `tax_log.py`, `tax_engine.py`).

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in WARERA_API_KEYS
wrangler dev                     # http://localhost:8787
```

`.dev.vars` is gitignored. `http://localhost` is already in
`ALLOWED_ORIGINS` so the site's own dev server can call a local development Worker.
