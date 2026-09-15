import assert from "node:assert/strict";
import test from "node:test";
import {
  SEATS_AERO_CAPABILITIES,
  buildCachedSearchUrl,
  buildSearchRequests,
  mapCabinForSeatsAero,
  normalizeSeatsAeroTrip,
  querySeatsAeroCachedAwards,
  sanitizeBookingLinks,
} from "../award-providers/seats-aero.mjs";

test("Seats.aero capabilities report live search as unavailable", () => {
  assert.equal(SEATS_AERO_CAPABILITIES.cachedSearchSupported, true);
  assert.equal(SEATS_AERO_CAPABILITIES.liveSearchSupported, false);
});

test("cached search URL uses partner query fields and cabin mapping", () => {
  const url = buildCachedSearchUrl({
    baseUrl: "https://seats.aero/partnerapi",
    originAirports: ["IAH", "HOU"],
    destinationAirports: ["JFK", "LGA", "EWR"],
    startDate: "2026-10-01",
    endDate: "2026-10-07",
    sources: ["united", "aeroplan"],
    cabin: "premium-economy",
    onlyDirectFlights: true,
    take: 25,
  });

  assert.equal(url.origin, "https://seats.aero");
  assert.equal(url.pathname, "/partnerapi/search");
  assert.equal(url.searchParams.get("origin_airport"), "IAH,HOU");
  assert.equal(url.searchParams.get("destination_airport"), "JFK,LGA,EWR");
  assert.equal(url.searchParams.get("start_date"), "2026-10-01");
  assert.equal(url.searchParams.get("end_date"), "2026-10-07");
  assert.equal(url.searchParams.get("sources"), "united,aeroplan");
  assert.equal(url.searchParams.get("cabins"), "premium");
  assert.equal(url.searchParams.get("only_direct_flights"), "true");
  assert.equal(url.searchParams.get("include_trips"), "false");
  assert.equal(mapCabinForSeatsAero("first"), "first");
});

test("search requests include reversed return window when supplied", () => {
  const requests = buildSearchRequests({
    originAirports: ["IAH"],
    destinationAirports: ["JFK"],
    outboundWindow: { startDate: "2026-10-01", endDate: "2026-10-02" },
    returnWindow: { startDate: "2026-10-05", endDate: "2026-10-06" },
    cabin: "business",
    sources: ["united"],
    take: 10,
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].originAirports, ["IAH"]);
  assert.deepEqual(requests[0].destinationAirports, ["JFK"]);
  assert.deepEqual(requests[1].originAirports, ["JFK"]);
  assert.deepEqual(requests[1].destinationAirports, ["IAH"]);
  assert.equal(requests[1].startDate, "2026-10-05");
});

test("query uses Partner-Authorization, shortlists availability, and normalizes trip details", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (url.pathname.endsWith("/search")) {
      return jsonResponse({
        data: [
          availabilityFixture("avail-1", { routeId: "route-1", seats: 2, mixedCabinPct: 75 }),
          availabilityFixture("avail-2", { routeId: "route-2", seats: 0 }),
        ],
      });
    }
    if (url.pathname.endsWith("/trips/avail-1")) {
      return jsonResponse({
        Trips: [tripFixture("trip-1", { availabilityId: "avail-1", seats: 2, mixedCabinPct: 75 })],
        BookingLinks: [
          { label: "United", url: "https://www.united.com/booking/award" },
          { label: "Bad", url: "https://evil.example/phish" },
        ],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await querySeatsAeroCachedAwards({
    apiKey: "test-key",
    fetchImpl,
    baseUrl: "https://seats.aero/partnerapi/",
    originAirports: ["IAH", "HOU"],
    destinationAirports: ["JFK"],
    outboundWindow: { startDate: "2026-10-01", endDate: "2026-10-01" },
    sources: ["united"],
    cabin: "business",
    take: 5,
    maxAvailability: 1,
    requestBudget: 2,
    retrievedAt: "2026-09-13T12:00:00.000Z",
    sourceProgramMap: { united: "united" },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Partner-Authorization"], "test-key");
  assert.equal(calls[0].url.searchParams.get("origin_airport"), "IAH,HOU");
  assert.equal(calls[0].url.searchParams.get("cabins"), "business");
  assert.equal(result.requestCount, 2);
  assert.equal(result.segments.length, 1);

  const segment = result.segments[0];
  assert.equal(segment.origin, "IAH");
  assert.equal(segment.destination, "EWR");
  assert.equal(segment.departure, "2026-10-01T08:00:00Z");
  assert.equal(segment.arrival, "2026-10-01T12:45:00Z");
  assert.equal(segment.stops, 1);
  assert.equal(segment.durationMinutes, 285);
  assert.equal(segment.cashPrice, null);
  assert.equal(segment.cashAvailable, false);
  assert.equal(segment.verification, "discovered_cached");
  assert.equal(segment.retrievedAt, "2026-09-13T12:00:00.000Z");
  assert.equal(segment.providerUpdatedAt, "2026-09-12T18:00:00Z");
  assert.equal(segment.flightSegments.length, 2);
  assert.deepEqual(segment.awardOptions[0], {
    program: "united",
    source: "united",
    miles: 35000,
    taxes: 5.6,
    taxesCurrency: "USD",
    remainingSeats: 2,
    seatCountStatus: "reported",
    verification: "discovered_cached",
    availabilityId: "avail-1",
    tripId: "trip-1",
    routeId: "route-1",
    mixedCabinPct: 75,
    bookingLinks: [{ label: "United", url: "https://www.united.com/booking/award" }],
  });
  assert.equal(segment.providerEvidence[0].raw.mileageCost, 35000);
});

test("zero seats are preserved as ambiguous instead of certain no availability", () => {
  const segment = normalizeSeatsAeroTrip({
    availability: availabilityFixture("avail-zero", { seats: 0 }),
    trip: tripFixture("trip-zero", { availabilityId: "avail-zero", seats: 0 }),
    direction: "outbound",
    cabin: "business",
    retrievedAt: "2026-09-13T12:00:00.000Z",
  });

  assert.equal(segment.awardOptions[0].remainingSeats, 0);
  assert.equal(segment.awardOptions[0].seatCountStatus, "zero_or_unknown");
});

test("tax currency and mixed-cabin percentage are preserved", () => {
  const segment = normalizeSeatsAeroTrip({
    availability: availabilityFixture("avail-mixed", { currency: "CAD", mixedCabinPct: 42 }),
    trip: tripFixture("trip-mixed", {
      availabilityId: "avail-mixed",
      currency: "CAD",
      mixedCabinPct: 42,
    }),
    direction: "outbound",
    cabin: "business",
    retrievedAt: "2026-09-13T12:00:00.000Z",
  });

  assert.equal(segment.awardOptions[0].taxesCurrency, "CAD");
  assert.equal(segment.awardOptions[0].mixedCabinPct, 42);
});

test("booking links are sanitized to https allowlisted hosts", () => {
  const links = sanitizeBookingLinks([
    "https://www.united.com/booking/award",
    "http://www.united.com/insecure",
    "https://evil.example/collect",
    "not a url",
    { label: "Air Canada", url: "https://aircanada.com/aeroplan" },
  ]);

  assert.deepEqual(links, [
    { label: "www.united.com", url: "https://www.united.com/booking/award" },
    { label: "Air Canada", url: "https://aircanada.com/aeroplan" },
  ]);
});

test("request budget prevents unbounded trip drill-down", async () => {
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith("/search")) {
      return jsonResponse({ data: [availabilityFixture("avail-1"), availabilityFixture("avail-2")] });
    }
    return jsonResponse({ Trips: [tripFixture("trip-1")] });
  };

  await assert.rejects(
    querySeatsAeroCachedAwards({
      apiKey: "test-key",
      fetchImpl,
      baseUrl: "https://seats.aero/partnerapi/",
      originAirports: ["IAH"],
      destinationAirports: ["JFK"],
      outboundWindow: { startDate: "2026-10-01", endDate: "2026-10-01" },
      maxAvailability: 2,
      requestBudget: 1,
    }),
    /request budget exceeded/
  );
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

function availabilityFixture(id, overrides = {}) {
  return {
    ID: id,
    RouteID: overrides.routeId ?? "route-1",
    Source: "united",
    JMileageCost: overrides.miles ?? 35000,
    JTotalTaxes: overrides.taxes ?? 5.6,
    JRemainingSeats: overrides.seats ?? 2,
    JMixedCabinPct: overrides.mixedCabinPct,
    TaxesCurrency: overrides.currency ?? "USD",
    UpdatedAt: "2026-09-12T18:00:00Z",
  };
}

function tripFixture(id, overrides = {}) {
  return {
    ID: id,
    AvailabilityID: overrides.availabilityId ?? "avail-1",
    RouteID: overrides.routeId ?? "route-1",
    Source: "united",
    JMileageCost: overrides.miles ?? 35000,
    JTotalTaxes: overrides.taxes ?? 5.6,
    JRemainingSeats: overrides.seats ?? 2,
    MixedCabinPct: overrides.mixedCabinPct,
    TaxesCurrency: overrides.currency ?? "USD",
    UpdatedAt: "2026-09-12T18:00:00Z",
    Segments: [
      {
        OriginAirport: "IAH",
        DestinationAirport: "ORD",
        DepartureTime: "2026-10-01T08:00:00Z",
        ArrivalTime: "2026-10-01T10:30:00Z",
        MarketingCarrier: "UA",
        OperatingCarrier: "UA",
        FlightNumber: "100",
        Cabin: "business",
        FareClass: "I",
        Aircraft: "738",
        Distance: 925,
      },
      {
        OriginAirport: "ORD",
        DestinationAirport: "EWR",
        DepartureTime: "2026-10-01T11:10:00Z",
        ArrivalTime: "2026-10-01T12:45:00Z",
        MarketingCarrier: "UA",
        OperatingCarrier: "UA",
        FlightNumber: "200",
        Cabin: "business",
        FareClass: "I",
        Aircraft: "739",
        Distance: 719,
      },
    ],
  };
}
