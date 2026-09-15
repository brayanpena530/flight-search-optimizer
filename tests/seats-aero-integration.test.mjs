import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const TRANSFER_CONFIRMATION_CAVEAT =
  "Confirm the award is still available at the same mileage price and taxes before transferring points.";

test("backend search uses fake Seats.aero cached award data without sample-backed award workers", async (t) => {
  const seatsAeroPort = 8170;
  const appPort = 8171;
  const seen = {
    authHeaders: [],
    searches: [],
    trips: [],
  };
  const fakeSeatsAero = await startFakeSeatsAeroServer(seatsAeroPort, seen);
  const server = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      SERPAPI_API_KEY: "",
      PORT: String(appPort),
      AMADEUS_CLIENT_ID: "",
      AMADEUS_CLIENT_SECRET: "",
      DUFFEL_API_TOKEN: "",
      SEATS_AERO_API_KEY: "fake-seats-key",
      SEATS_AERO_BASE_URL: `http://127.0.0.1:${seatsAeroPort}/partnerapi`,
      SEATS_AERO_MAX_AVAILABILITY: "2",
      SEATS_AERO_REQUEST_BUDGET: "4",
      SEATS_AERO_TAKE: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill();
    await closeServer(fakeSeatsAero);
  });

  await waitForServer(appPort);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/providers/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      origin: "IAH",
      destination: "JFK",
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
      cabinPreference: "economy",
      maxStops: 0,
      dataStrategy: "official-then-automation",
      awardDataMode: "cash-and-awards",
      awardPrograms: ["united"],
      balances: {
        amex: 0,
        chase: 50000,
        united: 0,
        delta: 0,
        jetblue: 0,
        frontier: 0,
        southwest: 0,
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
        amexTravel: 0,
        chaseTravel: 0,
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
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert(payload.sources.some((source) => source.role === "awards" && source.name === "Award Automation Fallback"));
  assert.equal(payload.sources.find((source) => source.role === "awards")?.type, "automation");
  assert(payload.workers.some((worker) => worker.program === "united" && worker.mode === "seats-aero-united-cached"));
  assert.equal(payload.workers.some((worker) => worker.mode === "sample-award-automation"), false);
  assert(payload.warnings.some((warning) => warning.includes("Seats.aero award results are cached")));
  assert.equal(new Set(payload.warnings).size, payload.warnings.length);

  const seatsSegment = payload.segments.find((segment) => segment.provider === "seats-aero");
  assert(seatsSegment, "expected a Seats.aero-backed segment");
  assert.equal(seatsSegment.cashPrice, null);
  assert.equal(seatsSegment.cashAvailable, false);
  assert.equal(seatsSegment.verification, "discovered_cached");
  assert.equal(seatsSegment.awardOptions[0].program, "united");
  assert.equal(seatsSegment.awardOptions[0].verification, "discovered_cached");
  assert.equal(seatsSegment.awardOptions[0].bookingLinks[0].url, "https://www.united.com/booking");
  assert.equal(seatsSegment.providerEvidence[0].provider, "seats-aero");
  assert.equal(seatsSegment.providerEvidence[0].availabilityId, "avail-outbound");
  assert.equal(seatsSegment.flightSegments[0].flightNumber, "1200");
  assert.deepEqual(seatsSegment.sources, [
    {
      providerId: "award-automation",
      providerName: "Award Automation Fallback",
      capability: "awards",
      status: "cached",
    },
  ]);

  const top = payload.itineraries[0];
  assert(top, "expected at least one ranked itinerary");
  assert(top.label.includes("transfer Chase to United"));
  assert(top.caveats.includes(TRANSFER_CONFIRMATION_CAVEAT));
  assert.equal(top.valueBreakdown.referenceCashPrice, null);
  assert.equal(top.valueBreakdown.cashSavings, null);
  assert.equal(top.paymentBreakdown.every((item) => item.sourceCurrency === "chase"), true);
  assert.equal(top.paymentBreakdown.every((item) => item.program === "united"), true);

  assert.deepEqual(new Set(seen.authHeaders), new Set(["fake-seats-key"]));
  assert.equal(seen.searches.length, 2);
  assert.equal(seen.trips.length, 2);
  assertSearchParams(seen.searches[0], {
    origin_airport: "IAH",
    destination_airport: "JFK",
    start_date: "2026-08-05",
    end_date: "2026-08-05",
    sources: "united",
    cabins: "economy",
    only_direct_flights: "true",
    include_trips: "false",
  });
  assertSearchParams(seen.searches[1], {
    origin_airport: "JFK",
    destination_airport: "IAH",
    start_date: "2026-08-09",
    end_date: "2026-08-09",
    sources: "united",
    cabins: "economy",
    only_direct_flights: "true",
    include_trips: "false",
  });
  assert.deepEqual(seen.trips, ["avail-outbound", "avail-return"]);
});

async function startFakeSeatsAeroServer(port, seen) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const authHeader = request.headers["partner-authorization"];
    if (authHeader) {
      seen.authHeaders.push(authHeader);
    }

    if (request.method === "GET" && url.pathname === "/partnerapi/search") {
      seen.searches.push(Object.fromEntries(url.searchParams.entries()));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ Data: [buildAvailability(url.searchParams)] }));
      return;
    }

    const tripMatch = /^\/partnerapi\/trips\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && tripMatch) {
      const availabilityId = decodeURIComponent(tripMatch[1]);
      seen.trips.push(availabilityId);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          Data: [buildTrip(availabilityId)],
          BookingLinks: [
            {
              Label: "Book with United",
              URL: "https://www.united.com/booking",
            },
            {
              Label: "Rejected non-allowlisted host",
              URL: "https://example.com/booking",
            },
          ],
        })
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

function buildAvailability(searchParams) {
  const isReturn = searchParams.get("origin_airport") === "JFK";
  return {
    ID: isReturn ? "avail-return" : "avail-outbound",
    RouteID: isReturn ? "route-return" : "route-outbound",
    Source: "united",
    OriginAirport: searchParams.get("origin_airport"),
    DestinationAirport: searchParams.get("destination_airport"),
    Date: searchParams.get("start_date"),
    YMileageCost: isReturn ? 13000 : 12500,
    YTotalTaxes: 5.6,
    YRemainingSeats: 2,
    YDirect: true,
    UpdatedAt: isReturn ? "2026-08-01T14:00:00Z" : "2026-08-01T13:00:00Z",
  };
}

function buildTrip(availabilityId) {
  const isReturn = availabilityId === "avail-return";
  const origin = isReturn ? "JFK" : "IAH";
  const destination = isReturn ? "IAH" : "JFK";
  const departure = isReturn ? "2026-08-09T09:00:00Z" : "2026-08-05T08:00:00Z";
  const arrival = isReturn ? "2026-08-09T12:20:00Z" : "2026-08-05T12:10:00Z";
  return {
    ID: isReturn ? "trip-return" : "trip-outbound",
    AvailabilityID: availabilityId,
    RouteID: isReturn ? "route-return" : "route-outbound",
    Source: "united",
    YMileageCost: isReturn ? 13000 : 12500,
    YTotalTaxes: 5.6,
    YRemainingSeats: 2,
    TaxesCurrency: "USD",
    MixedCabinPercentage: 0,
    UpdatedAt: isReturn ? "2026-08-01T14:05:00Z" : "2026-08-01T13:05:00Z",
    AvailabilitySegments: [
      {
        OriginAirport: origin,
        DestinationAirport: destination,
        DepartureTime: departure,
        ArrivalTime: arrival,
        MarketingCarrier: "United",
        OperatingCarrier: "United",
        FlightNumber: isReturn ? "1201" : "1200",
        Cabin: "economy",
        FareClass: "X",
        Aircraft: "737",
        Distance: 1417,
      },
    ],
  };
}

function assertSearchParams(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `expected ${key}=${value}`);
  }
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
