import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSerpApiParams,
  buildSerpApiSearchRequests,
  getSerpApiKey,
  mapSerpApiResponse,
  querySerpApiBookingOptions,
  querySerpApiGoogleFlights,
} from "../cash-providers/serpapi-google-flights.mjs";

const SEARCH_STATE = {
  origin: "IAH",
  destination: "JFK",
  useNearbyAirports: false,
  earliestDeparture: "2026-10-01",
  latestDeparture: "2026-10-02",
  earliestReturn: "2026-10-05",
  latestReturn: "2026-10-06",
  cabinPreference: "economy",
  maxStops: 1,
  passengers: { adults: 2 },
};

test("SerpApi request construction distinguishes one-way and round-trip searches", () => {
  const oneWay = buildSerpApiParams({
    origin: "IAH",
    destination: "JFK",
    outboundDate: "2026-10-01",
    adults: 2,
    cabin: "business",
    maxStops: 0,
  });
  assert.equal(oneWay.get("engine"), "google_flights");
  assert.equal(oneWay.get("type"), "2");
  assert.equal(oneWay.get("travel_class"), "3");
  assert.equal(oneWay.get("stops"), "1");
  assert.equal(oneWay.get("adults"), "2");
  assert.equal(oneWay.has("return_date"), false);
  assert.equal(oneWay.has("no_cache"), false);

  const roundTrip = buildSerpApiParams({
    origin: "IAH",
    destination: "JFK",
    outboundDate: "2026-10-01",
    returnDate: "2026-10-05",
  });
  assert.equal(roundTrip.get("type"), "1");
  assert.equal(roundTrip.get("return_date"), "2026-10-05");
});

test("SerpApi round-trip planning reserves a bounded native round-trip follow-up", () => {
  const plan = buildSerpApiSearchRequests({
    ...SEARCH_STATE,
    requestBudget: 4,
  });
  assert.equal(plan.requests.length, 3);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.requests.map((request) => request.direction), [
    "round-trip",
    "outbound",
    "return",
  ]);
  assert.equal(plan.departureTokenBudget, 1);
  assert.equal(plan.requests[0].nativeRoundTrip, true);
  assert.equal(plan.requests[0].returnDate, "2026-10-05");
  assert.equal(plan.requests[2].origin, "JFK");
  assert.equal(plan.requests[2].destination, "IAH");

  const widerPlan = buildSerpApiSearchRequests({
    ...SEARCH_STATE,
    latestDeparture: "2026-10-08",
    latestReturn: "2026-10-12",
    requestBudget: 6,
  });
  assert.equal(widerPlan.requests.length, 3);
  assert.deepEqual(widerPlan.requests.map((request) => request.direction), [
    "round-trip",
    "outbound",
    "return",
  ]);
});

test("SerpApi one-way planning spends the request budget only on outbound dates", () => {
  const plan = buildSerpApiSearchRequests({
    ...SEARCH_STATE,
    tripType: "one-way",
    latestDeparture: "2026-10-04",
    requestBudget: 4,
  });
  assert.equal(plan.requests.length, 4);
  assert.deepEqual(plan.requests.map((request) => request.direction), [
    "outbound",
    "outbound",
    "outbound",
    "outbound",
  ]);
  assert.equal(plan.requests.every((request) => !request.returnDate), true);
  assert.equal(plan.requests.every((request) => request.origin === "IAH" && request.destination === "JFK"), true);
});

test("SerpApi response mapping preserves normalized segments and bounded provider evidence", () => {
  const mapped = mapSerpApiResponse(buildSearchPayload(), {
    direction: "outbound",
    origin: "IAH",
    destination: "JFK",
    outboundDate: "2026-10-01",
    cabin: "economy",
  }, { retrievedAt: "2026-09-14T12:00:00.000Z" });
  const segment = mapped.segments[0];

  assert.equal(mapped.segments.length, 1);
  assert.equal(segment.origin, "IAH");
  assert.equal(segment.destination, "JFK");
  assert.equal(segment.cashPrice, 214);
  assert.equal(segment.stops, 1);
  assert.equal(segment.durationMinutes, 330);
  assert.equal(segment.flightSegments[0].flightNumber, "UA 100");
  assert.equal(segment.providerEvidence[0].bookingToken, "booking-token-1");
  assert.equal(segment.providerEvidence[0].departureToken, "departure-token-1");
  assert.equal(segment.providerEvidence[0].cache.status, "cached");
  assert.equal(segment.providerEvidence[0].priceInsights.lowestPrice, 180);
  assert.match(segment.providerEvidence[0].searchLink, /^https:\/\//);
  assert.ok(segment.providerCaveats.length > 0);
});

test("SerpApi cache-eligible responses are not presented as definitely fresh", () => {
  const payload = buildSearchPayload();
  delete payload.search_metadata.cached;
  const mapped = mapSerpApiResponse(payload, {
    direction: "outbound",
    origin: "IAH",
    destination: "JFK",
    outboundDate: "2026-10-01",
    noCache: false,
  }, { retrievedAt: "2026-09-14T12:00:00.000Z" });

  assert.equal(mapped.cache.status, "cache-eligible");
  assert.equal(mapped.cache.cached, null);
  assert.equal(mapped.segments[0].verification, "discovered_cached");
  assert.equal(mapped.segments[0].retrievedAt, "2026-09-14T12:00:00.000Z");
  assert.equal(mapped.segments[0].providerUpdatedAt, "2026-09-14T11:59:00Z");
});

test("SerpApi search is a clean no-op without credentials", async () => {
  let calls = 0;
  const result = await querySerpApiGoogleFlights({
    apiKey: "",
    searchState: SEARCH_STATE,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing SERPAPI_API_KEY/);
  assert.equal(calls, 0);
});

test("SerpApi accepts the Google Flights-specific environment key", () => {
  assert.equal(
    getSerpApiKey({ SERPAPI_GOOGLE_FLIGHTS: "google-flights-test-key" }),
    "google-flights-test-key"
  );
});

test("SerpApi search handles partial network and malformed responses without aborting", async () => {
  let calls = 0;
  const result = await querySerpApiGoogleFlights({
    apiKey: "test-key",
    searchState: SEARCH_STATE,
    requestBudget: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(buildSearchPayload());
      throw new Error("network down");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 1);
  assert.ok(result.notes.some((note) => note.includes("failed")));

  const malformed = await querySerpApiGoogleFlights({
    apiKey: "test-key",
    searchState: { ...SEARCH_STATE, latestDeparture: SEARCH_STATE.earliestDeparture, latestReturn: SEARCH_STATE.earliestReturn },
    requestBudget: 2,
    fetchImpl: async () => jsonResponse({ unexpected: true }),
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /malformed|no usable/i);
});

test("SerpApi search enforces the configured request budget and only opts into no_cache explicitly", async () => {
  const plan = buildSerpApiSearchRequests({ ...SEARCH_STATE, requestBudget: 2 });
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.truncated, true);

  const seen = [];
  await querySerpApiGoogleFlights({
    apiKey: "test-key",
    searchState: SEARCH_STATE,
    requestBudget: 2,
    noCache: true,
    fetchImpl: async (url) => {
      seen.push(new URL(url));
      return jsonResponse(buildSearchPayload());
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].searchParams.get("no_cache"), "true");
});

test("SerpApi booking-token lookup is on demand and maps booking links without post bodies", async () => {
  const seen = [];
  const result = await querySerpApiBookingOptions({
    apiKey: "test-key",
    bookingToken: "booking-token-1",
    fetchImpl: async (url) => {
      seen.push(new URL(url));
      return jsonResponse(buildBookingPayload());
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].searchParams.get("booking_token"), "booking-token-1");
  assert.equal(seen[0].searchParams.has("departure_token"), false);
  assert.equal(result.ok, true);
  assert.equal(result.bookingOptions[0].bookWith, "United");
  assert.equal(result.bookingLinks[0].url, "https://www.united.com/book");
  assert.equal(result.bookingLinks[0].requiresPostData, true);
  assert.equal(Object.hasOwn(result.bookingOptions[0], "postData"), false);
});

test("SerpApi booking mapping preserves separate departing and returning sellers", async () => {
  const payload = buildBookingPayload();
  payload.booking_options = [{
    separate_tickets: true,
    departing: {
      book_with: "United",
      price: 120,
      booking_request: { url: "https://www.united.com/outbound" },
    },
    returning: {
      book_with: "Delta",
      price: 130,
      booking_request: { url: "https://www.delta.com/return" },
    },
  }];
  const result = await querySerpApiBookingOptions({
    apiKey: "test-key",
    bookingToken: "booking-token-1",
    fetchImpl: async () => jsonResponse(payload),
  });

  assert.equal(result.bookingOptions[0].separateTickets, true);
  assert.deepEqual(result.bookingOptions[0].legs.map((leg) => leg.direction), ["departing", "returning"]);
  assert.deepEqual(result.bookingLinks.map((link) => link.label), ["United", "Delta"]);
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function buildSearchPayload() {
  return {
    search_metadata: {
      cached: true,
      processed_at: "2026-09-14T11:59:00Z",
      google_flights_url: "https://www.google.com/travel/flights?q=IAH%20to%20JFK",
    },
    price_insights: {
      lowest_price: 180,
      price_level: "typical",
      typical_price_range: [180, 260],
    },
    best_flights: [
      {
        flights: [
          {
            departure_airport: { id: "IAH", time: "2026-10-01 09:00" },
            arrival_airport: { id: "ATL", time: "2026-10-01 11:00" },
            duration: 120,
            airline: "United",
            flight_number: "UA 100",
            travel_class: "Economy",
            airplane: "A320",
          },
          {
            departure_airport: { id: "ATL", time: "2026-10-01 12:00" },
            arrival_airport: { id: "JFK", time: "2026-10-01 14:30" },
            duration: 150,
            airline: "United",
            flight_number: "UA 101",
            travel_class: "Economy",
            airplane: "A320",
          },
        ],
        total_duration: 330,
        price: 214,
        booking_token: "booking-token-1",
        departure_token: "departure-token-1",
      },
    ],
  };
}

function buildBookingPayload() {
  return {
    search_metadata: { cached: false, processed_at: "2026-09-14T12:01:00Z" },
    selected_flights: [{ price: 214, type: "One way", flights: [] }],
    baggage_prices: { together: ["1 free carry-on"] },
    booking_options: [
      {
        together: {
          book_with: "United",
          airline: true,
          price: 214,
          local_prices: [{ currency: "USD", price: 214 }],
          baggage_prices: ["1 free carry-on"],
          booking_request: {
            url: "https://www.united.com/book",
            post_data: "secret-form-data-that-is-not-returned",
          },
        },
      },
    ],
  };
}
