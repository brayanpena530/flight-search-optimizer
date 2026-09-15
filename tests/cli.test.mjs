import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../cli.mjs";

// Never let the repository's local .env credential turn an in-process test into
// a live SerpApi request; provider behavior is covered with injected mocks.
process.env.SERPAPI_API_KEY = "";
process.env.SERPAPI_KEY = "";
process.env.SERP_API_KEY = "";

function capture(stdinText = "") {
  let output = "";
  return {
    io: { stdinText, write: (value) => { output += value; } },
    read: () => JSON.parse(output),
  };
}

const query = {
  origin: "HOU",
  destination: "NYC",
  useNearbyAirports: true,
  earliestDeparture: "2026-08-05",
  latestDeparture: "2026-08-06",
  earliestReturn: "2026-08-09",
  latestReturn: "2026-08-10",
  minStayNights: 3,
  maxStayNights: 5,
  dataStrategy: "sample-only",
  balances: { amex: 85000, chase: 65000, southwest: 12000, united: 22000 },
};

test("CLI validates JSON input and returns a compact ranked packet", async () => {
  const captureResult = capture(JSON.stringify(query));
  const exitCode = await runCli(["search", "--stdin"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 0);
  assert.equal(output.schemaVersion, "1.0");
  assert.equal(output.ok, true);
  assert.ok(output.candidates.length > 0);
  assert.ok(output.candidates.length <= 5);
  assert.equal(output.coverage.cachedAwards, false);
  assert.equal(output.candidates[0].optionId, "option_1");
  assert.equal(output.outcome.status, "candidates-found");
  assert.equal(output.candidates[0].caveats.includes(output.candidates[0].explanation), false);
  assert.ok(output.candidates[0].payment.label);
  assert.equal(output.candidates[0].payment.breakdown.length, 2);
  assert.ok(output.candidates[0].travelMetrics.outbound);
  assert.ok(output.candidates[0].travelMetrics.return);
  assert.ok(Array.isArray(output.candidates[0].riskFlags));
  assert.ok(output.candidates[0].ticketing.type);
  assert.ok(output.candidates[0].bookingLabel);
  assert.ok(Array.isArray(output.candidates[0].caveatBadges));
});

test("compact CLI explains mixed cash and points payments per leg", async () => {
  const captureResult = capture(JSON.stringify({
    ...query,
    balances: { southwest: 10800 },
    redemptionRates: { amexTravel: 0, chaseTravel: 0 },
  }));
  const exitCode = await runCli(["search", "--stdin"], captureResult.io);
  const output = captureResult.read();
  const mixedCandidate = output.candidates.find((candidate) => candidate.payment.method === "mixed");

  assert.equal(exitCode, 0);
  assert.ok(mixedCandidate);
  assert.match(mixedCandidate.payment.label, /cash/);
  assert.deepEqual(
    mixedCandidate.payment.breakdown.map((payment) => payment.method).sort(),
    ["airline-miles", "cash"]
  );
  assert.equal(mixedCandidate.payment.cashOutlay > 0, true);
  assert.equal(mixedCandidate.payment.pointsUsed, 10800);
});

test("full CLI output preserves candidate IDs and moves normalized evidence into details", async () => {
  const captureResult = capture(JSON.stringify(query));
  const exitCode = await runCli(["search", "--stdin", "--full", "--limit", "1"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 0);
  assert.equal(output.outputMode, "full");
  assert.equal(output.candidates.length, 1);
  assert.equal(output.candidates[0].optionId, "option_1");
  assert.ok(output.details.option_1);
  assert.ok(["IAH", "HOU"].includes(output.details.option_1.outbound.origin));
  assert.equal(Object.hasOwn(output, "itineraries"), false);
});

test("compact CLI summarizes why a valid search has no candidates", async () => {
  const captureResult = capture(JSON.stringify({
    ...query,
    origin: "IAH",
    destination: "NYC",
    useNearbyAirports: false,
    earliestDeparture: "2027-01-10",
    latestDeparture: "2027-01-10",
    earliestReturn: "2027-01-15",
    latestReturn: "2027-01-15",
  }));
  const exitCode = await runCli(["search", "--stdin"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 1);
  assert.equal(output.outcome.status, "no-candidates");
  assert.equal(output.outcome.candidateCount, 0);
  assert.ok(output.outcome.message);
  assert.ok(output.outcome.reasonCodes.includes("NO_OUTBOUND_CANDIDATES"));
  assert.ok(output.outcome.reasonCodes.includes("NO_RETURN_CANDIDATES"));
});

test("direct flags preserve flexible departure and return windows", async () => {
  const captureResult = capture();
  const exitCode = await runCli([
    "validate",
    "--origin", "HOU",
    "--destination", "NYC",
    "--depart", "2026-08-05",
    "--depart-by", "2026-08-06",
    "--return", "2026-08-09",
    "--return-by", "2026-08-10",
  ], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 0);
  assert.equal(output.searchState.earliestDeparture, "2026-08-05");
  assert.equal(output.searchState.latestDeparture, "2026-08-06");
  assert.equal(output.searchState.earliestReturn, "2026-08-09");
  assert.equal(output.searchState.latestReturn, "2026-08-10");
});

test("CLI returns a nonzero validation result for incomplete input", async () => {
  const captureResult = capture(JSON.stringify({ origin: "IAH" }));
  const exitCode = await runCli(["validate", "--stdin"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 2);
  assert.equal(output.ok, false);
  assert.ok(output.errors.length > 0);
});

test("CLI health reports Seats.aero cached capability without exposing the key", async () => {
  const captureResult = capture();
  const exitCode = await runCli(["health"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 0);
  const seats = output.providers.find((provider) => provider.id === "seats-aero");
  assert.equal(seats.capabilities.liveSearchSupported, false);
  assert.equal(JSON.stringify(output).includes(process.env.SEATS_AERO_API_KEY ?? "__missing__"), false);
});

test("CLI health uses the full server provider health contract", async () => {
  const captureResult = capture();
  const exitCode = await runCli(["health"], captureResult.io);
  const output = captureResult.read();

  assert.equal(exitCode, 0);
  assert.deepEqual(
    output.providers.map((provider) => provider.id),
    [
      "serpapi-google-flights",
      "seats-aero",
    ]
  );
});

test("official-first CLI searches report missing live cash and award results", async () => {
  const originalSeatsKey = process.env.SEATS_AERO_API_KEY;
  process.env.SEATS_AERO_API_KEY = "";
  const captureResult = capture(JSON.stringify({
    ...query,
    dataStrategy: "official-first",
    awardPrograms: ["united"],
  }));
  const exitCode = await runCli(["search", "--stdin"], captureResult.io);
  const output = captureResult.read();
  process.env.SEATS_AERO_API_KEY = originalSeatsKey;

  assert.equal(exitCode, 1);
  assert.ok(output.attempts.some((attempt) => attempt.name === "SerpApi Google Flights"));
  assert.ok(output.warnings.some((warning) => warning.includes("no usable cash-flight results")));
  assert.ok(output.warnings.some((warning) => warning.includes("no usable cached award results")));
  assert.ok(output.workers.some((worker) => worker.program === "united"));
});
