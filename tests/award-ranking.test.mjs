import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSearch } from "../search-engine.mjs";
import { normalizeAndValidateSearchState } from "../search-state.mjs";

const TRANSFER_CONFIRMATION_CAVEAT =
  "Confirm the award is still available at the same mileage price and taxes before transferring points.";
const RESERVATION_CAVEAT =
  "Same-airline pairing does not confirm a single reservation or protected connection; verify the seller issues one ticket.";

const BASE_SEARCH = {
  origin: "IAH",
  destination: "JFK",
  useNearbyAirports: false,
  earliestDeparture: "2026-10-01",
  latestDeparture: "2026-10-01",
  earliestReturn: "2026-10-05",
  latestReturn: "2026-10-05",
  minStayNights: 3,
  maxStayNights: 6,
  departureTimePreference: "any",
  returnTimePreference: "any",
  timePreferenceMode: "hard",
  cabinPreference: "economy",
  maxStops: 1,
  dataStrategy: "sample-only",
  awardDataMode: "cash-and-awards",
  awardPrograms: ["united"],
  balances: {
    amex: 0,
    chase: 30000,
    united: 0,
  },
  thresholds: {
    amex: 1.5,
    chase: 1.25,
    airline: 1.1,
  },
  valuations: {
    amex: 1.6,
    chase: 1.5,
    airline: 1.3,
  },
  redemptionRates: {
    amexTravel: 0,
    chaseTravel: 0,
  },
  transferRatios: {
    chase: {
      united: 1,
    },
  },
};

test("award-only segments with unknown cash reference rank without NaN", () => {
  const analysis = analyzeSearch(buildSearchState(), buildAwardOnlySegments());
  const top = analysis.itineraries[0];

  assert(top);
  assertNoNonFiniteNumbers(top);
  assert.equal(top.valueBreakdown.referenceCashPrice, null);
  assert.equal(top.valueBreakdown.cashSavings, null);
  assert.equal(top.centsPerPoint, null);
  assert.equal(top.paymentBreakdown.every((item) => item.referenceCashPrice === null), true);
  assert.equal(top.paymentBreakdown.every((item) => item.cashSavings === null), true);
  assert.match(top.explanation, /cpp is unavailable/);
  assert.doesNotMatch(top.explanation, /minimum cpp thresholds/);
});

test("award-only effective cost uses taxes plus point opportunity cost", () => {
  const analysis = analyzeSearch(buildSearchState(), buildAwardOnlySegments());
  const top = analysis.itineraries[0];

  assert.equal(top.cashOutlay, 11.2);
  assert.equal(top.valueBreakdown.pointOpportunityCost, 375);
  assert.equal(top.valueBreakdown.paymentEffectiveCost, 386.2);
  assert.equal(top.effectiveCost, 386.2);
});

test("transfer-funded award winners include transfer confirmation caveat", () => {
  const analysis = analyzeSearch(buildSearchState(), buildAwardOnlySegments());
  const top = analysis.itineraries[0];

  assert.equal(top.label, "Outbound transfer Chase to United + Return transfer Chase to United");
  assert.deepEqual(top.caveats, [TRANSFER_CONFIRMATION_CAVEAT, RESERVATION_CAVEAT]);
  assert.equal(top.paymentBreakdown.every((item) => item.caveats.includes(TRANSFER_CONFIRMATION_CAVEAT)), true);
});

test("direct airline mile winners do not include transfer confirmation caveat", () => {
  const searchState = buildSearchState({
    balances: {
      ...BASE_SEARCH.balances,
      chase: 0,
      united: 30000,
    },
  });
  const analysis = analyzeSearch(searchState, buildAwardOnlySegments());
  const top = analysis.itineraries[0];

  assert.equal(top.label, "Outbound United balance + Return United balance");
  assert.deepEqual(top.caveats, [RESERVATION_CAVEAT]);
  assert.equal(top.paymentBreakdown.every((item) => item.caveats.length === 0), true);
});

test("cash and card-travel options do not receive transfer confirmation caveats", () => {
  const searchState = buildSearchState({
    awardDataMode: "cash-only",
    balances: {
      ...BASE_SEARCH.balances,
      chase: 50000,
    },
    redemptionRates: {
      amexTravel: 0,
      chaseTravel: 1.25,
    },
  });
  const analysis = analyzeSearch(searchState, buildCashSegments());
  const top = analysis.itineraries[0];

  assert.equal(top.label, "Outbound Chase travel redemption + Return Chase travel redemption");
  assert.deepEqual(top.caveats, [RESERVATION_CAVEAT]);
  assert.equal(top.paymentBreakdown.every((item) => item.caveats.length === 0), true);
  assert.equal(top.paymentBreakdown.every((item) => item.redemptionType === "card-travel"), true);
});

test("award diagnostics explain balance shortfalls and coverage gaps", () => {
  const insufficient = analyzeSearch(buildSearchState({
    balances: {
      ...BASE_SEARCH.balances,
      chase: 5000,
    },
  }), buildAwardOnlySegments());
  const shortfall = insufficient.diagnostics.awardRejectionDetails.find(
    (detail) => detail.reason === "insufficient-transfer-balance"
  );

  assert(shortfall);
  assert.equal(shortfall.requiredPoints, 12500);
  assert.equal(shortfall.availablePoints, 5000);
  assert.equal(shortfall.shortfall, 7500);
  assert.equal(insufficient.diagnostics.awardProgramCoverage.united.options, 2);

  const noSpace = analyzeSearch(buildSearchState({ awardPrograms: ["delta"] }), buildAwardOnlySegments());
  assert.equal(noSpace.diagnostics.awardProgramCoverage.delta.options, 0);
});

function buildSearchState(overrides = {}) {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...BASE_SEARCH,
    ...overrides,
  });

  assert.deepEqual(errors, []);
  return searchState;
}

function buildAwardOnlySegments() {
  return [
    {
      id: "outbound-award-only",
      airline: "United",
      flightNumber: "UA100",
      origin: "IAH",
      destination: "JFK",
      departure: "2026-10-01T09:00:00-05:00",
      arrival: "2026-10-01T13:30:00-04:00",
      durationMinutes: 210,
      stops: 0,
      cabin: "economy",
      cashPrice: null,
      cashAvailable: false,
      awardOptions: [{ program: "united", miles: 12500, taxes: 5.6 }],
    },
    {
      id: "return-award-only",
      airline: "United",
      flightNumber: "UA101",
      origin: "JFK",
      destination: "IAH",
      departure: "2026-10-05T10:00:00-04:00",
      arrival: "2026-10-05T13:00:00-05:00",
      durationMinutes: 240,
      stops: 0,
      cabin: "economy",
      cashPrice: undefined,
      cashAvailable: false,
      awardOptions: [{ program: "united", miles: 12500, taxes: 5.6 }],
    },
  ];
}

function buildCashSegments() {
  return [
    {
      id: "outbound-cash",
      airline: "United",
      flightNumber: "UA200",
      origin: "IAH",
      destination: "JFK",
      departure: "2026-10-01T09:00:00-05:00",
      arrival: "2026-10-01T13:30:00-04:00",
      durationMinutes: 210,
      stops: 0,
      cabin: "economy",
      cashPrice: 200,
      awardOptions: [],
    },
    {
      id: "return-cash",
      airline: "United",
      flightNumber: "UA201",
      origin: "JFK",
      destination: "IAH",
      departure: "2026-10-05T10:00:00-04:00",
      arrival: "2026-10-05T13:00:00-05:00",
      durationMinutes: 240,
      stops: 0,
      cabin: "economy",
      cashPrice: 200,
      awardOptions: [],
    },
  ];
}

function assertNoNonFiniteNumbers(value, path = "value") {
  if (typeof value === "number") {
    assert.equal(Number.isFinite(value), true, `${path} should be finite`);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    assertNoNonFiniteNumbers(child, `${path}.${key}`);
  }
}
