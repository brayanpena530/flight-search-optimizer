import assert from "node:assert/strict";
import test from "node:test";
import { handleMcpRequest } from "../mcp-server.mjs";

// MCP tests use sample or injected provider results; never inherit a local
// credential into a live SerpApi request.
process.env.SERPAPI_API_KEY = "";
process.env.SERPAPI_KEY = "";
process.env.SERP_API_KEY = "";

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
  balances: { southwest: 12000, united: 22000 },
};

test("MCP exposes the initialize handshake and planned tools", async () => {
  const response = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: {} });

  const tools = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(tools.result.tools.map((item) => item.name), [
    "start_flight_search",
    "get_search_results",
    "get_option_details",
    "compare_options",
    "recheck_option",
    "get_traveler_profile",
  ]);
});

test("MCP starts a search, polls it, and returns compact candidates", async () => {
  const started = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "start_flight_search", arguments: { query } },
  });
  const { searchId } = started.result.structuredContent;
  assert.match(searchId, /^srch_/);

  let results;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    results = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_search_results", arguments: { searchId } },
    });
    if (results.result.structuredContent.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const payload = results.result.structuredContent;
  assert.equal(payload.status, "complete");
  assert.ok(Array.isArray(payload.candidates));
  if (payload.candidates.length > 0) {
    assert.ok(payload.candidates[0].flightDetails.outbound);
    assert.ok(payload.candidates[0].flightDetails.outbound.airline);
    assert.ok(Array.isArray(payload.candidates[0].flightDetails.outbound.flights));
    assert.ok(payload.candidates[0].flightDetails.return);
  }
  assert.ok(Buffer.byteLength(results.result.content[0].text, "utf8") <= 6 * 1024);
  assert.equal(Object.hasOwn(payload, "segments"), false);
});

test("MCP rejects malformed input and unknown option IDs", async () => {
  const invalid = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "start_flight_search", arguments: { query: { origin: "IAH" } } },
  });
  assert.equal(invalid.error.code, -32000);

  const unknown = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "get_search_results", arguments: { searchId: "srch_missing" } },
  });
  assert.equal(unknown.error.code, -32000);
});

test("MCP accepts one-way searches without a return window", async () => {
  const started = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "start_flight_search",
      arguments: {
        query: {
          ...query,
          tripType: "one-way",
          earliestReturn: undefined,
          latestReturn: undefined,
        },
      },
    },
  }, {
    resolveSearch: async () => ({
      segments: [],
      sources: [],
      itineraries: [],
    }),
  });
  assert.match(started.result.structuredContent.searchId, /^srch_/);
});

test("MCP option details expose SerpApi cache evidence, Google Flights links, and on-demand booking links", async () => {
  const segment = {
    origin: "IAH",
    destination: "JFK",
    departure: "2026-10-01T09:00:00",
    arrival: "2026-10-01T14:30:00",
    airline: "United",
    cabin: "economy",
    stops: 1,
    durationMinutes: 330,
    verification: "discovered_cached",
    provider: "serpapi-google-flights",
    providerCaveats: ["Verify current price and availability before booking."],
    flightSegments: [],
    providerEvidence: [{
      provider: "serpapi-google-flights",
      type: "cash_search",
      searchLink: "https://www.google.com/travel/flights?q=IAH%20to%20JFK",
      bookingToken: "mock-booking-token",
      cache: { status: "cached", cached: true },
      retrievedAt: "2026-09-14T12:00:00Z",
      priceInsights: { lowestPrice: 180 },
      caveats: ["Verify current price and availability before booking."],
    }],
    sources: [{ providerId: "serpapi-google-flights", providerName: "SerpApi Google Flights", capability: "cash" }],
  };
  const inbound = { ...segment, origin: "JFK", destination: "IAH", departure: "2026-10-05T09:00:00" };
  const started = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "start_flight_search", arguments: { query } },
  }, {
    resolveSearch: async () => ({
      sources: [{ id: "serpapi-google-flights", name: "SerpApi Google Flights", type: "official" }],
      segments: [segment, inbound],
      itineraries: [{
        outbound: segment,
        inbound,
        cashOutlay: 400,
        effectiveCost: 400,
        pointsUsed: 0,
        totalDurationMinutes: 660,
        caveats: [],
        paymentBreakdown: [],
        labels: ["LOWEST_CASH"],
      }],
    }),
  });
  const searchId = started.result.structuredContent.searchId;
  let searchResults;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    searchResults = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: { name: "get_search_results", arguments: { searchId } },
    });
    if (searchResults.result.structuredContent.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    searchResults.result.structuredContent.candidates[0].searchLinks[0].url,
    "https://www.google.com/travel/flights?q=IAH%20to%20JFK"
  );
  assert.equal(searchResults.result.structuredContent.candidates[0].flightDetails.outbound.airline, "United");
  assert.equal(searchResults.result.structuredContent.candidates[0].flightDetails.outbound.origin, "IAH");
  assert.equal(searchResults.result.structuredContent.candidates[0].flightDetails.return.destination, "IAH");
  assert.equal(Object.hasOwn(searchResults.result.structuredContent.candidates[0], "bookingToken"), false);
  let bookingCalls = 0;
  const details = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "get_option_details", arguments: { searchId, optionId: "opt_1" } },
  }, {
    queryBookingOptions: async ({ bookingToken }) => {
      bookingCalls += 1;
      return {
        ok: bookingToken === "mock-booking-token",
        verification: "discovered_cached",
        cache: { status: "cache-eligible", cached: null },
        bookingOptions: [{ bookWith: "United", price: 200 }],
        bookingLinks: [{ label: "United", url: "https://www.united.com/book" }],
        baggage: { together: ["1 free carry-on"] },
      };
    },
  });
  const payload = details.result.structuredContent;
  assert.equal(payload.segments[0].provider, "serpapi-google-flights");
  assert.equal(payload.segments[0].providerEvidence[0].cache.status, "cache-eligible");
  assert.equal(payload.segments[0].providerEvidence[0].searchLink, "https://www.google.com/travel/flights?q=IAH%20to%20JFK");
  assert.equal(payload.segments[0].providerEvidence[0].bookingOptions[0].bookWith, "United");
  assert.equal(payload.segments[0].bookingLinks[0].url, "https://www.united.com/book");
  assert.ok(payload.providerCaveats.length > 0);

  const recheck = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "recheck_option", arguments: { searchId, optionId: "opt_1" } },
  }, {
    queryBookingOptions: async () => {
      throw new Error("cached detail lookup should prevent another SerpApi call");
    },
  });
  assert.equal(recheck.result.structuredContent.verification, "discovered_cached");
  assert.equal(bookingCalls, 2);
});
