---
name: flight-search
description: Search and rank flights for a trip, comparing cash fares against airline miles and transferable card points (Amex MR, Chase UR). Use when asked to find flights, price a trip, compare booking options, decide whether to pay cash or burn points, check award availability, or explore flexible departure/return dates. Drives this project's `node cli.mjs` search pipeline.
---

# Flight search

Run bounded flight searches through `cli.mjs`, which loads `.env`, queries the
configured providers, and returns a ranked JSON decision packet. Always run it
from the repository root - the CLI resolves providers and sample data relative
to that directory.

## Run a search

Round-trip with flexible windows and nearby-airport expansion:

```powershell
node cli.mjs search --origin IAH --destination NYC --nearby --depart 2026-08-05 --depart-by 2026-08-06 --return 2026-08-09 --return-by 2026-08-10 --limit 5
```

One-way:

```powershell
node cli.mjs search --origin IAH --destination JFK --one-way --depart 2026-10-01
```

For anything beyond origin/destination/dates - balances, point valuations, cpp
thresholds, passenger count, cabin, stay length, award programs - write a JSON
request file and pass it in. Flags override matching JSON fields.

```powershell
node cli.mjs search --input query.json --limit 5
node cli.mjs validate --input query.json   # normalize + check without hitting providers
node cli.mjs health                        # which providers have credentials
```

Deterministic local testing without provider requests: add `--strategy sample-only`.
Sample inventory covers Chicago<->LA (Jul 2026), NYC<->LA (Sep 2026), and
Houston<->NYC (Aug 2026); other routes return zero candidates.

## Reading the result

Branch on the JSON result (the CLI uses exit code 0 for candidates, 1 for a
valid search with no candidates, and 2 for invalid input or an unknown
command):

- `ok: false` with `code` (`VALIDATION_ERROR`, `INPUT_ERROR`, `UNKNOWN_COMMAND`)
  -> bad request. `errors[]` names each problem; fix and rerun.
- `outcome.status: "candidates-found"` -> report several distinct options
  from `candidates[]`, in ranked order; do not report only `candidates[0]`.
  Return up to five options when available, or all available options when
  fewer than five were found.
- `outcome.status: "no-candidates"` -> this is a normal result, not a crash.
  Read `outcome.reasonCodes` and `diagnosticSummary` to say why, then relay
  `recommendations[]`. Common causes: route absent from inventory
  (`NO_OUTBOUND_CANDIDATES` with a high `outboundRejectedAirport`), date window
  too narrow, or cpp/balance rules rejecting every award path
  (`PAYMENT_RULES_REJECTED`).

Each candidate carries `optionId`, `route`, `dates`, `effectiveCost`,
`durationMinutes`, a `flightDetails` block, and a `payment` block with `method` (`cash`,
`airline-miles`, `points-transfer`, `card-travel`, or `mixed`), `cashOutlay`,
`pointsUsed`, `centsPerPoint`, and a per-leg `breakdown`. Lead with
`effectiveCost` and `payment.method`; that pair is the actual recommendation.

For every option you report, include the airline, flight number(s), outbound
and return airports, local departure and arrival times, stops, and duration
from `flightDetails.outbound` and `flightDetails.return`. Also include the
cash price or points cost and the important caveats. The `flightDetails.*.flights`
array contains segment-level details for connections. The default search limit
is five; pass `--limit 5` explicitly when calling the CLI so the response has
enough alternatives for comparison.

Also surface, when non-empty:

- `warnings[]` - especially any note that a non-sample strategy fell back to
  sample inventory. Never present sample-backed results as real fares.
- `candidates[].caveats` - award listings from Seats.aero are cached, not
  confirmed. Repeat the caveat verbatim before anyone transfers points.
- `coverage.cachedAwards` / `candidates[].verification` -
  `discovered_cached` means the price must be reconfirmed with the airline.
- `insights.bestByDepartureDate` / `bestByStayLength` - the tradeoff tables for
  flexible-date questions.

Add `--full` only when provider evidence, booking tokens/links, or additional
normalized segment fields are actually needed; compact results already include
the flight details needed to compare options. Use `--pretty` for human
reading; the default is compact for machine parsing.

## Request JSON shape

```json
{
  "origin": "IAH",
  "destination": "NYC",
  "tripType": "round-trip",
  "useNearbyAirports": true,
  "earliestDeparture": "2026-08-05",
  "latestDeparture": "2026-08-06",
  "earliestReturn": "2026-08-09",
  "latestReturn": "2026-08-10",
  "passengers": { "adults": 2 },
  "minStayNights": 3,
  "maxStayNights": 7,
  "cabinPreference": "economy",
  "maxStops": 1,
  "rankingFocus": "cash-first",
  "dataStrategy": "official-first",
  "awardDataMode": "cash-and-awards",
  "awardPrograms": ["united", "southwest"],
  "balances": { "amex": 120000, "chase": 80000, "united": 45000 },
  "thresholds": { "amex": 1.5, "chase": 1.5, "airline": 1.3 },
  "valuations": { "amex": 1.8, "chase": 1.9, "airline": 1.4 }
}
```

Enumerations (anything else fails validation):

- `tripType`: `round-trip` | `one-way`
- `cabinPreference`: `any` | `economy` | `premium-economy` | `business`
- `rankingFocus`: `cash-first` | `effective-cost` | `fastest`
- `dataStrategy`: `official-first` | `official-then-automation` | `sample-only`
- `awardDataMode`: `cash-and-awards` | `cash-only`
- `awardPrograms` / airline `balances` keys: `united`, `delta`, `jetblue`,
  `frontier`, `southwest`, `american`, `alaska`
- `departureTimePreference` / `returnTimePreference`: `any` | `morning` |
  `afternoon` | `evening`, with `timePreferenceMode` `soft` (default, applies
  `timePreferencePenaltyDollars`) or `hard` (filters segments out)

`thresholds` are minimum cents-per-point floors - an award path below the floor
is rejected rather than ranked. `valuations` are what a point is worth to the
traveler, used for effective-cost math.

## Before promising anything

Run `node cli.mjs health` when results look thin. With `official-first`, live
cash results require SerpApi credentials and award results use the configured
Seats.aero cache; the app does not silently substitute local sample flights
when an official provider fails. A sample result is available only when the
request explicitly uses `dataStrategy: "sample-only"`. Say this plainly rather
than presenting a sample-backed number as a live fare.

No result from this tool is a booking. Price and availability must be confirmed
with the seller, and cached award space must be confirmed with the airline at
the same mileage price and taxes before transferring points.
