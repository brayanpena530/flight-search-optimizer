import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAutomationWorkers } from "../automation-workers.mjs";
import { analyzeSearch, buildHighlightedCandidates, buildSearchInsights } from "../search-engine.mjs";
import { AIRLINE_PROGRAMS, TRANSFER_PARTNERS, expandAirports } from "../search-config.mjs";
import { normalizeAndValidateSearchState } from "../search-state.mjs";

const HOUSTON_NEW_YORK_SEARCH = {
  origin: "HOU",
  destination: "NYC",
  useNearbyAirports: true,
  earliestDeparture: "2026-08-05",
  latestDeparture: "2026-08-06",
  earliestReturn: "2026-08-09",
  latestReturn: "2026-08-10",
  minStayNights: 3,
  maxStayNights: 5,
  departureTimePreference: "morning",
  returnTimePreference: "morning",
  timePreferenceMode: "soft",
  cabinPreference: "economy",
  maxStops: 1,
  dataStrategy: "sample-only",
  awardDataMode: "cash-and-awards",
  awardPrograms: ["united", "southwest"],
  balances: {
    amex: 85000,
    chase: 65000,
    united: 22000,
    delta: 0,
    jetblue: 0,
    frontier: 0,
    southwest: 12000,
    american: 0,
    alaska: 0,
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
    amexTravel: 1,
    chaseTravel: 1.25,
  },
  transferRatios: {
    amex: {
      delta: 1,
      jetblue: 1,
    },
    chase: {
      united: 1,
      southwest: 1,
      jetblue: 1,
    },
  },
};

test("one-way search state does not require a return window and produces single-leg itineraries", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    tripType: "one-way",
    earliestReturn: undefined,
    latestReturn: undefined,
  });
  assert.deepEqual(errors, []);
  assert.equal(searchState.tripType, "one-way");

  const analysis = analyzeSearch(searchState, [{
    origin: "IAH",
    destination: "JFK",
    departure: "2026-08-05T08:00:00",
    arrival: "2026-08-05T12:00:00",
    airline: "United",
    cabin: "economy",
    stops: 0,
    durationMinutes: 240,
    cashPrice: 180,
    cashAvailable: true,
    awardOptions: [],
  }]);
  assert.equal(analysis.itineraries.length, 1);
  assert.equal(analysis.itineraries[0].inbound, null);
  assert.equal(analysis.itineraries[0].totalDurationMinutes, 240);
  assert.equal(analysis.itineraries[0].paymentBreakdown.length, 1);
});

test("itineraries expose air time, layover, overnight, and quality-risk metrics", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    origin: "IAH",
    destination: "SAN",
    useNearbyAirports: false,
    earliestDeparture: "2026-10-07",
    latestDeparture: "2026-10-07",
    earliestReturn: "2026-10-11",
    latestReturn: "2026-10-11",
    awardDataMode: "cash-only",
    maxStops: 1,
  });
  assert.deepEqual(errors, []);

  const analysis = analyzeSearch(searchState, [
    {
      origin: "IAH",
      destination: "SAN",
      departure: "2026-10-07T18:00:00",
      arrival: "2026-10-08T03:00:00",
      airline: "Example Air",
      cabin: "economy",
      stops: 1,
      durationMinutes: 540,
      cashPrice: 120,
      cashAvailable: true,
      awardOptions: [],
      flightSegments: [
        { departure: "2026-10-07T18:00:00", arrival: "2026-10-07T19:00:00" },
        { departure: "2026-10-08T02:00:00", arrival: "2026-10-08T03:00:00" },
      ],
    },
    {
      origin: "SAN",
      destination: "IAH",
      departure: "2026-10-11T08:00:00",
      arrival: "2026-10-11T11:00:00",
      airline: "Example Air",
      cabin: "economy",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 120,
      cashAvailable: true,
      awardOptions: [],
    },
  ]);

  const itinerary = analysis.itineraries[0];
  assert.equal(itinerary.travelMetrics.totalAirMinutes, 300);
  assert.equal(itinerary.travelMetrics.totalLayoverMinutes, 420);
  assert.equal(itinerary.travelMetrics.longestLayoverMinutes, 420);
  assert.equal(itinerary.travelMetrics.stops, 1);
  assert.equal(itinerary.travelMetrics.overnight, true);
  assert(itinerary.riskFlags.includes("long-layover"));
  assert(itinerary.riskFlags.includes("overnight-travel"));
  assert(itinerary.qualityPenalty > 0);
  assert.equal(itinerary.ticketing.type, "same-airline-pairing");
  assert.equal(itinerary.ticketing.reservationStatus, "unknown");
  assert.match(itinerary.caveats[0], /does not confirm a single reservation/);

  const mixedAnalysis = analyzeSearch(searchState, [
    analysis.itineraries[0].outbound,
    {
      ...analysis.itineraries[0].inbound,
      airline: "Different Air",
    },
  ]);
  const mixedItinerary = mixedAnalysis.itineraries[0];
  assert.equal(mixedItinerary.ticketing.type, "separate-one-way-tickets");
  assert.equal(mixedItinerary.ticketing.ticketCount, 2);
  assert.equal(mixedItinerary.ticketing.connectionProtection, "not-protected-across-tickets");
  assert(mixedItinerary.riskFlags.includes("baggage-rules-may-differ"));
  assert(mixedItinerary.riskFlags.includes("missed-connection-not-protected"));
});

test("search insights expose separate practical ranking categories", () => {
  const itineraries = [
    {
      outbound: { departure: "2026-10-07T08:00:00" },
      inbound: { departure: "2026-10-11T08:00:00" },
      cashOutlay: 200,
      effectiveCost: 200,
      pointsUsed: 0,
      totalDurationMinutes: 300,
      travelMetrics: { totalLayoverMinutes: 60, overnight: false },
      riskFlags: [],
    },
    {
      outbound: { departure: "2026-10-07T08:00:00" },
      inbound: { departure: "2026-10-11T08:00:00" },
      cashOutlay: 150,
      effectiveCost: 150,
      pointsUsed: 0,
      totalDurationMinutes: 900,
      travelMetrics: { totalLayoverMinutes: 660, overnight: true },
      riskFlags: ["long-layover", "overnight-travel"],
    },
    {
      outbound: { departure: "2026-10-07T08:00:00" },
      inbound: { departure: "2026-10-11T08:00:00" },
      cashOutlay: 50,
      effectiveCost: 250,
      pointsUsed: 20000,
      totalDurationMinutes: 360,
      travelMetrics: { totalLayoverMinutes: 120, overnight: false },
      riskFlags: [],
    },
  ];
  const insights = buildSearchInsights(itineraries);

  assert.equal(insights.bestByCategory.cheapest, itineraries[2]);
  assert.equal(insights.bestByCategory.bestSchedule, itineraries[0]);
  assert.equal(insights.bestByCategory.fastest, itineraries[0]);
  assert.equal(insights.bestByCategory.bestCash, itineraries[1]);
  assert.equal(insights.bestByCategory.bestAward, itineraries[2]);
  assert.equal(insights.bestOverall, itineraries[0]);

  const highlights = buildHighlightedCandidates(itineraries, insights);
  assert.deepEqual(
    highlights.map(({ category, optionId }) => [category, optionId]),
    [
      ["bestOverall", "option_1"],
      ["cheapest", "option_3"],
      ["bestSchedule", "option_1"],
      ["fastest", "option_1"],
      ["bestCash", "option_2"],
      ["bestAward", "option_3"],
    ]
  );
});

const CARD_TRAVEL_DISABLED = {
  amexTravel: 0,
  chaseTravel: 0,
};

test("Houston and New York airport groups expand for flexible searches", () => {
  assert.deepEqual(expandAirports("HOU", true), ["IAH", "HOU"]);
  assert.deepEqual(expandAirports("IAH", true), ["IAH", "HOU"]);
  assert.deepEqual(expandAirports("NYC", true), ["JFK", "LGA", "EWR"]);
  assert.deepEqual(expandAirports("HOU", false), ["HOU"]);
});

test("search state validation catches invalid flexible trip input", () => {
  const { errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    origin: "HOU",
    destination: "HOU",
    earliestDeparture: "2026-08-10",
    latestDeparture: "2026-08-05",
    minStayNights: 6,
    maxStayNights: 3,
    passengers: {
      adults: 0,
    },
    rankingFocus: "invalid-focus",
    timePreferencePenaltyDollars: -1,
    redemptionRates: {
      ...HOUSTON_NEW_YORK_SEARCH.redemptionRates,
      chaseTravel: -1,
    },
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      chase: -1,
    },
  });

  assert(errors.includes("Origin and destination must be different airports."));
  assert(errors.includes("Earliest departure cannot be after latest departure."));
  assert(errors.includes("Minimum stay nights cannot exceed maximum stay nights."));
  assert(errors.includes("Adult travelers must be at least 1."));
  assert(errors.includes("Ranking focus is invalid."));
  assert(errors.includes("Soft time preference penalty cannot be negative."));
  assert(errors.includes("ChaseTravel redemption rate cannot be negative."));
  assert(errors.includes("Chase balance cannot be negative."));
});

test("Houston to New York sample search ranks qualifying award itineraries", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  assert.deepEqual(errors, []);

  const analysis = analyzeSearch(searchState, segments);

  assert.deepEqual(analysis.diagnostics.airportScope.origins, ["IAH", "HOU"]);
  assert.deepEqual(analysis.diagnostics.airportScope.destinations, ["JFK", "LGA", "EWR"]);
  assert.equal(analysis.diagnostics.acceptedItineraries, 4);
  assert.equal(analysis.itineraries[0].label, "Outbound Southwest balance + Return United balance");
  assert.equal(analysis.itineraries[0].cashOutlay, 11.2);
});

test("backend search contract returns ranked Houston to New York results", async (t) => {
  const port = 8137;
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/api/providers/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      redemptionRates: CARD_TRAVEL_DISABLED,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.diagnostics.acceptedItineraries, 4);
  assert.deepEqual(payload.diagnostics.airportScope.origins, ["IAH", "HOU"]);
  assert.deepEqual(payload.diagnostics.airportScope.destinations, ["JFK", "LGA", "EWR"]);
  assert.equal(payload.itineraries[0].label, "Outbound Southwest balance + Return United balance");
});

test("Amadeus cash totals are normalized to per-adult segment prices", async (t) => {
  const amadeusPort = 8148;
  const appPort = 8149;
  const fakeAmadeus = await startFakeAmadeusServer(amadeusPort);
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(appPort),
      AMADEUS_BASE_URL: `http://127.0.0.1:${amadeusPort}`,
      AMADEUS_CLIENT_ID: "test-client",
      AMADEUS_CLIENT_SECRET: "test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    await closeServer(fakeAmadeus);
  });

  await waitForServer(appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/providers/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      origin: "IAH",
      destination: "JFK",
      useNearbyAirports: false,
      earliestDeparture: "2026-08-05",
      latestDeparture: "2026-08-05",
      earliestReturn: "2026-08-09",
      latestReturn: "2026-08-09",
      minStayNights: 4,
      maxStayNights: 4,
      dataStrategy: "official-then-automation",
      awardDataMode: "cash-only",
      passengers: {
        adults: 2,
      },
      redemptionRates: CARD_TRAVEL_DISABLED,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.sources[0].name, "Amadeus Flight Offers");
  assert.equal(payload.sources[0].type, "official");
  assert.equal(payload.itineraries[0].label, "Outbound cash + Return cash");
  assert.equal(payload.itineraries[0].passengerCount, 2);
  assert.equal(payload.itineraries[0].cashOutlay, 800);
  assert.equal(payload.itineraries[0].valueBreakdown.referenceCashPrice, 800);
});

test("Amadeus live cabin is read from traveler pricing fare details", async (t) => {
  const amadeusPort = 8158;
  const appPort = 8159;
  const fakeAmadeus = await startConfigurableFakeAmadeus(amadeusPort, {
    offerBuilder: (origin, destination, departureDate) =>
      buildFakeAmadeusOffer(origin, destination, departureDate, { cabin: "BUSINESS" }),
  });
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(appPort),
      AMADEUS_BASE_URL: `http://127.0.0.1:${amadeusPort}`,
      AMADEUS_CLIENT_ID: "test-client",
      AMADEUS_CLIENT_SECRET: "test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    await closeServer(fakeAmadeus);
  });

  await waitForServer(appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/providers/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      origin: "IAH",
      destination: "JFK",
      useNearbyAirports: false,
      earliestDeparture: "2026-08-05",
      latestDeparture: "2026-08-05",
      earliestReturn: "2026-08-09",
      latestReturn: "2026-08-09",
      minStayNights: 4,
      maxStayNights: 4,
      cabinPreference: "business",
      dataStrategy: "official-then-automation",
      awardDataMode: "cash-only",
      redemptionRates: CARD_TRAVEL_DISABLED,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.itineraries[0].outbound.cabin, "business");
  assert.equal(payload.itineraries[0].inbound.cabin, "business");
});

test("Amadeus rate-limit responses are retried instead of aborting the search", async (t) => {
  const amadeusPort = 8160;
  const appPort = 8161;
  const callCounts = new Map();
  const fakeAmadeus = await startConfigurableFakeAmadeus(amadeusPort, {
    // Fail the first attempt for each route with 429, then succeed on retry.
    statusFor: (key) => {
      const count = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, count);
      return count === 1 ? 429 : 200;
    },
  });
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(appPort),
      AMADEUS_BASE_URL: `http://127.0.0.1:${amadeusPort}`,
      AMADEUS_CLIENT_ID: "test-client",
      AMADEUS_CLIENT_SECRET: "test-secret",
      AMADEUS_RETRY_BASE_MS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    await closeServer(fakeAmadeus);
  });

  await waitForServer(appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/providers/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      origin: "IAH",
      destination: "JFK",
      useNearbyAirports: false,
      earliestDeparture: "2026-08-05",
      latestDeparture: "2026-08-05",
      earliestReturn: "2026-08-09",
      latestReturn: "2026-08-09",
      minStayNights: 4,
      maxStayNights: 4,
      dataStrategy: "official-then-automation",
      awardDataMode: "cash-only",
      redemptionRates: CARD_TRAVEL_DISABLED,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.sources[0].name, "Amadeus Flight Offers");
  assert(payload.itineraries.length > 0);
});

test("provider health endpoint reports live Amadeus when credentials authenticate", async (t) => {
  const amadeusPort = 8162;
  const appPort = 8163;
  const fakeAmadeus = await startConfigurableFakeAmadeus(amadeusPort, {});
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(appPort),
      AMADEUS_BASE_URL: `http://127.0.0.1:${amadeusPort}`,
      AMADEUS_CLIENT_ID: "test-client",
      AMADEUS_CLIENT_SECRET: "test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    await closeServer(fakeAmadeus);
  });

  await waitForServer(appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/providers/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  const amadeus = payload.providers.find((provider) => provider.id === "amadeus-flight-offers");
  assert.equal(amadeus.configured, true);
  assert.equal(amadeus.status, "live");
});

test("provider health endpoint reports missing credentials when Amadeus is unconfigured", async (t) => {
  const port = 8164;
  const env = { ...process.env, SERPAPI_API_KEY: "", SEATS_AERO_API_KEY: "", PORT: String(port) };
  delete env.AMADEUS_CLIENT_ID;
  delete env.AMADEUS_CLIENT_SECRET;
  const server = spawn(process.execPath, ["server.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/api/providers/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  const amadeus = payload.providers.find((provider) => provider.id === "amadeus-flight-offers");
  assert.equal(amadeus.configured, false);
  assert.equal(amadeus.status, "missing-credentials");
});

test("backend search falls back to sample awards when automation imports fail", async (t) => {
  const port = 8138;
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(port),
      UNITED_AWARD_IMPORT_PATH: fileURLToPath(new URL("../data/missing-united-awards.json", import.meta.url)),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/api/providers/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      dataStrategy: "official-then-automation",
      awardPrograms: ["united"],
      balances: {
        ...HOUSTON_NEW_YORK_SEARCH.balances,
        united: 30000,
      },
      redemptionRates: CARD_TRAVEL_DISABLED,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert(payload.attempts.some((attempt) => attempt.name === "Award Automation Fallback" && attempt.outcome.includes("failed")));
  assert(payload.sources.some((source) => source.role === "awards" && source.type === "sample"));
  assert(payload.workers.some((worker) => worker.program === "united" && worker.mode === "error"));
  assert(payload.warnings.some((warning) => warning.includes("award automation workers failed")));
  assert(payload.itineraries.length > 0);
});

test("backend search can use inline award imports from the request body", async (t) => {
  const port = 8150;
  const inlineSouthwestImport = JSON.parse(
    await readFile(new URL("../data/southwest-award-import.example.json", import.meta.url), "utf-8")
  );
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      SEATS_AERO_API_KEY: "",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    server.kill();
  });

  await waitForServer(port);

  const response = await fetch(`http://127.0.0.1:${port}/api/providers/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...HOUSTON_NEW_YORK_SEARCH,
      dataStrategy: "official-then-automation",
      awardPrograms: ["southwest"],
      balances: {
        ...HOUSTON_NEW_YORK_SEARCH.balances,
        southwest: 50000,
      },
      redemptionRates: CARD_TRAVEL_DISABLED,
      awardImports: {
        southwest: inlineSouthwestImport,
      },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert(payload.sources.some((source) => source.role === "awards" && source.type === "automation"));
  assert(payload.workers.some((worker) => worker.program === "southwest" && worker.mode === "inline-southwest-awards"));
  assert(payload.itineraries[0].label.includes("Southwest balance"));
});

test("United worker can load normalized award segments from an import file", async (t) => {
  const previousImportPath = process.env.UNITED_AWARD_IMPORT_PATH;
  process.env.UNITED_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/united-award-import.example.json", import.meta.url)
  );
  t.after(() => {
    if (previousImportPath === undefined) {
      delete process.env.UNITED_AWARD_IMPORT_PATH;
    } else {
      process.env.UNITED_AWARD_IMPORT_PATH = previousImportPath;
    }
  });

  const { searchState } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["united"],
  });
  const result = await runAutomationWorkers({
    segments: [],
    searchState,
    matchesFallbackWindow,
  });

  assert.equal(result.attemptedWorkers.length, 1);
  assert.equal(result.attemptedWorkers[0].mode, "imported-united-awards");
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].automationWorkerName, "United Award Worker");
  assert.deepEqual(result.segments[0].awardOptions, [{ program: "united", miles: 12500, taxes: 5.6 }]);
});

test("award workers can load normalized imports for multiple selected programs", async (t) => {
  const previousUnitedImportPath = process.env.UNITED_AWARD_IMPORT_PATH;
  const previousSouthwestImportPath = process.env.SOUTHWEST_AWARD_IMPORT_PATH;
  process.env.UNITED_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/united-award-import.example.json", import.meta.url)
  );
  process.env.SOUTHWEST_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/southwest-award-import.example.json", import.meta.url)
  );
  t.after(() => {
    restoreEnvValue("UNITED_AWARD_IMPORT_PATH", previousUnitedImportPath);
    restoreEnvValue("SOUTHWEST_AWARD_IMPORT_PATH", previousSouthwestImportPath);
  });

  const { searchState } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["united", "southwest"],
  });
  const result = await runAutomationWorkers({
    segments: [],
    searchState,
    matchesFallbackWindow,
  });

  assert.deepEqual(
    result.attemptedWorkers.map((worker) => [worker.program, worker.mode, worker.outcome]),
    [
      ["united", "imported-united-awards", "loaded 2 segment candidates"],
      ["southwest", "imported-southwest-awards", "loaded 2 segment candidates"],
    ]
  );
  assert.equal(result.segments.length, 4);
  assert.deepEqual(
    new Set(result.segments.map((segment) => segment.automationProgram)),
    new Set(["united", "southwest"])
  );
});

test("award import failures are isolated to the failing worker", async (t) => {
  const previousUnitedImportPath = process.env.UNITED_AWARD_IMPORT_PATH;
  const previousSouthwestImportPath = process.env.SOUTHWEST_AWARD_IMPORT_PATH;
  process.env.UNITED_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/missing-united-awards.json", import.meta.url)
  );
  process.env.SOUTHWEST_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/southwest-award-import.example.json", import.meta.url)
  );
  t.after(() => {
    restoreEnvValue("UNITED_AWARD_IMPORT_PATH", previousUnitedImportPath);
    restoreEnvValue("SOUTHWEST_AWARD_IMPORT_PATH", previousSouthwestImportPath);
  });

  const { searchState } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["united", "southwest"],
  });
  const result = await runAutomationWorkers({
    segments: [],
    searchState,
    matchesFallbackWindow,
  });

  assert.equal(result.attemptedWorkers.length, 2);
  assert.equal(result.attemptedWorkers[0].program, "united");
  assert.equal(result.attemptedWorkers[0].mode, "error");
  assert(result.attemptedWorkers[0].outcome.startsWith("failed:"));
  assert.equal(result.attemptedWorkers[1].mode, "imported-southwest-awards");
  assert.equal(result.segments.length, 2);
  assert(result.segments.every((segment) => segment.automationProgram === "southwest"));
});

test("award imports require positive reference cash fares for cost comparisons", async (t) => {
  const previousUnitedImportPath = process.env.UNITED_AWARD_IMPORT_PATH;
  const previousSouthwestImportPath = process.env.SOUTHWEST_AWARD_IMPORT_PATH;
  process.env.UNITED_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/invalid-award-import.example.json", import.meta.url)
  );
  process.env.SOUTHWEST_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/southwest-award-import.example.json", import.meta.url)
  );
  t.after(() => {
    restoreEnvValue("UNITED_AWARD_IMPORT_PATH", previousUnitedImportPath);
    restoreEnvValue("SOUTHWEST_AWARD_IMPORT_PATH", previousSouthwestImportPath);
  });

  const { searchState } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["united", "southwest"],
  });
  const result = await runAutomationWorkers({
    segments: [],
    searchState,
    matchesFallbackWindow,
  });

  assert.equal(result.attemptedWorkers[0].program, "united");
  assert.equal(result.attemptedWorkers[0].mode, "error");
  assert(result.attemptedWorkers[0].outcome.includes("positive cashPrice or referenceCashPrice"));
  assert.equal(result.attemptedWorkers[1].mode, "imported-southwest-awards");
  assert.equal(result.segments.length, 2);
  assert(result.segments.every((segment) => segment.cashPrice > 0));
});

test("award-only imports do not create cash or card-travel payment options", async (t) => {
  const previousSouthwestImportPath = process.env.SOUTHWEST_AWARD_IMPORT_PATH;
  process.env.SOUTHWEST_AWARD_IMPORT_PATH = fileURLToPath(
    new URL("../data/southwest-award-import.example.json", import.meta.url)
  );
  t.after(() => {
    restoreEnvValue("SOUTHWEST_AWARD_IMPORT_PATH", previousSouthwestImportPath);
  });

  const { searchState: awardSearch } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["southwest"],
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      southwest: 50000,
    },
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  const automationResult = await runAutomationWorkers({
    segments: [],
    searchState: awardSearch,
    matchesFallbackWindow,
  });
  assert(automationResult.segments.every((segment) => segment.cashAvailable === false));

  const awardTop = analyzeSearch(awardSearch, automationResult.segments).itineraries[0];
  assert.equal(awardTop.label, "Outbound Southwest balance + Return Southwest balance");
  assert.equal(awardTop.cashOutlay, 11.2);
  assert.equal(awardTop.paymentBreakdown.every((item) => item.program === "southwest"), true);

  const { searchState: cashOnlySearch } = normalizeAndValidateSearchState({
    ...awardSearch,
    awardDataMode: "cash-only",
  });
  const cashOnlyAnalysis = analyzeSearch(cashOnlySearch, automationResult.segments);
  assert.equal(cashOnlyAnalysis.itineraries.length, 0);
  assert.equal(cashOnlyAnalysis.diagnostics.rejectedPaymentRules, 1);
});

test("multi-passenger searches scale award usage and cash totals", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    passengers: {
      adults: 2,
    },
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      united: 50000,
      southwest: 25000,
    },
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  assert.deepEqual(errors, []);

  const analysis = analyzeSearch(searchState, segments);
  const top = analysis.itineraries[0];

  assert.equal(top.passengerCount, 2);
  assert.equal(top.cashOutlay, 22.4);
  assert.equal(top.pointsUsed, 46600);
  assert.deepEqual(top.valueBreakdown, {
    referenceCashPrice: 652,
    cashOutlay: 22.4,
    pointOpportunityCost: 605.8,
    cashSavings: 629.6,
    paymentEffectiveCost: 628.2,
    timePreferencePenalty: 18,
    effectiveCost: 646.2,
  });
  assert.deepEqual(
    top.balanceImpact
      .filter((item) => item.used > 0)
      .map((item) => ({ program: item.program, startingBalance: item.startingBalance, used: item.used, remaining: item.remaining })),
    [
      { program: "united", startingBalance: 50000, used: 25000, remaining: 25000 },
      { program: "southwest", startingBalance: 25000, used: 21600, remaining: 3400 },
    ]
  );
  assert.deepEqual(
    top.paymentBreakdown.map((item) => ({
      program: item.program,
      pointsUsed: item.pointsUsed,
      awardMiles: item.awardMiles,
      cashOutlay: item.cashOutlay,
      pointOpportunityCost: item.pointOpportunityCost,
      cashSavings: item.cashSavings,
    })),
    [
      {
        program: "southwest",
        pointsUsed: 21600,
        awardMiles: 21600,
        cashOutlay: 11.2,
        pointOpportunityCost: 280.8,
        cashSavings: 272.8,
      },
      {
        program: "united",
        pointsUsed: 25000,
        awardMiles: 25000,
        cashOutlay: 11.2,
        pointOpportunityCost: 325,
        cashSavings: 356.8,
      },
    ]
  );
});


test("soft time preference penalty is configurable in effective cost", () => {
  const segments = [
    {
      origin: "IAH",
      destination: "NYC",
      airline: "CashAir",
      cabin: "economy",
      departure: "2026-08-05T20:00:00",
      arrival: "2026-08-05T23:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 100,
      awardOptions: [],
    },
    {
      origin: "NYC",
      destination: "IAH",
      airline: "CashAir",
      cabin: "economy",
      departure: "2026-08-09T20:00:00",
      arrival: "2026-08-09T23:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 100,
      awardOptions: [],
    },
  ];
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    origin: "IAH",
    destination: "NYC",
    useNearbyAirports: false,
    earliestDeparture: "2026-08-05",
    latestDeparture: "2026-08-05",
    earliestReturn: "2026-08-09",
    latestReturn: "2026-08-09",
    minStayNights: 4,
    maxStayNights: 4,
    departureTimePreference: "morning",
    returnTimePreference: "morning",
    timePreferenceMode: "soft",
    timePreferencePenaltyDollars: 50,
    awardDataMode: "cash-only",
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  assert.deepEqual(errors, []);

  const top = analyzeSearch(searchState, segments).itineraries[0];

  assert.equal(top.valueBreakdown.paymentEffectiveCost, 200);
  assert.equal(top.valueBreakdown.timePreferencePenalty, 100);
  assert.equal(top.valueBreakdown.effectiveCost, 300);
});
test("card travel redemptions can offset cash fares when award paths are unavailable", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardDataMode: "cash-only",
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      chase: 30000,
    },
    redemptionRates: {
      amexTravel: 0,
      chaseTravel: 1.25,
    },
  });
  assert.deepEqual(errors, []);

  const analysis = analyzeSearch(searchState, segments);
  const top = analysis.itineraries[0];

  assert.equal(top.label, "Outbound Chase travel redemption + Return Chase travel redemption");
  assert.equal(top.cashOutlay, 0);
  assert.equal(top.pointsUsed, 23440);
  assert.deepEqual(top.usage, { chase: 23440 });
  assert.deepEqual(top.balanceImpact.find((item) => item.program === "chase"), {
    program: "chase",
    label: "Chase",
    startingBalance: 30000,
    used: 23440,
    remaining: 6560,
  });
  assert.deepEqual(top.valueBreakdown, {
    referenceCashPrice: 293,
    cashOutlay: 0,
    pointOpportunityCost: 351.6,
    cashSavings: 293,
    paymentEffectiveCost: 351.6,
    timePreferencePenalty: 36,
    effectiveCost: 387.6,
  });
  assert.deepEqual(
    top.paymentBreakdown.map((item) => ({
      program: item.program,
      redemptionType: item.redemptionType,
      pointsUsed: item.pointsUsed,
      centsPerPoint: item.centsPerPoint,
      pointOpportunityCost: item.pointOpportunityCost,
      cashSavings: item.cashSavings,
    })),
    [
      {
        program: "chase",
        redemptionType: "card-travel",
        pointsUsed: 11360,
        centsPerPoint: 1.25,
        pointOpportunityCost: 170.4,
        cashSavings: 142,
      },
      {
        program: "chase",
        redemptionType: "card-travel",
        pointsUsed: 12080,
        centsPerPoint: 1.25,
        pointOpportunityCost: 181.2,
        cashSavings: 151,
      },
    ]
  );
});

test("effective-cost ranking chooses the cheapest payment method within an itinerary", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardDataMode: "cash-only",
    rankingFocus: "effective-cost",
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      chase: 30000,
    },
    valuations: {
      ...HOUSTON_NEW_YORK_SEARCH.valuations,
      chase: 2,
    },
    redemptionRates: {
      amexTravel: 0,
      chaseTravel: 1.25,
    },
  });
  assert.deepEqual(errors, []);

  const top = analyzeSearch(searchState, segments).itineraries[0];

  assert.equal(top.label, "Outbound cash + Return cash");
  assert.equal(top.cashOutlay, 293);
  assert.equal(top.effectiveCost, 329);
  assert.equal(top.pointsUsed, 0);
});

test("selected award programs constrain airline and transfer redemption options", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["united"],
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      united: 0,
      chase: 65000,
      southwest: 50000,
    },
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  assert.deepEqual(errors, []);

  const analysis = analyzeSearch(searchState, segments);

  assert.equal(analysis.diagnostics.awardOptionsEvaluated, 4);
  assert.equal(analysis.itineraries[0].label, "Outbound transfer Chase to United + Return transfer Chase to United");
  assert.equal(analysis.itineraries[0].usage.chase, 25000);
  assert.equal(analysis.itineraries[0].usage.southwest, undefined);
});

test("omitted award program scope defaults to all known airline programs", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: undefined,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(searchState.awardPrograms, AIRLINE_PROGRAMS.map((program) => program.id));
});

test("American and Alaska balances are normalized as selectable direct award programs", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["american", "alaska"],
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      american: 30000,
      alaska: 25000,
    },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(searchState.awardPrograms, ["american", "alaska"]);
  assert.equal(searchState.balances.american, 30000);
  assert.equal(searchState.balances.alaska, 25000);
});

test("American inline award imports can rank against direct airline miles", async () => {
  const americanImport = {
    segments: [
      {
        origin: "IAH",
        destination: "JFK",
        airline: "American",
        cabin: "economy",
        departure: "2026-08-05T08:00:00",
        arrival: "2026-08-05T12:00:00",
        durationMinutes: 180,
        referenceCashPrice: 330,
        miles: 12000,
        taxes: 5.6,
      },
      {
        origin: "JFK",
        destination: "IAH",
        airline: "American",
        cabin: "economy",
        departure: "2026-08-09T09:00:00",
        arrival: "2026-08-09T13:00:00",
        durationMinutes: 190,
        referenceCashPrice: 340,
        miles: 12500,
        taxes: 5.6,
      },
    ],
  };
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    awardPrograms: ["american"],
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      american: 30000,
    },
    redemptionRates: CARD_TRAVEL_DISABLED,
    awardImports: {
      american: americanImport,
    },
  });
  assert.deepEqual(errors, []);

  const automationResult = await runAutomationWorkers({
    segments: [],
    searchState,
    matchesFallbackWindow,
  });
  const top = analyzeSearch(searchState, automationResult.segments).itineraries[0];

  assert.equal(automationResult.attemptedWorkers[0].mode, "inline-american-awards");
  assert.equal(automationResult.segments.length, 2);
  assert.equal(top.label, "Outbound American balance + Return American balance");
  assert.equal(top.usage.american, 24500);
});

test("ranking focus can prioritize effective cost over lowest cash outlay", () => {
  const segments = [
    {
      origin: "IAH",
      destination: "NYC",
      airline: "United",
      cabin: "economy",
      departure: "2026-08-05T07:00:00",
      arrival: "2026-08-05T10:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 500,
      awardOptions: [{ program: "united", miles: 10000, taxes: 5 }],
    },
    {
      origin: "IAH",
      destination: "NYC",
      airline: "CashAir",
      cabin: "economy",
      departure: "2026-08-06T07:00:00",
      arrival: "2026-08-06T10:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 50,
      awardOptions: [],
    },
    {
      origin: "NYC",
      destination: "IAH",
      airline: "United",
      cabin: "economy",
      departure: "2026-08-09T07:00:00",
      arrival: "2026-08-09T10:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 500,
      awardOptions: [{ program: "united", miles: 10000, taxes: 5 }],
    },
    {
      origin: "NYC",
      destination: "IAH",
      airline: "CashAir",
      cabin: "economy",
      departure: "2026-08-10T07:00:00",
      arrival: "2026-08-10T10:00:00",
      stops: 0,
      durationMinutes: 180,
      cashPrice: 50,
      awardOptions: [],
    },
  ];
  const baseSearch = {
    ...HOUSTON_NEW_YORK_SEARCH,
    origin: "IAH",
    destination: "NYC",
    useNearbyAirports: false,
    earliestDeparture: "2026-08-05",
    latestDeparture: "2026-08-06",
    earliestReturn: "2026-08-09",
    latestReturn: "2026-08-10",
    minStayNights: 3,
    maxStayNights: 5,
    balances: {
      ...HOUSTON_NEW_YORK_SEARCH.balances,
      united: 25000,
    },
    redemptionRates: CARD_TRAVEL_DISABLED,
  };

  const { searchState: cashFirst } = normalizeAndValidateSearchState({
    ...baseSearch,
    rankingFocus: "cash-first",
  });
  const { searchState: effectiveCost } = normalizeAndValidateSearchState({
    ...baseSearch,
    rankingFocus: "effective-cost",
  });

  const cashFirstTop = analyzeSearch(cashFirst, segments).itineraries[0];
  const effectiveCostTop = analyzeSearch(effectiveCost, segments).itineraries[0];

  assert.equal(cashFirstTop.cashOutlay, 10);
  assert.equal(cashFirstTop.pointsUsed, 20000);
  assert.equal(effectiveCostTop.cashOutlay, 100);
  assert.equal(effectiveCostTop.pointsUsed, 0);
});



test("search insights include actionable points and savings tradeoffs", async () => {
  const segments = await loadSampleSegments();
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    redemptionRates: CARD_TRAVEL_DISABLED,
  });
  assert.deepEqual(errors, []);

  const { itineraries } = analyzeSearch(searchState, segments);
  const { buildSearchInsights } = await import("../search-engine.mjs");
  const insights = buildSearchInsights(itineraries, searchState.rankingFocus);
  const firstDeparture = insights.bestByDepartureDate[0];

  assert.equal(firstDeparture.label, "Outbound Southwest balance + Return United balance");
  assert.equal(firstDeparture.pointsUsed, 23300);
  assert.equal(firstDeparture.cashSavings, 314.8);
  assert.equal(firstDeparture.timePreferencePenalty, 18);
});
test("transfer ratio defaults are derived from configured transfer partners", () => {
  const { searchState, errors } = normalizeAndValidateSearchState({
    ...HOUSTON_NEW_YORK_SEARCH,
    transferRatios: {
      amex: {
        delta: 0.8,
      },
      chase: {
        united: 1.2,
      },
    },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(searchState.transferRatios), Object.keys(TRANSFER_PARTNERS));
  assert.equal(searchState.transferRatios.amex.delta, 0.8);
  assert.equal(searchState.transferRatios.amex.jetblue, 1);
  assert.equal(searchState.transferRatios.chase.united, 1.2);
  assert.equal(searchState.transferRatios.chase.southwest, 1);
  assert.equal(searchState.transferRatios.chase.jetblue, 1);
});
test("planner HTML delegates airline controls to metadata-driven app rendering", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf-8");

  assert(html.includes('id="award-program-controls"'));
  assert(html.includes('id="airline-balance-controls"'));
  assert(html.includes('id="transfer-ratio-controls"'));
  assert.equal(html.includes('name="awardProgramUnited"'), false);
  assert.equal(html.includes('name="americanMiles"'), false);
  assert.equal(html.includes('name="amexToDeltaRatio"'), false);
});
async function loadSampleSegments() {
  return JSON.parse(await readFile(new URL("../data/sample-flights.json", import.meta.url), "utf-8"));
}

async function waitForServer(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Server did not start on port ${port}.`);
}

async function startFakeAmadeusServer(port) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "POST" && url.pathname === "/v1/security/oauth2/token") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v2/shopping/flight-offers") {
      const origin = url.searchParams.get("originLocationCode");
      const destination = url.searchParams.get("destinationLocationCode");
      const departureDate = url.searchParams.get("departureDate");
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data: [buildFakeAmadeusOffer(origin, destination, departureDate)] }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

function buildFakeAmadeusOffer(origin, destination, departureDate, options = {}) {
  const offer = {
    price: {
      grandTotal: "400.00",
    },
    validatingAirlineCodes: ["UA"],
    itineraries: [
      {
        duration: "PT3H15M",
        segments: [
          {
            carrierCode: "UA",
            departure: {
              iataCode: origin,
              at: `${departureDate}T08:00:00`,
            },
            arrival: {
              iataCode: destination,
              at: `${departureDate}T11:15:00`,
            },
          },
        ],
      },
    ],
  };

  if (options.cabin) {
    offer.travelerPricings = [
      {
        fareDetailsBySegment: [{ cabin: options.cabin }],
      },
    ];
  }

  return offer;
}

async function startConfigurableFakeAmadeus(port, { offerBuilder, statusFor } = {}) {
  const buildOffer = offerBuilder ?? ((origin, destination, departureDate) => buildFakeAmadeusOffer(origin, destination, departureDate));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === "POST" && url.pathname === "/v1/security/oauth2/token") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v2/shopping/flight-offers") {
      const origin = url.searchParams.get("originLocationCode");
      const destination = url.searchParams.get("destinationLocationCode");
      const departureDate = url.searchParams.get("departureDate");
      const key = `${origin}-${destination}-${departureDate}`;
      const status = statusFor ? statusFor(key) : 200;

      if (status !== 200) {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ errors: [{ status }] }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ data: [buildOffer(origin, destination, departureDate)] }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function matchesFallbackWindow(segment, searchState) {
  const date = segment.departure?.slice(0, 10);
  return (
    (date >= searchState.earliestDeparture && date <= searchState.latestDeparture) ||
    (date >= searchState.earliestReturn && date <= searchState.latestReturn)
  );
}

function restoreEnvValue(key, previousValue) {
  if (previousValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previousValue;
  }
}
