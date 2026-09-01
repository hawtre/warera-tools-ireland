/*  GEAR SOFTCAP ADVISOR
 *
 *  Armor and Dodge are the only two skills the game puts a soft cap on.
 *  Every other skill (precision, criticalDamages, attack, ...) has
 *  softCap === null in gameConfig, so this tool deliberately covers only
 *  those two - and therefore only the chest, pants and boots slots.
 *
 *  The game turns raw points into a percentage that actually applies:
 *
 *      effective% = round(100 × total / (total + softCap))
 *
 *  where `total` is your skill contribution plus your gear contribution,
 *  and `softCap` is 40 for both stats (gameConfig.skills.armor.softCap /
 *  .dodge.softCap - read live, never hardcoded here).
 *
 *  Both inputs are integers: skill levels are integers and every piece of
 *  equipment rolls an integer inside its rarity's dynamicStats range. The
 *  result is rounded to an integer too. So effective% is a STEP function:
 *  a run of consecutive totals all collapse to the same percentage, and
 *  every point above the bottom of a run is paid for and does nothing.
 *
 *  Worked example (dodge, skill maxed at 40):
 *      boots 52 -> total  92 -> 70%
 *      boots 55 -> total  95 -> 70%   <- three stat points bought nothing
 *      boots 56 -> total  96 -> 71%
 *
 *  Verified against the live API, not assumed: user.getUserById returns a
 *  server-computed skills.<stat>.totalAfterSoftCap. The formula above was
 *  fitted against 56 distinct (total, totalAfterSoftCap) pairs from real
 *  players with zero mismatches, and floor() is ruled out (total 24 -> 38,
 *  not 37). checkAgainstApi() below re-runs that comparison on every load,
 *  so if the game ever changes the rule the tool says so instead of
 *  quietly giving bad advice.
 *
 *  Known limit, stated in the how-to: totalAfterSoftCap is the only value
 *  the API exposes and the only one the game client consumes, but combat
 *  is resolved server-side. If the server secretly rolled against an
 *  unrounded float, the bottom-of-band pick would be a hair worse than
 *  the top. Nothing observable suggests it does.
 *
 *  WHAT "CHEAPEST" MEANS
 *
 *  Priced against the real market. transaction.getPaginatedTransactions with
 *  transactionType 'itemMarket' returns, for every completed sale, both the
 *  price and the item's rolled stat. Reading a page of those per item code
 *  gives a price for each individual roll.
 *
 *  Caveats worth keeping in mind: these are prices people PAID over
 *  roughly the last day, not prices currently listed; and a roll with no recent sales
 *  is interpolated from its neighbours and flagged as estimated in the UI. cheapestGear()
 *  survives as the fallback for when the market data doesn't load, and uses a heuristic
 *  based around the equipment rarity levels.
 *
 *  Access: restricted to Irish citizens (enforceIrishOnly from shared.js).
 *  The bypass=1 URL param lifts the restriction.
 */
const GearSoftcapTool = (() => {
  const $username = document.getElementById('sc-username');
  const $go       = document.getElementById('sc-go');
  const $hint     = document.getElementById('sc-hint');
  const $out      = document.getElementById('sc-out');
  const $howto    = document.getElementById('sc-howto');
  const steps     = makeSteps(document.getElementById('sc-steps'));
  const setStatus = makeStatus(document.getElementById('sc-status'));

  const sc_trpc = (endpoint, input) => trpc(endpoint, input, { retry: true });

  // Ascending, so a lower index is the cheaper tier. Mirrors the game's own
  // rarity enum (common1 ... mythic6).
  const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

  // Market pricing. An `itemMarket` transaction carries the sale price AND the item's rolled stat,
  // so a page of recent sales per item code provides a price-per-ROLL curve.
  const PRICE_SAMPLES = 100;              // per item code; ~24h of sales at current volume
  const PRICE_TTL_MS  = 10 * 60 * 1000;   // prices move; config doesn't
  const PRICE_BATCH_SIZE = 20;            // inputs per tRPC batch; all 18 codes fit in one

  // The two soft-capped stats and the equipment slots that feed each one.
  // Armor comes from two slots, so its gear requirement is a combined total
  // the player can split between chest and pants however they like.
  const STATS = {
    armor: { label: 'Armor', icon: '🛡️', slots: ['chest', 'pants'] },
    dodge: { label: 'Dodge', icon: '💨', slots: ['boots'] },
  };

  let config = null;        // parsed gameConfig, loaded once per session
  let lastResult = null;    // last successful analysis, for re-renders
  let priceCache = null;    // { at, prices } - market prices, TTL'd (see PRICE_TTL_MS)

  /** Effective percentage the game actually applies for a raw point total. */
  function effective(total, softCap) {
    if (!(total > 0)) return 0;
    return Math.round((100 * total) / (total + softCap));
  }

  /**
   * The band a total sits in: the lowest and highest raw totals that both
   * round to the same effective percentage. `floor` is what you should be
   * buying; anything above it is wasted.
   */
  function bandFor(total, softCap, maxTotal) {
    const pct = effective(total, softCap);
    let lo = total, hi = total;
    while (lo > 0 && effective(lo - 1, softCap) === pct) lo--;
    while (hi < maxTotal && effective(hi + 1, softCap) === pct) hi++;
    return { pct, lo, hi };
  }

  /** Every distinct effective percentage reachable, with its cheapest total. */
  function allBands(softCap, maxTotal) {
    const out = [];
    let seen = null;
    for (let t = 0; t <= maxTotal; t++) {
      const pct = effective(t, softCap);
      if (pct !== seen) { out.push({ pct, lo: t, hi: t }); seen = pct; }
      else out[out.length - 1].hi = t;
    }
    return out;
  }

  /**
   * Pull the soft caps, skill level tables and equipment stat ranges out of
   * gameConfig. Everything downstream reads from here, so a balance patch
   * on the game's side flows through without a code change.
   */
  function parseConfig(cfg) {
    const stats = {};
    for (const [key, meta] of Object.entries(STATS)) {
      const skill = cfg?.skills?.[key];
      const softCap = skill?.softCap;
      if (!Number.isFinite(softCap)) {
        throw new Error(`gameConfig has no soft cap for "${key}" - the game may have changed this mechanic`);
      }

      const levels = Object.entries(skill.levels || {})
        .map(([lvl, l]) => ({ level: Number(lvl), value: Number(l?.value) || 0 }))
        .sort((a, b) => a.level - b.level);

      // Equipment that feeds this stat, grouped by slot and sorted cheapest
      // rarity first, so the recommender can walk it in cost order.
      const tiersBySlot = {};
      for (const slot of meta.slots) tiersBySlot[slot] = [];
      for (const item of Object.values(cfg?.items || {})) {
        if (item?.type !== 'equipment') continue;
        if (!tiersBySlot[item.usage]) continue;
        const range = item?.dynamicStats?.[key];
        if (!Array.isArray(range) || range.length !== 2) continue;
        tiersBySlot[item.usage].push({
          code: item.code, rarity: item.rarity,
          min: Number(range[0]), max: Number(range[1]),
          rank: RARITY_ORDER.indexOf(item.rarity),
        });
      }
      for (const slot of meta.slots) {
        tiersBySlot[slot].sort((a, b) => a.rank - b.rank);
        if (!tiersBySlot[slot].length) {
          throw new Error(`gameConfig lists no ${slot} equipment carrying "${key}"`);
        }
      }

      const maxSkill = levels.length ? levels[levels.length - 1].value : 0;
      const maxGear = meta.slots.reduce(
        (sum, slot) => sum + Math.max(...tiersBySlot[slot].map(t => t.max)), 0);

      stats[key] = { ...meta, key, softCap, levels, tiersBySlot, maxSkill, maxGear, maxTotal: maxSkill + maxGear };
    }
    return stats;
  }

  // Market prices
  const median = xs => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  /**
   * Turn one item code's sales into a price for every roll in its range.
   *
   * Each roll's price is the MEDIAN of its sales, not the mean: a single
   * panic sale or a fat-fingered listing shouldn't move the recommendation.
   * Coverage is near-complete in practice (every roll of every tier had
   * sales in the sample except one), but ranges up to 15 wide will
   * occasionally have a hole, so gaps are linearly interpolated between
   * their neighbours and the ends are extended proportionally.
   *
   * Returns null when the code had no usable sales at all.
   */
  function buildCurve(txs, statKey, lo, hi) {
    const byRoll = new Map();
    let from = null, to = null;
    for (const tx of txs) {
      const item = tx?.item;
      const roll = Number(item?.skills?.[statKey]);
      const money = Number(tx?.money);
      if (!Number.isFinite(roll) || roll < lo || roll > hi) continue;
      if (!Number.isFinite(money) || money <= 0) continue;
      if (!byRoll.has(roll)) byRoll.set(roll, []);
      byRoll.get(roll).push(money);
      const at = tx.createdAt;
      if (at) { if (!from || at < from) from = at; if (!to || at > to) to = at; }
    }
    const observed = [...byRoll.entries()]
      .map(([roll, sales]) => ({ roll, price: median(sales), n: sales.length }))
      .sort((a, b) => a.roll - b.roll);
    if (!observed.length) return null;

    const curve = new Map();
    for (const o of observed) curve.set(o.roll, { price: o.price, n: o.n });
    for (let roll = lo; roll <= hi; roll++) {
      if (curve.has(roll)) continue;
      let below = null, above = null;
      for (const o of observed) {
        if (o.roll < roll) below = o;
        else if (!above) above = o;
      }
      const price = (below && above)
        ? below.price + (above.price - below.price) * (roll - below.roll) / (above.roll - below.roll)
        : (below || above).price * (roll / (below || above).roll);
      curve.set(roll, { price, n: 0 });   // n = 0 marks an interpolated point
    }
    return { byRoll: curve, samples: observed.reduce((s, o) => s + o.n, 0), from, to };
  }

  /**
   * Fetch recent market sales for every gear code the soft-capped stats can
   * use and build the price curves. All 18 codes are the same procedure with
   * different inputs, so they go out as a single tRPC batch - one round trip
   * and one rate-limit hit instead of eighteen. Cached for PRICE_TTL_MS.
   *
   * Degrades rather than fails: a code that errors or has never sold is
   * simply absent, and if a whole slot ends up unpriced the recommender
   * falls back to the old rarity ordering. Losing prices should cost you
   * precision, not the tool.
   */
  async function loadPrices(stats) {
    if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;

    const wanted = [];
    for (const stat of Object.values(stats)) {
      for (const slot of stat.slots) {
        for (const tier of stat.tiersBySlot[slot]) wanted.push({ tier, statKey: stat.key });
      }
    }

    const chunks = [];
    for (let start = 0; start < wanted.length; start += PRICE_BATCH_SIZE) {
      chunks.push(wanted.slice(start, start + PRICE_BATCH_SIZE));
    }

    let done = 0;
    const byCode = {};
    await Promise.all(chunks.map(async chunk => {
      let settled;
      try {
        settled = await trpc('transaction.getPaginatedTransactions',
          chunk.map(({ tier }) => ({
            transactionType: 'itemMarket', itemCode: tier.code, limit: PRICE_SAMPLES,
          })),
          { batch: true, retry: true, timeoutMs: 30_000 });
      } catch {
        settled = chunk.map(() => ({ status: 'rejected' }));
      }
      settled.forEach((result, index) => {
        const { tier, statKey } = chunk[index];
        const items = result.status === 'fulfilled' ? result.value?.items : null;
        if (!Array.isArray(items) || !items.length) return;
        const curve = buildCurve(items, statKey, tier.min, tier.max);
        if (curve) byCode[tier.code] = curve;
      });
      done += chunk.length;
      steps.setStep(4, 'active', { count: `${done}/${wanted.length}` });
    }));

    // Don't cache a total failure - that's an outage, and the next click
    // should be a real retry rather than 10 minutes of cached nothing.
    if (!Object.keys(byCode).length) return null;

    let samples = 0, from = null, to = null;
    for (const c of Object.values(byCode)) {
      samples += c.samples;
      if (c.from && (!from || c.from < from)) from = c.from;
      if (c.to && (!to || c.to > to)) to = c.to;
    }
    const prices = { byCode, samples, from, to, codes: Object.keys(byCode).length, wanted: wanted.length };
    priceCache = { at: Date.now(), prices };
    return prices;
  }

  // Recommender

  /**
   * Cheapest way to buy `need` points of a stat across a stat's slots.
   *
   * Enumerates every rarity combination (at most 6 per slot, so 36 for
   * armor) and keeps the ones that can physically reach `need`. Ranking is
   * by the HIGHEST rarity in the combination first, then by the combined
   * rarity rank, then by how close the ranges sit to `need`. Highest-first
   * matters because rarity price is nowhere near linear: needing one
   * legendary is worse news than needing two epics, so a combination that
   * avoids the expensive tier wins even if its ranks add up to more.
   *
   * Returns null when `need` is beyond even full mythic in every slot.
   */
  function cheapestGear(stat, need) {
    if (need <= 0) return { combo: [], need: 0 };

    const slots = stat.slots;
    let best = null;

    const walk = (i, chosen) => {
      if (i === slots.length) {
        const maxSum = chosen.reduce((s, t) => s + t.max, 0);
        if (maxSum < need) return;
        const top = Math.max(...chosen.map(t => t.rank));
        const rank = chosen.reduce((s, t) => s + t.rank, 0);
        const better = !best
          || top < best.top
          || (top === best.top && rank < best.rank)
          || (top === best.top && rank === best.rank && maxSum < best.maxSum);
        if (better) best = { top, rank, maxSum, tiers: chosen.slice() };
        return;
      }
      for (const tier of stat.tiersBySlot[slots[i]]) walk(i + 1, chosen.concat(tier));
    };
    walk(0, []);
    if (!best) return null;

    // Spread `need` over the chosen tiers: each slot takes as little as it
    // can while leaving the rest reachable by the slots after it. A slot
    // can never go below its own range's minimum, so the combined spec may
    // legitimately overshoot `need` on cheap tiers.
    const combo = [];
    let remaining = need;
    best.tiers.forEach((tier, i) => {
      const laterMax = best.tiers.slice(i + 1).reduce((s, t) => s + t.max, 0);
      const spec = Math.min(tier.max, Math.max(tier.min, remaining - laterMax));
      combo.push({ slot: slots[i], ...tier, spec });
      remaining -= spec;
    });
    return { combo, need };
  }

  /**
   * Cheapest way to buy `need` points, priced against real market sales.
   *
   * This supersedes cheapestGear's rarity ordering wherever prices are
   * available. The rarity heuristic's blind spot was never the ordering
   * of tiers - it was that it treated every roll inside a tier as
   * interchangeable. It isn't: an epic chest rolled at 25 sells for about
   * a third less than one rolled at 30, so "one uncommon plus a max-roll
   * epic" loses badly to "a mid-roll epic plus an uncommon" even though
   * the rarity combination looks worse on paper.
   *
   * Solved as a small knapsack over slots. Each slot offers every priced
   * (tier, roll) pair plus the empty slot - leaving a slot bare is a real
   * option when the target is low enough, and the old code could never
   * express it. States are capped at `need`, because overshooting the bar
   * is free: the extra points do nothing, so all that matters is the bill.
   *
   * Returns null if any slot has no priced tier at all, which sends the
   * caller back to the rarity ordering rather than quoting half a loadout.
   */
  function cheapestPricedGear(stat, need, prices) {
    if (need <= 0) return { combo: [], need: 0, total: 0, priced: true };

    const slots = stat.slots;
    const options = slots.map(slot => {
      const opts = [{ roll: 0, price: 0, tier: null }];
      for (const tier of stat.tiersBySlot[slot]) {
        const curve = prices.byCode[tier.code];
        if (!curve) continue;
        for (let roll = tier.min; roll <= tier.max; roll++) {
          const point = curve.byRoll.get(roll);
          if (point) opts.push({ roll, price: point.price, tier, n: point.n });
        }
      }
      return opts;
    });
    if (options.some(o => o.length <= 1)) return null;

    // dp[j] = cheapest bill covering j points, j clamped at `need`.
    let dp = new Array(need + 1).fill(Infinity);
    dp[0] = 0;
    const trail = [];
    for (const opts of options) {
      const next = new Array(need + 1).fill(Infinity);
      const pick = new Array(need + 1).fill(null);
      for (let j = 0; j <= need; j++) {
        if (dp[j] === Infinity) continue;
        for (const o of opts) {
          const k = Math.min(need, j + o.roll);
          const cost = dp[j] + o.price;
          if (cost < next[k]) { next[k] = cost; pick[k] = { from: j, opt: o }; }
        }
      }
      dp = next;
      trail.push(pick);
    }
    if (dp[need] === Infinity) return null;

    // Overshoot has two very different causes. Either landing exactly on
    // `need` was possible and clearing it just came out cheaper, or the
    // tiers leave a gap over it - epic boots stop at 25 and legendary
    // start at 31, so a target of 28 cannot be hit at all. The advice
    // should say which, so walk the same options for exact reachability.
    const reach = new Array(need + 1).fill(false);
    reach[0] = true;
    for (const opts of options) {
      const next = new Array(need + 1).fill(false);
      for (let j = 0; j <= need; j++) {
        if (!reach[j]) continue;
        for (const o of opts) if (j + o.roll <= need) next[j + o.roll] = true;
      }
      for (let j = 0; j <= need; j++) reach[j] = next[j];
    }
    const exact = reach[need];

    const chosen = [];
    let j = need;
    for (let i = slots.length - 1; i >= 0; i--) {
      const step = trail[i][j];
      chosen.unshift(step.opt);
      j = step.from;
    }
    const combo = chosen.map((o, i) => o.tier
      ? { slot: slots[i], ...o.tier, spec: o.roll, price: o.price, samples: o.n }
      : { slot: slots[i], empty: true, spec: 0, price: 0 });

    return { combo, need, exact, total: combo.reduce((sum, c) => sum + c.price, 0), priced: true };
  }

  /** Price-optimal when the market data is there, rarity ordering when it isn't. */
  function recommendGear(stat, need, prices) {
    if (prices) {
      const priced = cheapestPricedGear(stat, need, prices);
      if (priced) return priced;
    }
    const byRarity = cheapestGear(stat, need);
    return byRarity ? { ...byRarity, priced: false, total: null } : null;
  }

  // Data loading

  /**
   * Resolve a username to the correct user ID.
   *
   * search.searchAnything is fuzzy and relevance-ranked, so userIds[0] is
   * NOT guaranteed to be an exact username match. Pull lite profiles for
   * the top results and keep the exact case-insensitive match; never fall
   * back to the top hit, report what came back instead.
   */
  async function resolveUser(username) {
    const search = await sc_trpc('search.searchAnything', { searchText: username });
    const candidateIds = search?.userIds || [];
    if (!candidateIds.length) throw new Error(`No user found matching "${username}"`);

    const top = candidateIds.slice(0, 10);
    steps.setStep(1, 'active', {
      sub: `Verifying username among ${candidateIds.length} match${candidateIds.length === 1 ? '' : 'es'}`,
      count: `0/${top.length}`,
    });

    let settled;
    try {
      settled = await trpc('user.getUserLite',
        top.map(userId => ({ userId })),
        { batch: true, retry: true, timeoutMs: 30_000 });
    } catch {
      settled = top.map(() => ({ status: 'rejected' }));
    }
    const profiles = settled.map(r => (r.status === 'fulfilled' ? r.value : null));
    steps.setStep(1, 'active', { count: `${profiles.filter(Boolean).length}/${top.length}` });

    const normalise = s => (s || '').toLowerCase().trim();
    const target = normalise(username);
    const known = profiles.filter(Boolean);
    const exact = known.find(u => normalise(u.username) === target);
    if (exact) return { userId: exact._id, username: exact.username, country: exact.country };

    const found = known.map(u => u.username).filter(Boolean);
    if (!found.length) throw new Error(`Could not verify any username matching "${username}"`);
    throw new Error(
      `No exact match for "${username}". ` +
      `Search returned: ${found.slice(0, 5).join(', ')}${found.length > 5 ? '…' : ''}`
    );
  }

  /**
   * Compare our local formula against the server's own totalAfterSoftCap.
   * Returns the stat keys where they disagree, which the UI surfaces as a
   * warning rather than silently trusting stale maths.
   */
  function checkAgainstApi(stats, skills) {
    const mismatches = [];
    for (const key of Object.keys(stats)) {
      const api = skills?.[key]?.totalAfterSoftCap;
      if (!Number.isFinite(api)) continue;
      const total = Number(skills[key].total) || 0;
      if (effective(total, stats[key].softCap) !== api) mismatches.push(key);
    }
    return mismatches;
  }

  async function analyse(username) {
    steps.setStep(1, 'active', { sub: `Searching for "${username}"` });
    const resolved = await resolveUser(username);
    steps.setStep(1, 'done', { count: `→ ${resolved.username}` });

    // Irish-citizens-only gate, before any further loading. bypass=1 lifts it.
    enforceIrishOnly(resolved.country, resolved.username);

    steps.setStep(2, 'active', { sub: 'Reading soft caps and equipment tiers' });
    if (!config) config = parseConfig(await sc_trpc('gameConfig.getGameConfig', {}));
    steps.setStep(2, 'done', {
      count: Object.values(config).map(s => `${s.label} cap ${s.softCap}`).join(' · '),
    });

    steps.setStep(3, 'active', { sub: `Reading ${resolved.username}'s armor and dodge` });
    const user = await sc_trpc('user.getUserById', { userId: resolved.userId });
    const skills = user?.skills;
    if (!skills) throw new Error(`Could not read skills for "${resolved.username}"`);

    const rows = Object.values(config).map(stat => {
      const s = skills[stat.key] || {};
      const total = Number(s.total) || 0;
      const skill = Number(s.value) || 0;              // null when no points spent
      const gear = Number(s.equipment) || 0;
      return { stat, total, skill, gear, apiPct: Number.isFinite(s.totalAfterSoftCap) ? s.totalAfterSoftCap : null };
    });
    steps.setStep(3, 'done', { count: rows.map(r => `${r.stat.label} ${effective(r.total, r.stat.softCap)}%`).join(' · ') });

    // If the market data doesn't come back, the recommender falls back to
    // rarity ordering, so a failure here must never take the whole analysis down with it.
    steps.setStep(4, 'active', { sub: 'Reading recent gear sales' });
    const prices = await loadPrices(config).catch(() => null);
    steps.setStep(4, 'done', {
      count: prices
        ? `${prices.samples} sales · ${prices.codes}/${prices.wanted} items`
        : 'unavailable — ranking by rarity',
    });

    return { username: resolved.username, rows, prices, mismatches: checkAgainstApi(config, skills) };
  }

  // Rendering

  const pct = n => `${n}%`;
  const coins = v => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));

  function renderCard(row, prices) {
    const { stat, total, skill, gear } = row;
    // Plan-ahead: the skill level selector may differ from what's equipped.
    const planLevel = Number.isFinite(row.planLevel) ? row.planLevel : levelForValue(stat, skill);
    const planSkill = stat.levels.find(l => l.level === planLevel)?.value ?? skill;
    const planTotal = planSkill + gear;

    // The ceiling is skill max + gear max, straight from gameConfig - armor
    // and dodge have no separate hard cap (no skillOverflow entry, unlike
    // criticalChance and precision). Take the player's own total if it ever
    // exceeds that, so a balance patch that raises the real ceiling degrades
    // into a slightly long band table rather than a table missing the band
    // the player is actually standing in.
    const ceiling = Math.max(stat.maxTotal, planTotal);
    const band = bandFor(planTotal, stat.softCap, ceiling);
    const wasted = planTotal - band.lo;
    // Assuming skill points can't be unspent, so the skill contribution is a floor:
    // bands entirely below it are unreachable and only add noise. Keep the
    // band the skill itself lands in (hi >= planSkill) - that's the "no gear
    // at all" row, which is a real option.
    const bands = allBands(stat.softCap, ceiling).filter(b => b.hi >= planSkill);
    const topPct = bands.length ? bands[bands.length - 1].pct : 0;

    const target = Number.isFinite(row.target) ? row.target : band.pct;
    const targetBand = bands.find(b => b.pct === target) || band;
    const needGear = Math.max(0, targetBand.lo - planSkill);
    const rec = recommendGear(stat, needGear, prices);

    const verdict = wasted === 0
      ? '<span class="verdict optimal">No wasted points</span>'
      : `<span class="verdict ${wasted > 2 ? 'huge' : 'move'}">${wasted} wasted point${wasted === 1 ? '' : 's'}</span>`;

    const levelOpts = stat.levels.map(l =>
      `<option value="${l.level}"${l.level === planLevel ? ' selected' : ''}>Lv ${l.level} (+${l.value})</option>`
    ).join('');

    const targetOpts = bands.map(b =>
      `<option value="${b.pct}"${b.pct === target ? ' selected' : ''}>${pct(b.pct)}</option>`
    ).join('');

    const advice = renderAdvice(stat, targetBand, planSkill, needGear, rec, topPct, prices);

    const bandRows = bands.filter(b => b.pct > 0).map(b => {
      const need = Math.max(0, b.lo - planSkill);
      const reach = need <= stat.maxGear;
      return `<tr class="${b.pct === band.pct ? 'sc-here' : ''}${reach ? '' : ' sc-unreachable'}">
        <td>${pct(b.pct)}</td>
        <td>${b.lo}${b.hi > b.lo ? `<span class="sc-dead"> – ${b.hi}</span>` : ''}</td>
        <td>${reach ? need : '—'}</td>
        <td>${b.hi - b.lo}</td>
      </tr>`;
    }).join('');

    return `
    <div class="sc-card" data-stat="${escapeHtml(stat.key)}">
      <div class="sc-head">
        <span class="sc-icon">${stat.icon}</span>
        <span class="sc-name">${escapeHtml(stat.label)}</span>
        <span class="sc-pct">${pct(band.pct)}</span>
        ${verdict}
      </div>

      <div class="sc-body">
        <div class="sc-breakdown">
          <label class="sc-field">
            <span>Skill</span>
            <select class="sc-level" data-stat="${escapeHtml(stat.key)}">${levelOpts}</select>
          </label>
          <span class="sc-op">+</span>
          <div class="sc-field">
            <span>Gear (${stat.slots.join(' + ')})</span>
            <strong>${gear}</strong>
          </div>
          <span class="sc-op">=</span>
          <div class="sc-field">
            <span>Total</span>
            <strong>${planTotal}</strong>
          </div>
        </div>

        <p class="sc-note">
          ${wasted === 0
            ? `Total <strong>${planTotal}</strong> is the cheapest total that reaches ${pct(band.pct)}. Nothing to save here.`
            : `Totals <strong>${band.lo}–${band.hi}</strong> all give ${pct(band.pct)}. You could drop to <strong>${band.lo}</strong> and lose nothing — <strong>${wasted}</strong> point${wasted === 1 ? '' : 's'} of gear ${wasted === 1 ? 'is' : 'are'} being paid for and doing nothing.`}
        </p>

        <div class="sc-target">
          <label class="sc-field">
            <span>Target effective</span>
            <select class="sc-goal" data-stat="${escapeHtml(stat.key)}">${targetOpts}</select>
          </label>
          <div class="sc-advice">${advice}</div>
        </div>

        <details class="sc-bands">
          <summary>All ${stat.label.toLowerCase()} bands</summary>
          <table class="sc-table">
            <thead><tr>
              <th>Effective</th><th>Total needed</th><th>From gear</th><th>Dead points</th>
            </tr></thead>
            <tbody>${bandRows}</tbody>
          </table>
        </details>
      </div>
    </div>`;
  }

  /** Exactly what to buy for the chosen target. */
  function renderAdvice(stat, targetBand, planSkill, needGear, rec, topPct, prices) {
    if (needGear === 0) {
      return planSkill > 0
        ? `Your skill alone gives total <strong>${planSkill}</strong>, which already reaches
           <strong>${pct(targetBand.pct)}</strong>. No ${stat.slots.join('/')} needed.`
        : `With no points in the skill and no ${stat.slots.join('/')}, ${stat.label.toLowerCase()}
           does nothing. Pick a target above to see what it would take.`;
    }
    if (!rec) {
      return `<span class="sc-warn">${pct(targetBand.pct)} needs <strong>${needGear}</strong> from
              ${stat.slots.join(' + ')}, more than the best available gear can give
              (max ${stat.maxGear}). Raise the skill level instead.</span>`;
    }
    const buy = rec.combo.filter(c => !c.empty);
    const parts = buy.map(c => {
      const piece = `<strong>${escapeHtml(c.rarity)} ${escapeHtml(c.slot)}</strong> with ${escapeHtml(stat.key)} ${c.spec}`;
      // A roll nobody has actually sold recently is a modelled price, not an
      // observed one - say so rather than quoting it with false confidence.
      return rec.priced
        ? `${piece} <span class="sc-price">(~${coins(c.price)}${c.samples ? '' : ', estimated'})</span>`
        : piece;
    }).join(' and ');
    const bare = rec.combo.filter(c => c.empty).map(c => c.slot);
    const overshoot = rec.combo.reduce((s, c) => s + c.spec, 0) - needGear;
    // The top band has nothing above it, so there is no next step to save for.
    const ceiling = targetBand.pct >= topPct
      ? `That's the cap — anything above it is wasted outright.`
      : `Anything above that is wasted until <strong>${pct(targetBand.pct + 1)}</strong>.`;
    // Overshoot means two different things depending on how we got here. On
    // prices it's a deliberate choice - clearing the bar came out cheaper
    // than landing on it. On rarity alone it's just the tier's floor.
    const over = overshoot > 0
      ? (rec.priced && rec.exact
        ? `<span class="sc-dead">(${overshoot} over — clearing the bar came out cheaper than landing on it.)</span>`
        : `<span class="sc-dead">(${overshoot} over — nothing rolls exactly there, so it can't be avoided.)</span>`)
      : '';
    return `For <strong>${pct(targetBand.pct)}</strong> you need total <strong>${targetBand.lo}</strong>,
            so <strong>${needGear}</strong> from ${stat.slots.join(' + ')}.
            Cheapest that gets there: ${parts}${bare.length ? `, and nothing in the ${bare.join(' or ')} slot` : ''}.
            ${rec.priced && buy.length > 1 ? `That's about <strong>${coins(rec.total)}</strong> all in.` : ''}
            ${over}
            ${ceiling}
            ${priceNote(rec, prices)}`;
  }

  /** Where the money numbers came from - or why there aren't any. */
  function priceNote(rec, prices) {
    if (!rec.priced) {
      return `<div class="sc-src">No market data right now, so this is ranked by rarity alone -
              it may not be the cheapest thing to actually buy. Check the market before you commit.</div>`;
    }
    const when = prices?.to ? formatDate(prices.to) : null;
    return `<div class="sc-src">Median sale prices from ${prices.samples} recent market sales${when ? `, latest ${when}` : ''}.
            Those are what people paid, not what's listed right now.</div>`;
  }

  /** Nearest skill level for a raw skill value (levels are a fixed table). */
  function levelForValue(stat, value) {
    const hit = stat.levels.find(l => l.value === value);
    return hit ? hit.level : 0;
  }

  function render() {
    if (!lastResult) { $out.innerHTML = ''; return; }
    const warn = lastResult.mismatches.length
      ? `<div class="sc-mismatch">The game's own numbers no longer match this tool's formula for
         <strong>${lastResult.mismatches.map(escapeHtml).join(', ')}</strong>. The soft cap rule has
         probably changed — treat the advice below as out of date.</div>`
      : '';
    $out.innerHTML = warn + lastResult.rows.map(row => renderCard(row, lastResult.prices)).join('');
    $howto.classList.remove('hidden');
  }

  // Wiring

  async function run() {
    const username = $username.value.trim();
    if (!username) { $username.focus(); return; }

    // Make the view shareable as a URL. Existing params (notably bypass=1)
    // are preserved, otherwise the Irish-only gate stops seeing the flag
    // once the run rewrites the hash. replaceState doesn't fire hashchange,
    // so this can't loop back into activate().
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    params.set('u', username);
    const newHash = `#softcap?${params.toString()}`;
    if (location.hash !== newHash) {
      history.replaceState(null, '', newHash + location.search);
    }

    $go.disabled = true;
    setStatus('');
    $out.innerHTML = '';
    $hint.classList.add('hidden');
    $howto.classList.add('hidden');
    steps.reset();
    try {
      lastResult = await analyse(username);
      steps.fadeOut(400);
      render();
    } catch (e) {
      steps.hide();
      const friendly = isTransientError(e)
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : `Error: ${e.message}`;
      setStatus(friendly, true);
    } finally {
      $go.disabled = false;
    }
  }

  // Both selects re-render in place. They only change the plan, never the
  // loaded data, so there's no refetch.
  $out.addEventListener('change', e => {
    const sel = e.target.closest('.sc-level, .sc-goal');
    if (!sel || !lastResult) return;
    const row = lastResult.rows.find(r => r.stat.key === sel.dataset.stat);
    if (!row) return;
    if (sel.classList.contains('sc-level')) {
      row.planLevel = Number(sel.value);
      delete row.target; // bands shift with the skill; reset the goal
    } else {
      row.target = Number(sel.value);
    }
    render();
  });

  $go.addEventListener('click', run);
  $username.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  return {
    /**
     * Called by the router every time this view becomes active. Idempotent:
     * re-runs only when the username param differs from what's already
     * loaded, otherwise focuses the empty field.
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const u = (params && params.get('u'))
             || new URLSearchParams(location.search).get('u');
      if (u && $username.value !== u) {
        $username.value = u;
        run();
      } else if (!$username.value) {
        $username.focus();
      }
    }
  };
})();
