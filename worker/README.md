# WarEra tools API proxy

Cloudflare Worker that fronts every external API the toolkit uses. It exists
for one reason: **the game API token must never reach the browser.** The Worker
holds it as a Cloudflare secret and injects it server-side, and adds the CORS
headers the upstream APIs don't send.

## Routes

| Path | Upstream | Token |
|------|----------|-------|
| `/trpc/*` | `https://api2.warera.io/trpc/*` | injects `x-api-key: $WARERA_API_KEY` |
| `/warerastats/*` | `https://api.warerastats.io/*` | none needed |
| `/waitlist-update` | GitHub `repository_dispatch` → `waitlist-update` | `$GITHUB_DISPATCH_TOKEN` |
| `/deal-config-submit` | GitHub `repository_dispatch` → `deal-config-submit` | `$GITHUB_DISPATCH_TOKEN` |
| `/notify-discord` | `$DISCORD_WEBHOOK_URL` | webhook URL is the secret |
| `/healthz` | - | reports whether the game token is configured |

`/trpc` and `/warerastats` are transparent proxies: method, path, query and body
go upstream unchanged, and the upstream status and body come back unchanged.
`shared.js` reads tRPC's own error envelope and keys its retry
logic off the HTTP status, so rewriting either would break it.

The client's `Authorization`, `x-api-key` and `Cookie` headers are stripped
before forwarding, so a caller can't smuggle their own credentials upstream
through this proxy or override the injected token.

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

wrangler secret put WARERA_API_KEY          # required
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
cp .dev.vars.example .dev.vars   # fill in WARERA_API_KEY
wrangler dev                     # http://localhost:8787
```

`.dev.vars` is gitignored. `http://localhost` is already in
`ALLOWED_ORIGINS` so the site's own dev server can call a deployed Worker.
