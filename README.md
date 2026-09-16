# Flight Search Optimizer

Local planning app for comparing cash fares, airline miles, and transferable-card points for a trip.

## Current capabilities

- Searches cash fares through SerpApi Google Flights and cached award availability through Seats.aero.
- Compares cash, airline-mile, Amex Membership Rewards, Chase Ultimate Rewards, and card-travel payment paths.
- Applies traveler balances, transfer ratios, point valuations, cpp thresholds, taxes, and redemption rates to effective-cost calculations.
- Supports one-way and round-trip searches, flexible date windows, stay-length limits, passenger counts, cabin and stop filters, and soft or hard time-of-day preferences.
- Expands nearby airports across curated metro groups and applies configurable estimated ground-travel time and cost.
- Returns ranked candidates, highlighted winners, payment breakdowns, provider provenance, diagnostics, caveats, recommendations, and recheck links.
- Refreshes official Amex and Chase transfer-partner data when the local cache is older than seven days. Failed refreshes preserve the last known cache and return a warning.
- Provides a browser UI, CLI, and newline-delimited JSON MCP adapter over the same optimizer service.

Local sample inventory in `data/sample-flights.json` is retained for deterministic development and tests only. It is never an automatic fallback for live-provider searches.

## Run locally

From the repository root:

```powershell
npm.cmd start
```

Then open `http://localhost:8000`.

## CLI

The CLI uses the same provider and ranking pipeline as the backend. It emits compact JSON by default.

```powershell
node cli.mjs health
node cli.mjs search --origin IAH --destination NYC --nearby --depart 2026-10-01 --return 2026-10-08
node cli.mjs search --origin IAH --destination NYC --depart 2026-10-01 --depart-by 2026-10-03 --return 2026-10-08 --return-by 2026-10-10
node cli.mjs search --origin IAH --destination NYC --nearby --nearby-airport-max-ground-travel-minutes 60 --nearby-airport-ground-cost-per-hour 20 --depart 2026-10-01 --return 2026-10-08
Get-Content query.json | node cli.mjs search --stdin --pretty
node cli.mjs search --input query.json --full
node cli.mjs validate --input query.json
```

Exit codes are `0` when candidates are found, `1` when valid search criteria produce no candidates, and `2` for invalid input or CLI errors. Use `--strategy sample-only` for deterministic local testing without provider requests. Use `--limit N` to return 1–10 candidates.

When `--nearby` is enabled:

- `--nearby-airport-max-ground-travel-minutes` limits alternate airports by estimated ground time. The default is `90` minutes.
- `--nearby-airport-ground-cost-per-hour` adds estimated ground cost to effective-cost ranking. The default is `$20/hour`.

The JSON request equivalents are `nearbyAirportMaxGroundTravelMinutes` and `nearbyAirportGroundCostPerHour`.

The compact and full output contracts both return stable `option_N` identifiers. Full output adds normalized itinerary details and provider evidence under `details`.

## MCP adapter

Run the adapter with:

```powershell
npm.cmd run mcp
```

It exposes `start_flight_search`, `get_search_results`, `get_option_details`, `compare_options`, `recheck_option`, and `get_traveler_profile`. Search snapshots are kept in memory for 30 minutes. SerpApi booking options are looked up only when a finalist is inspected or rechecked. Round-trip searches now reserve bounded requests for SerpApi’s native round-trip search and `departure_token` return-leg follow-up, while retaining separate one-way searches for split-ticket comparisons.

## Provider status and credentials

Check configured providers with:

```powershell
curl http://localhost:8000/api/providers/health
```

Copy `.env.example` to `.env`. The server loads `.env` without overriding existing process environment variables.

Active provider settings:

- `PROVIDER_TIMEOUT_MS`: overall provider request timeout; default `20000`.
- `SERPAPI_GOOGLE_FLIGHTS`: SerpApi key. `SERPAPI_API_KEY`, `SERPAPI_KEY`, and `SERP_API_KEY` are accepted aliases.
- `SERPAPI_BASE_URL`: defaults to `https://serpapi.com/search`.
- `SERPAPI_MAX_REQUESTS_PER_SEARCH`: bounds SerpApi initial and departure-token follow-up requests; default `6`. Round-trip searches reserve capacity for native bundled-fare discovery and use the remaining budget for separate one-way comparisons.
- `SERPAPI_TIMEOUT_MS`: per-request timeout; default `20000`.
- `SERPAPI_NO_CACHE`: defaults to `false`; set to `true` only when an intentional fresh fetch is worth the additional paid request.
- `SEATS_AERO_API_KEY`: enables cached award searches.
- `SEATS_AERO_BASE_URL`: defaults to `https://seats.aero/partnerapi`.
- `SEATS_AERO_TAKE`, `SEATS_AERO_MAX_AVAILABILITY`, and `SEATS_AERO_REQUEST_BUDGET`: bound cached-award retrieval and request volume.

Optional award imports can be supplied with `UNITED_AWARD_IMPORT_PATH`, `DELTA_AWARD_IMPORT_PATH`, `JETBLUE_AWARD_IMPORT_PATH`, `SOUTHWEST_AWARD_IMPORT_PATH`, `FRONTIER_AWARD_IMPORT_PATH`, `AMERICAN_AWARD_IMPORT_PATH`, or `ALASKA_AWARD_IMPORT_PATH`. Normalized JSON can also be pasted into the browser’s inline import field. Imports are validated and isolated by program; they do not create cash-bookable offers.

## Transfer-partner data

Transfer ratios are refreshed from Amex’s [official Membership Rewards transfer portal](https://global.americanexpress.com/rewards/transfer) and Chase’s [official Sapphire Preferred partner page](https://www.chase.com/sapphire-cards/personal/preferred), then stored in `data/transfer-partners.json`.

The cache is refreshed when older than seven days. A failed refresh keeps the previous records and adds a warning. Current Chase eligibility models Sapphire Preferred; other Chase card products may require different partner rules. Transfer ratios are planning inputs, not a points-transfer action.

## Airport coverage

Nearby-airport groups are defined in `search-config.mjs` and currently include:

- Houston: `IAH`, `HOU`
- New York City: `JFK`, `LGA`, `EWR`
- Chicago: `ORD`, `MDW`
- Los Angeles: `LAX`, `BUR`, `SNA`, `ONT`
- Dallas–Fort Worth: `DFW`, `DAL`
- Washington, DC: `DCA`, `IAD`, `BWI`
- San Francisco Bay Area: `SFO`, `OAK`, `SJC`
- South Florida: `MIA`, `FLL`, `PBI`
- Boston / New England: `BOS`, `PVD`, `BDL`
- Seattle: `SEA`, `PAE`

Airport access times are approximate planning metadata. Ground cost does not represent a live rideshare, parking, toll, or transit quote. Airport expansion is shared by provider query planning and result ranking, so the search does not rank an alternate airport it never queried.

## Data and result caveats

- SerpApi results can be cache-eligible and must be rechecked with the seller before booking. Native round-trip fares are identified as `Round-trip cash`; independently paired legs remain labeled as separate one-way or same-airline pairings.
- Seats.aero results are cached discoveries. Confirm award availability, mileage price, and taxes with the airline before transferring points.
- If SerpApi or Seats.aero returns no usable results, the app returns an explicit warning and does not substitute local sample inventory.
- Award listings without a reference cash fare can still rank, but cpp and cash savings are shown as unknown.
- The app does not book flights, transfer points, or place OTA orders.
- The repository retains inactive provider and automation scaffolding for compatibility and future work, but the normal search path is SerpApi cash discovery plus Seats.aero cached awards.

## Development checks

```powershell
npm.cmd run check
npm.cmd test
```

The test suite covers normalization and validation, airport expansion, provider request planning and mapping, cached award behavior, transfer-cache refreshes, ranking, CLI output, MCP behavior, and no-fallback warnings.
