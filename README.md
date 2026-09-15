# Flight Search Optimizer

Local planning app for comparing cash, airline miles, and transferable-card-points options for a trip.

## What this MVP does

- Captures balances for Amex Membership Rewards, Chase Ultimate Rewards, and airline-specific miles including Delta, JetBlue, United, Frontier, Southwest, American, and Alaska.
- Lets you define a trip by origin, destination, nearby-airport expansion, adult traveler count, flexible departure and return windows, stay length, time-of-day preferences, and the dollar penalty for missing a soft time preference.
- Scores flight options by:
  - out-of-pocket cash first
  - estimated effective trip cost using your point valuations
  - total flight time
- Enforces minimum cpp thresholds for Amex, Chase, and airline balances before allowing a redemption path.
- Compares bank points as airline transfers and direct card-travel redemptions when those paths reduce out-of-pocket cash.
- Includes seeded segment inventory so the optimizer can compare mixed one-way pairings and same-airline pairings before live API integration.
- Routes segment loading through an official-API-first provider abstraction with SerpApi Google Flights cash discovery, Seats.aero cached awards, award imports, and sample-data fallback.
- Presents a practical shortlist above the full ranked results: best overall, cheapest, best schedule, fastest, best cash, and best award when award availability exists. Duplicate winners are consolidated with multiple category labels and link back to their stable full-result option.
- Exposes itinerary quality and ticketing context, including elapsed time, air time, layovers, overnight travel, early-return and separate-ticket risks, reservation protection, baggage rules, and change implications.
- Preserves provider provenance, freshness caveats, diagnostics, award rejection reasons, search links, and booking links that require a final price and availability recheck.

## Run locally

From the repository root:

```powershell
node server.mjs
```

Then open `http://localhost:8000`.

## Use the agent-facing CLI

The CLI is the preferred non-browser entry point. It loads `.env`, uses the same provider and ranking pipeline as the backend, emits compact JSON by default, and exits with code `0` when at least one itinerary is found, `1` when the search is valid but empty, and `2` for invalid input or CLI errors:

```powershell
node cli.mjs health
node cli.mjs search --origin IAH --destination NYC --nearby --depart 2026-10-01 --return 2026-10-08
node cli.mjs search --origin IAH --destination NYC --depart 2026-10-01 --depart-by 2026-10-03 --return 2026-10-08 --return-by 2026-10-10
Get-Content query.json | node cli.mjs search --stdin --pretty
node cli.mjs search --input query.json --full
node cli.mjs validate --input query.json
```

The shared application boundary lives in `optimizer-service.mjs`. It owns provider-neutral segment merging, ranking orchestration, diagnostics, recommendations, and warnings; the HTTP server supplies provider resolvers and the CLI and MCP adapter consume the resulting contract.

## Use the local MCP server

The MCP adapter uses newline-delimited JSON-RPC over stdio and keeps search snapshots in memory for 30 minutes. Configure an MCP client to launch `node mcp-server.mjs` from this project directory, or run it directly with `npm.cmd run mcp`. It exposes `start_flight_search`, `get_search_results`, `get_option_details`, `compare_options`, `recheck_option`, and `get_traveler_profile`.

Searches return opaque IDs and compact finalist packets by default. Use `get_option_details` for provider evidence, cache status, Google Flights links, and segment-level booking hints. SerpApi booking options are looked up only for an explicitly inspected or rechecked finalist; initial searches never fan out through booking tokens or `departure_token`. Seats.aero results remain `discovered_cached`; `recheck_option` reports that the listing must be confirmed at the same mileage price and taxes before transferring points.

Use `--depart-by` and `--return-by` to set the end of flexible date windows; without them, each window ends on its corresponding `--depart` or `--return` date. Use `--strategy sample-only` for deterministic local testing without provider requests. Use `--limit N` to cap the result list at 1-10 candidates.

The CLI output contract is stable across compact and full modes. Both modes return `outputMode`, `candidates`, and stable `option_N` identifiers. Compact mode contains normalized summaries. Full mode adds a `details` object keyed by those same IDs; each entry contains the complete normalized itinerary, segments, and provider evidence. Full mode no longer replaces `candidates` with a separate `itineraries` field.

The browser search API (`POST /api/providers/search`) also returns `highlightedCandidates`. Each highlight includes a category, display label, stable `optionId`, and the corresponding full itinerary. The browser renders these winners first, then keeps every ranked candidate in the complete results list below. If no award itinerary qualifies, `bestAward` is omitted rather than implying that points are available.

```json
{
  "outputMode": "full",
  "candidates": [{ "optionId": "option_1", "route": "IAH-SAN / SAN-IAH" }],
  "details": {
    "option_1": {
      "outbound": { "providerEvidence": [] },
      "inbound": { "providerEvidence": [] }
    }
  }
}
```

## Verifying live data is connected

Use the **Check live data connection** button in the Data Pipeline section, or query the backend directly:

```powershell
curl http://localhost:8000/api/providers/health
```

This reports, per provider, whether credentials are configured and whether Amadeus authenticates successfully (`live`, `missing-credentials`, or `auth-failed`). When Amadeus is live and the data strategy is not `sample-only`, the optimizer ranks against real cash fares. When Seats.aero is configured, selected award programs can contribute cached award availability. If a live or cached request fails or no configured source succeeds, the app falls back to sample data and surfaces a warning in the results panel so you always know which source produced the ranking.

## Optional provider credentials

The backend loads local credentials from `.env` if the file exists, then falls back to the process environment. Copy `.env.example` to `.env` for local live-provider testing. The backend can attempt live Amadeus cash-fare searches when these values are set before starting `server.mjs`:

- `AMADEUS_CLIENT_ID`
- `AMADEUS_CLIENT_SECRET`
- `AMADEUS_BASE_URL` optional, defaults to `https://test.api.amadeus.com`
- `AMADEUS_MAX_OFFERS_PER_DAY` optional, defaults to `5`
- `AMADEUS_MAX_REQUESTS_PER_SEARCH` optional, defaults to `60`. Caps the total flight-offer requests one search may fan out across nearby airports and date windows.
- `AMADEUS_MAX_RETRIES` (default `2`) and `AMADEUS_RETRY_BASE_MS` (default `500`) control exponential backoff retries when Amadeus returns HTTP 429 rate-limit responses.
- `PROVIDER_TIMEOUT_MS` optional, defaults to `20000`; bounds each provider request lane while allowing successful sources to contribute concurrently.
- `DUFFEL_API_TOKEN` reserved for the scaffolded Duffel adapter; live offer creation is not implemented yet
- `SERPAPI_GOOGLE_FLIGHTS` enables bounded Google Flights cash searches. `SERPAPI_API_KEY`, `SERPAPI_KEY`, and `SERP_API_KEY` are accepted as compatibility aliases.
- `SERPAPI_BASE_URL` optional, defaults to `https://serpapi.com/search`.
- `SERPAPI_MAX_REQUESTS_PER_SEARCH` optional, defaults to `6`; the budget is split across bounded outbound and return date samples rather than issuing one request for every date in an arbitrary window.
- `SERPAPI_TIMEOUT_MS` optional, defaults to `20000`; each request is aborted independently on timeout.
- `SERPAPI_NO_CACHE` optional, defaults to `false`. SerpApi allows exact-query cached results by default and documents a one-hour cache lifetime; set this to `true` only for an intentional fresh fetch because `no_cache=true` can consume a paid search.
- Searches accept `tripType: "round-trip"` (the default) or `tripType: "one-way"`. One-way searches require only the departure date/window and produce single-leg candidates through both the CLI and MCP server.
- `SEATS_AERO_API_KEY` enables Seats.aero cached award searches for supported airline programs. Live Search is not used in this project phase.
- `SEATS_AERO_BASE_URL` optional, defaults to `https://seats.aero/partnerapi`
- `SEATS_AERO_TAKE` optional, caps cached availability rows requested per route/date search.
- `SEATS_AERO_MAX_AVAILABILITY` optional, caps how many cached availability rows are expanded with trip details.
- `SEATS_AERO_REQUEST_BUDGET` optional, caps Seats.aero HTTP requests per search so broad date and nearby-airport searches do not burn quota unexpectedly.
- `UNITED_AWARD_IMPORT_PATH`, `DELTA_AWARD_IMPORT_PATH`, `JETBLUE_AWARD_IMPORT_PATH`, `SOUTHWEST_AWARD_IMPORT_PATH`, `FRONTIER_AWARD_IMPORT_PATH`, `AMERICAN_AWARD_IMPORT_PATH`, and `ALASKA_AWARD_IMPORT_PATH` optional paths to normalized award JSON files. See `data/united-award-import.example.json` and `data/southwest-award-import.example.json`.
- You can also paste the same normalized JSON into the app's inline award import box. The request shape is an object keyed by program, for example `{ "southwest": { "segments": [...] } }`, and it does not require restarting the server.
- Award import segments may include a positive `cashPrice` or `referenceCashPrice`; the optimizer uses that fare to calculate cpp, cash savings, and effective cost. Cached award results without a reference cash fare can still rank, but cpp and cash savings display as unknown.
- Award import fares are treated as reference fares for value math, not cash-bookable offers. Cash and card-travel payment options are generated only from cash-capable sources.
- Cached Seats.aero award results can support a transfer recommendation, but the UI must show this caveat: `Confirm the award is still available at the same mileage price and taxes before transferring points.`
- SerpApi cash results preserve the Google Flights search link, booking token, price insights, baggage and booking-option metadata when available, but the app never treats a cached or provider-refreshed result as a final booking confirmation. Verify current price and availability with the seller before booking.

## Current limitations

- Flight inventory still falls back to sample data in `data/sample-flights.json` when configured providers return no usable candidates.
- No airline booking, bank transfer, or OTA order integrations yet. SerpApi and Amadeus provide cash discovery; Seats.aero is used for cached award discovery only, not Live Search.
- Nearby-airport groups and transfer-partner rules are intentionally simplified and configurable in code.
- The Duffel entry remains scaffolded and unavailable until live offer creation and mapping are added.
- SerpApi round-trip coverage uses bounded one-way searches in each direction so the optimizer can pair flexible dates. The documented `departure_token` continuation is preserved as metadata but is not automatically followed for every outbound result; this avoids uncontrolled fan-out. A round-trip request builder exists for explicit provider use.
- SerpApi initial searches use the provider's cache-eligible default (`no_cache` omitted). Because the documented response shape does not guarantee an explicit cache-hit flag, cache-eligible responses stay conservatively labeled `discovered_cached`; booking-option requests are on-demand and still require a final seller-side price and availability check.
- The Amadeus backend route now performs real OAuth token exchange and flight-offer requests when credentials are present, but it currently maps cash fares only and does not provide award inventory.
- The local server now loads `.env` automatically without overriding already-set environment variables, so local credentials can stay out of source control.
- Nearby-airport expansion is now shared between ranking and live-provider query planning, so official cash searches can fan out across groups like `ORD/MDW` and `JFK/LGA/EWR` instead of ranking only after an exact-airport fetch.
- Houston metro expansion now covers `IAH/HOU`, and sample fixture coverage includes Houston to New York routes across `JFK/LGA/EWR` for the next United-first award integration path.
- Search input is now normalized and validated on both the client and server, so impossible date windows, invalid airport codes, negative stop counts, and other malformed searches fail with explicit errors instead of producing misleading “no results” output.
- Search responses now include diagnostics for expanded airport scope, candidate segment counts, pairing counts, and rejection reasons, so flexible-date searches are easier to debug when inventory or redemption rules narrow the result set.
- Diagnostics now also break out redemption-layer failures like cpp threshold rejects, direct-mile balance rejects, transfer balance rejects, and pair-level balance conflicts, so you can tell whether points rules or inventory are blocking an option.
- Diagnostics now also break out segment-filter rejects by direction for airport mismatch, cabin mismatch, stop limit, date window, and hard time-of-day filtering, which makes “no candidates” cases much easier to debug.
- The backend now returns concrete search recommendations derived from diagnostics and warnings, so empty-result guidance stays consistent between the server response and the browser fallback path.
- Transfer-backed award options now use explicit configurable transfer ratios instead of assuming every bank-to-airline conversion is 1:1, so Amex and Chase redemptions can consume the correct number of bank points.
- Configurable card-travel redemption rates let Amex and Chase points offset cash fares directly, so portal-style or Pay-with-Points assumptions can compete against transfers and cash.
- Ranked itineraries now include a value breakdown showing cash fare baseline, cash saved, point opportunity cost, configurable time preference penalty, and final effective cost. They also show balance impact for the selected payment method, including points or miles used and remaining balances after booking. Date and stay-length insight cards show the winning booking method, points or miles used, savings, and time penalty so flexible-trip tradeoffs are easier to compare.
- Adult traveler count is part of the search state, so cash fares, award taxes, miles, transfer points, and balance checks scale to the full party instead of assuming one passenger.
- The automation fallback route currently uses award-capable sample segments to exercise the hybrid provider flow until a real browser worker is added.
- The automation fallback route is now program-targeted, so only the airline award programs selected in the UI are returned from that lane.
- Automation fallback is now structured as a per-airline worker registry in `automation-workers.mjs`, which is where real browser workers should be implemented next.
- Award workers can now load normalized award segments from per-program import paths such as `UNITED_AWARD_IMPORT_PATH` and `SOUTHWEST_AWARD_IMPORT_PATH`, giving the app a real-data import seam before browser automation is implemented.
- Award workers can also use inline request imports pasted into the local UI, which makes one-off award exports testable without changing `.env`.
- Award import failures are isolated per worker, so a bad or missing import file for one selected program does not prevent other configured programs from contributing results.
- Award imports now reject segments without positive cash/reference fares, positive miles, positive duration, and valid taxes/stops instead of allowing bad data into ranking.
- Award-only imported segments no longer generate cash or card-travel payment options, preventing reference fares from being ranked as bookable cash fares.
- Award-only cached segments can rank without reference cash fares; when the baseline is unknown, cpp and cash savings are shown as unknown instead of being treated as zero.
- Seats.aero cached award cards show cached status, last-seen timestamps when available, compact seat/mixed-cabin metadata, sanitized booking links, and transfer caveats.
- If automation workers produce no award candidates because imports fail or return empty windows, the backend falls through to the next award source and keeps the worker failure details in the response.
- The server now returns explicit warnings whenever a non-sample strategy still ends up using sample inventory or sample-backed automation, so the UI exposes development fallback behavior instead of hiding it.
- The browser now treats `/api/providers/search` as the canonical search contract, keeping provider ordering, fallback warnings, diagnostics, and ranking behavior in the backend instead of duplicating resolver logic in the client.
- The browser renders a practical highlighted-options shortlist before the full ranked results and links each card to its stable `option_N` result. Category winners remain available even when one itinerary wins multiple categories.

## Next integration milestones

1. Choose live flight-data providers for cash fares and award inventory, using official APIs first and web automation only as fallback.
2. Expand airport grouping and route coverage beyond the current curated sample set.
3. Implement live credentialed calls in `server.mjs` or move that contract into serverless routes.
4. Replace the sample-backed automation route with a real browser worker for award collection.
5. Expand transfer logic to real airline partners, transfer ratios, and booking constraints.
