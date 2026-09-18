import assert from "node:assert/strict";
import test from "node:test";
import {
  carryOnCostForSegment,
  resolveCarryOnAllowance,
} from "../baggage-policy.mjs";
import { analyzeSearch } from "../search-engine.mjs";
import { normalizeAndValidateSearchState } from "../search-state.mjs";

test("provider-reported baggage overrides inferred airline and fare rules", () => {
  const allowance = resolveCarryOnAllowance({
    airline: "Frontier Airlines",
    cabin: "economy",
    flightSegments: [{ extensions: ["Basic fare"] }],
    providerEvidence: [{ baggage: { together: ["1 free carry-on"] } }],
  });

  assert.equal(allowance.status, "included");
  assert.equal(allowance.confidence, "confirmed");
  assert.equal(allowance.source, "provider-reported");
  assert.equal(allowance.fareFamily, "basic");
});

test("Frontier Basic receives a configurable carry-on estimate unless SerpApi priced the bag", () => {
  const segment = {
    airline: "Frontier",
    cabin: "economy",
    flightSegments: [{ extensions: ["Basic fare"] }],
  };
  const inferred = resolveCarryOnAllowance(segment, { fallbackFeeDollars: 55 });
  assert.equal(inferred.status, "fee-required");
  assert.equal(inferred.confidence, "inferred");
  assert.equal(carryOnCostForSegment(inferred, 2), 110);

  const priced = resolveCarryOnAllowance({
    ...segment,
    providerEvidence: [{ provider: "serpapi-google-flights", requestedCarryOnBags: 2 }],
  }, { fallbackFeeDollars: 55 });
  assert.equal(priced.priceIncludesRequestedCarryOn, true);
  assert.equal(carryOnCostForSegment(priced, 2), 0);
});

test("Seats.aero-style award results use the versioned airline fallback", () => {
  const allowance = resolveCarryOnAllowance({
    airline: "United Airlines",
    cabin: "economy",
    provider: "seats-aero",
    flightSegments: [{ fareClass: "X" }],
  }, { bookingType: "award" });

  assert.equal(allowance.status, "included");
  assert.equal(allowance.source, "airline-rule");
  assert.equal(allowance.fareFamily, "award");
  assert.equal(allowance.confidence, "inferred");
});

test("a bare United Economy label stays unknown while a SerpApi bag request still covers price", () => {
  const allowance = resolveCarryOnAllowance({
    airline: "United",
    cabin: "economy",
    providerEvidence: [{ provider: "serpapi-google-flights", requestedCarryOnBags: 1 }],
  });

  assert.equal(allowance.status, "unknown");
  assert.equal(allowance.fareFamily, "unknown");
  assert.equal(allowance.priceIncludesRequestedCarryOn, true);
  assert.equal(carryOnCostForSegment(allowance, 1), 0);
});

test("known carry-on fees change cash ranking and effective cost", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    tripType: "one-way",
    origin: "DEN",
    destination: "LAS",
    earliestDeparture: "2026-10-10",
    latestDeparture: "2026-10-10",
    cabinPreference: "economy",
    maxStops: 0,
    dataStrategy: "sample-only",
    awardDataMode: "cash-only",
    carryOnBagsPerTraveler: 1,
    carryOnFallbackFeeDollars: 60,
  });
  assert.deepEqual(errors, []);

  const common = {
    origin: "DEN",
    destination: "LAS",
    departure: "2026-10-10T09:00:00",
    arrival: "2026-10-10T10:30:00",
    cabin: "economy",
    stops: 0,
    durationMinutes: 90,
    cashAvailable: true,
    awardOptions: [],
  };
  const result = analyzeSearch(searchState, [
    {
      ...common,
      airline: "Frontier",
      cashPrice: 100,
      flightSegments: [{ extensions: ["Basic fare"] }],
    },
    {
      ...common,
      airline: "American Airlines",
      cashPrice: 140,
      flightSegments: [{ extensions: ["Basic Economy"] }],
    },
  ]);

  assert.equal(result.itineraries[0].outbound.airline, "American Airlines");
  const frontier = result.itineraries.find((item) => item.outbound.airline === "Frontier");
  assert.equal(frontier.cashOutlay, 160);
  assert.equal(frontier.valueBreakdown.carryOnCost, 60);
  assert.equal(frontier.carryOn.status, "fee-required");
  assert(frontier.riskFlags.includes("carry-on-fee-required"));
});
