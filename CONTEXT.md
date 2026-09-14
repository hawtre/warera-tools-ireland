# WarEra Tools Ireland

Toolkit site and data loggers for Ireland's government and community in the game War Era. Terms below are the canonical vocabulary for tools that read game data.

## Language

### Country finances & stock

**Ireland Donation**:
A positive money transfer from a User to Ireland. Outgoing payments from Ireland, non-money transfers, and transfers involving military units or other countries are not Ireland Donations.
_Avoid_: country donation, Ireland payout, grant

**Donation Draw**:
A uniform random selection from qualifying unique Users who made Ireland Donations during the Selected Period. Donation count and total do not change a User's odds; a winner is excluded from later rolls until the draw is reset.
_Avoid_: weighted draw, transaction draw

**Selected Period**:
The continuous interval used to include Ireland Donations in totals and a Donation Draw. It includes the start instant and excludes the end instant.
_Avoid_: date range, draw date

**Donation Threshold**:
The operator-selected minimum a User's total Ireland Donations must reach within the Selected Period to qualify for the Donation Draw. It defaults to ₿1 and does not apply to individual transactions.
_Avoid_: minimum transaction, entry price

**Eligible Donor**:
A User who is currently an Irish citizen, reaches the Donation Threshold during the Selected Period, and has not already won since the Donation Draw was last reset.
_Avoid_: entrant, transaction

**Unresolved Donor**:
A User whose Ireland Donations were found but whose current profile could not be loaded. Their eligibility is unknown, so they remain visible and block the Donation Draw.
_Avoid_: ineligible donor, missing donation

**Draw Summary**:
A copyable record of a Donation Draw's Selected Period, Donation Threshold, eligible Users, draw timestamp, and winners.
_Avoid_: proof, receipt

**Country Inventory**:
The nation's storage account (game endpoint `inventory.getById` by `countryId`): money plus basic-item stocks (oil, paper, steel, …), managed in-game by its Managers. Requires an authenticated session to read.
_Avoid_: treasury, national storage, country account

**Inventory Manager**:
A user allowed to move Country Inventory funds/items — currently the president, vice-president, and minister of economy.

**Locked Money**:
Country Inventory money escrowed in open market buy orders (`market.lockedMoney`). Counts toward the monitored money total — it is still the country's money.

**Monitored Money**:
Country Inventory `money` + Locked Money. The figure the money threshold applies to.

**Country Wealth**:
The public ranking value (`country.getCountryById` → `rankings.countryWealth.value`). A slightly stale mirror of Country Inventory money; excludes Locked Money. Publicly readable without auth.

**country.money**:
An unexplained small balance on the public country object; not rendered in the game UI and NOT the monitored figure. Do not alert on it.

### Data access

**Game API Token**:
An official War Era token (`wae_…`, sent as `X-API-Key` to the game API) granting rate-limited access (200 req/min) *to the public endpoints only* — inventory endpoints and `user.getMe` respond `403: API tokens cannot access this endpoint`.
_Avoid_: JWT, session token

**War Era API**:
The live game tRPC API (`api2.warera.io/trpc`, `X-API-Key` auth). The team's Cloudflare Worker proxies it, keeps the key out of the browser, and its endpoint catalogue excludes country inventory.

### Company production

**Production Bonus**:
The location-dependent percentage added to a company's output, composed of any eligible Strategic Resource Bonus, Deposit Bonus, and Industrialism Modifier.

**Strategic Resource Bonus**:
A country-level production bonus granted when the company's item matches the country's specialization.
_Avoid_: regional bonus, deposit bonus

**Deposit Bonus**:
A temporary region-level production bonus granted when the company produces the resource in the region's active deposit.
_Avoid_: strategic resource bonus

**Industrialism Modifier**:
The production modifier from the ruling party's exact Industrialism tier. Positive tiers affect eligible specialized goods; negative tiers affect only eligible deposit resources, and the tier's magnitude determines the percentage.
_Avoid_: industrialism lean, diplomacy bonus, flat ethics bonus

### Alerting

**Critical Amount**:
The per-resource threshold (e.g. 5,000 oil) below which the Country Inventory level is considered critical and an alert is warranted.
_Avoid_: limit, minimum
