# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static toolkit site for the game War Era (live at we.hawtre.net): plain HTML, CSS, and vanilla JS. No build step, no framework, no bundler, no tests, no linter. The README.md is the canonical contributor document — read it before making non-trivial changes; this file is a summary plus the rules most likely to prevent mistakes.

## Running locally

```bash
python3 -m http.server 8000                  # the site, http://localhost:8000
cd worker && wrangler dev                    # dev Worker, http://localhost:8787
```

On localhost `shared.js` points its Worker base at the `wrangler dev` instance (needs `worker/.dev.vars`, copied from `.dev.vars.example`, with a development API key); the production Worker's `ALLOWED_ORIGINS` only admits the live site. `?proxy=<origin>` in the hash overrides the Worker base for the tab. `file://` does not work (fetch + Web Crypto need a real origin).

## Architecture

One page (`index.html`) holding every tool as a hidden `<section class="view" data-view="NAME">`. `router.js` (loaded last) parses the hash into `{ view, params }` — params live inside the hash after a literal `?` (e.g. `#advisor?u=toie`) — activates one section, and calls that tool's `activate(params)`.

- **Every tool is an IIFE assigned to a global**, returning `{ activate(params) }`. `activate` runs **every time** the view opens, so it must be idempotent (guard repeat loads; re-run only when params change).
- **Script load order in `index.html` is fixed**: `js/shared.js` first, then tool scripts, then `js/router.js` last.
- **Tools never touch each other.** Shared state flows only through the URL and `js/shared.js`.
- **`js/shared.js` is the contract**: `trpc(endpoint, input, {retry, timeoutMs})` is the only sanctioned way to call the game API (never `fetch` the live API directly); `enforceIrishOnly(country, username)` gates personal tools (`bypass=1` in the URL lifts it); `makeSteps`/`makeStatus` drive the loading panel and status line; `escapeHtml` must wrap any user/API string that goes into `innerHTML`; `isTransientError` decides retry-vs-hard-error messaging. `IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe'`.
- All game data goes through one Cloudflare Worker (`warera-proxy.0x5ca1ab1e.workers.dev`), which holds all secrets. Never call GitHub or Discord directly from the client. Exception: the Country Inventory monitor (`inventory.js`) reads a separate self-hosted Go backend — contract in `docs/frontend-integration-handoff.md`; its admin token is operator-entered at runtime and must never be bundled.
- `docs/warera-openapi.d.ts` is the game API schema.

### Username resolution (copy this pattern)

`search.searchAnything` is fuzzy. The shared pattern (advisor, clockin, buddy-finder): search, fetch lite profiles for top results, keep the exact case-insensitive username match, and **never fall back to the top hit** — report what came back instead.

### Encrypted tools

Buddy System Monitor (`buddy.js`), Battle Orders (`battle-orders.js`), and Bunker monitor (`beer.js`) are public *gate* files; the real tool ships as an AES-GCM blob (PBKDF2, 200k iterations) in a `*_ENCRYPTED_PAYLOAD` constant. Plaintext sources (`bo-payload.js`, `buddy-payload.js`, `beer-payload.js`) and `.github/ONBOARDING.md` are gitignored and must never be published or committed. To rotate a password/payload, encrypt with `encrypt.html` and paste the base64 into the gate constant.

### Data logs

GitHub Actions run `wealth_log.py`, `bunker_log.py`, and `tax_log.py` on schedules, committing snapshots under `data/`. The Buddy Finder waitlist (`waitlist.json`) is written only via the Worker's `/waitlist-update` → `repository_dispatch` → Action path (~1 minute lag, intentional).

## Hard-won rules

- **Advisor (`advisor.js`) bonus logic is reverse-engineered and verified against in-game tooltips.** Do not change it without re-verifying live; the file header lists verified cases and past bugs. `AGRARIAN_ITEMS` is misnamed — it's the set of items the industrialism bonus does *not* cover.
- Clock-in wage filtering needs both sides: worker is `sellerId` AND employer is `buyerId` (workers can employ others and hold multiple contracts).
- MU tool: MUs missing a country field are kept (skip the check), not dropped; unknown dormitory data means capacity shows only under "All".

## Styling

Dark theme via CSS custom properties in `:root` of `styles.css` (`--bg`, `--panel`, `--accent`, `--warn`, `--danger`, `--link`, `--muted`, `--text`, `--border`). Never hardcode colours; add a new variable only when the palette genuinely can't express it. Prefix every tool's classes uniquely (`clockin-`, `bf-`, …). Reuse shared components: `.steps`, `.status`, `details.howto`, `.icon-box`. Responsive breakpoints: 720/640/600/380px — keep a tool's overrides together.

## Adding a new tool

Build it standalone first, then merge: (1) add the `<section class="view">` to `index.html`; (2) add a home-view card; (3) fold CSS into `styles.css` with a unique prefix and theme variables; (4) add `js/yourtool.js` in the IIFE + `activate` pattern using the `shared.js` helpers; (5) register in `router.js` (`VALID` set + `tools` map) and add the `<script>` tag before `router.js`. The merged tool must be visually indistinguishable from the existing ones.
