import assert from "node:assert/strict";
import test from "node:test";
import { createOptimizerService } from "../optimizer-service.mjs";
import { normalizeAndValidateSearchState } from "../search-state.mjs";

const BASE_SEARCH = {
  origin: "IAH",
  destination: "JFK",
  earliestDeparture: "2026-10-01",
  latestDeparture: "2026-10-01",
  earliestReturn: "2026-10-05",
  latestReturn: "2026-10-05",
  minStayNights: 3,
  maxStayNights: 6,
  dataStrategy: "sample-only",
  awardDataMode: "cash-and-awards",
  awardPrograms: ["united"],
  balances: { chase: 30000 },
  thresholds: { chase: 1.25, airline: 1.1 },
  valuations: { chase: 1.5, airline: 1.3 },
  transferRatios: { chase: { united: 1 } },
};

function buildSearchState() {
  const { searchState, errors } = normalizeAndValidateSearchState(BASE_SEARCH);
  assert.deepEqual(errors, []);
  return searchState;
}

function segment(overrides = {}) {
  return {
    origin: "IAH",
    destination: "JFK",
    departure: "2026-10-01T09:00:00-05:00",
    arrival: "2026-10-01T13:30:00-04:00",
    airline: "United",
    cabin: "economy",
    stops: 0,
    durationMinutes: 210,
    cashPrice: 220,
    cashAvailable: true,
    awardOptions: [],
    ...overrides,
  };
}

test("optimizer service calls injected providers and returns ranked results", async () => {
  const calls = [];
  const service = createOptimizerService({
    async resolveCashSegments(searchState, attempts) {
      calls.push(["cash", searchState.origin]);
      attempts.push({ name: "test-cash", outcome: "loaded 2 cash segment candidates" });
      return { providerName: "Test Cash", providerType: "test", segments: [segment(), segment({
        origin: "JFK",
        destination: "IAH",
        departure: "2026-10-05T10:00:00-04:00",
        arrival: "2026-10-05T12:30:00-05:00",
      })], notes: [] };
    },
    async resolveAwardSegments(searchState) {
      calls.push(["awards", searchState.awardPrograms[0]]);
      return { providerName: "Test Awards", providerType: "test", segments: [], workers: [] };
    },
  });

  const result = await service.resolveSearch(buildSearchState());

  assert.deepEqual(calls, [["cash", "IAH"], ["awards", "united"]]);
  assert.equal(result.sources.length, 2);
  assert.equal(result.itineraries.length, 1);
  assert.deepEqual(
    result.highlightedCandidates.map(({ category, optionId }) => [category, optionId]),
    [
      ["bestOverall", "option_1"],
      ["cheapest", "option_1"],
      ["bestSchedule", "option_1"],
      ["fastest", "option_1"],
      ["bestAward", "option_1"],
    ]
  );
  assert.equal(result.attempts[0].name, "test-cash");
});

test("optimizer service preserves cash and award provenance when observations merge", async () => {
  const shared = segment({
    sourceProviderId: "cash-source",
    sourceProviderName: "Cash Source",
    sourceCapability: "cash",
  });
  const award = segment({
    cashPrice: null,
    cashAvailable: false,
    sourceProviderId: "award-source",
    sourceProviderName: "Award Source",
    sourceCapability: "awards",
    awardOptions: [{ program: "united", miles: 12500, taxes: 5.6 }],
    automationWorkerName: "United Worker",
    automationProgram: "united",
  });
  const service = createOptimizerService({
    async resolveCashSegments() {
      return { providerName: "Cash Source", providerType: "test", segments: [shared] };
    },
    async resolveAwardSegments() {
      return { providerName: "Award Source", providerType: "test", segments: [award], workers: [] };
    },
  });

  const result = await service.resolveSearch(buildSearchState());
  const merged = result.segments[0];

  assert.equal(result.segments.length, 1, "matching observations should merge");
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.awardOptions.length, 1);
  assert.equal(merged.automationDetails[0].program, "united");
});
