const DEFAULT_BASE_URL = "https://seats.aero/partnerapi/";
const DEFAULT_BOOKING_HOSTS = new Set([
  "www.aircanada.com",
  "aircanada.com",
  "www.alaskaair.com",
  "alaskaair.com",
  "www.aa.com",
  "aa.com",
  "www.americanairlines.com",
  "americanairlines.com",
  "www.delta.com",
  "delta.com",
  "www.flyingblue.us",
  "flyingblue.us",
  "www.united.com",
  "united.com",
  "www.southwest.com",
  "southwest.com",
  "www.jetblue.com",
  "jetblue.com",
  "www.virginatlantic.com",
  "virginatlantic.com",
  "www.britishairways.com",
  "britishairways.com",
  "www.qatarairways.com",
  "qatarairways.com",
  "www.aeroplan.com",
  "aeroplan.com",
]);

const CABIN_QUERY_MAP = {
  economy: "economy",
  "premium-economy": "premium",
  premium: "premium",
  business: "business",
  first: "first",
};

const CABIN_FIELD_PREFIXES = {
  economy: ["Y", "Economy"],
  premium: ["W", "Premium", "PremiumEconomy"],
  business: ["J", "Business"],
  first: ["F", "First"],
};

export const SEATS_AERO_CAPABILITIES = Object.freeze({
  cachedSearchSupported: true,
  liveSearchSupported: false,
});

export async function querySeatsAeroCachedAwards(options = {}) {
  const {
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    originAirports = [],
    destinationAirports = [],
    outboundWindow,
    returnWindow,
    sources = [],
    cabin = "economy",
    onlyDirectFlights,
    take = 10,
    maxAvailability = 5,
    maxTripRequests,
    requestBudget = 10,
    retrievedAt = new Date().toISOString(),
    bookingHostAllowlist = DEFAULT_BOOKING_HOSTS,
    sourceProgramMap = {},
    workerName = "Seats.aero Cached Award Adapter",
  } = options;

  if (!apiKey) {
    throw new Error("Seats.aero API key is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Seats.aero adapter requires a fetch implementation.");
  }

  const budget = createRequestBudget(requestBudget);
  const searchRequests = buildSearchRequests({
    originAirports,
    destinationAirports,
    outboundWindow,
    returnWindow,
    sources,
    cabin,
    onlyDirectFlights,
    take,
  });

  const availabilityById = new Map();
  const searches = [];

  for (const search of searchRequests) {
    budget.consume("cached search");
    const url = buildCachedSearchUrl({ baseUrl, ...search });
    const payload = await fetchSeatsAeroJson(fetchImpl, url, apiKey);
    const availability = extractArray(payload, ["data", "Data", "availability", "Availability", "results", "Results"]);
    searches.push({
      direction: search.direction,
      url: redactUrl(url),
      availabilityCount: availability.length,
    });

    for (const item of availability) {
      const id = getProviderValue(item, ["ID", "Id", "id", "AvailabilityID", "AvailabilityId", "availability_id"]);
      if (!id || availabilityById.has(String(id))) {
        continue;
      }
      availabilityById.set(String(id), { item, direction: search.direction });
      if (availabilityById.size >= maxAvailability) {
        break;
      }
    }
  }

  const tripLimit = Math.min(maxTripRequests ?? maxAvailability, availabilityById.size);
  const selectedAvailability = [...availabilityById.entries()].slice(0, tripLimit);
  const segments = [];

  for (const [availabilityId, { item, direction }] of selectedAvailability) {
    budget.consume("trip detail");
    const url = buildTripsUrl({ baseUrl, availabilityId });
    const payload = await fetchSeatsAeroJson(fetchImpl, url, apiKey);
    const trips = extractArray(payload, ["data", "Data", "trips", "Trips", "results", "Results"]);
    const bookingLinks = sanitizeBookingLinks(
      extractArray(payload, ["bookingLinks", "BookingLinks", "links", "Links"]),
      bookingHostAllowlist
    );

    for (const trip of trips) {
      const normalized = normalizeSeatsAeroTrip({
        trip,
        availability: item,
        direction,
        cabin,
        retrievedAt,
        bookingLinks,
        sourceProgramMap,
        workerName,
      });
      if (normalized) {
        segments.push(normalized);
      }
    }
  }

  return {
    provider: "seats-aero",
    capabilities: SEATS_AERO_CAPABILITIES,
    requestCount: budget.count,
    searches,
    segments,
  };
}

export function buildSearchRequests({
  originAirports,
  destinationAirports,
  outboundWindow,
  returnWindow,
  sources,
  cabin,
  onlyDirectFlights,
  take,
}) {
  const requests = [
    {
      direction: "outbound",
      originAirports,
      destinationAirports,
      startDate: outboundWindow?.startDate,
      endDate: outboundWindow?.endDate,
      sources,
      cabin,
      onlyDirectFlights,
      take,
    },
  ];

  if (returnWindow) {
    requests.push({
      direction: "return",
      originAirports: destinationAirports,
      destinationAirports: originAirports,
      startDate: returnWindow.startDate,
      endDate: returnWindow.endDate,
      sources,
      cabin,
      onlyDirectFlights,
      take,
    });
  }

  return requests;
}

export function buildCachedSearchUrl({
  baseUrl = DEFAULT_BASE_URL,
  originAirports,
  destinationAirports,
  startDate,
  endDate,
  sources = [],
  cabin = "economy",
  onlyDirectFlights,
  take = 10,
  cursor,
  skip,
}) {
  const url = new URL("search", ensureTrailingSlash(baseUrl));
  url.searchParams.set("origin_airport", normalizeAirportList(originAirports).join(","));
  url.searchParams.set("destination_airport", normalizeAirportList(destinationAirports).join(","));
  if (startDate) url.searchParams.set("start_date", startDate);
  if (endDate) url.searchParams.set("end_date", endDate);
  if (take) url.searchParams.set("take", String(take));
  if (cursor) url.searchParams.set("cursor", cursor);
  if (skip !== undefined) url.searchParams.set("skip", String(skip));
  if (sources.length > 0) url.searchParams.set("sources", sources.join(","));
  const seatsCabin = mapCabinForSeatsAero(cabin);
  if (seatsCabin !== "any") url.searchParams.set("cabins", seatsCabin);
  if (onlyDirectFlights !== undefined) url.searchParams.set("only_direct_flights", String(Boolean(onlyDirectFlights)));
  url.searchParams.set("include_trips", "false");
  return url;
}

export function buildTripsUrl({ baseUrl = DEFAULT_BASE_URL, availabilityId }) {
  return new URL(`trips/${encodeURIComponent(availabilityId)}`, ensureTrailingSlash(baseUrl));
}

export function mapCabinForSeatsAero(cabin) {
  return CABIN_QUERY_MAP[String(cabin ?? "economy").toLowerCase()] ?? "economy";
}

export function normalizeSeatsAeroTrip({
  trip,
  availability,
  direction,
  cabin,
  retrievedAt,
  bookingLinks = [],
  sourceProgramMap = {},
  workerName = "Seats.aero Cached Award Adapter",
}) {
  const requestedCabin = mapCabinForSeatsAero(cabin);
  const segments = extractTripSegments(trip);
  if (segments.length === 0) {
    return null;
  }

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const source = String(getProviderValue(trip, ["Source", "source"]) ?? getProviderValue(availability, ["Source", "source"]) ?? "");
  const award = buildAwardOption({ trip, availability, cabin: requestedCabin, source, bookingLinks, sourceProgramMap });

  return {
    origin: normalizeAirportCode(getSegmentOrigin(firstSegment)),
    destination: normalizeAirportCode(getSegmentDestination(lastSegment)),
    airline: normalizeAirlineName(getSegmentCarrier(firstSegment) ?? source),
    cabin: normalizeCabin(
      getProviderValue(trip, ["Cabin", "cabin"]) ??
        getProviderValue(firstSegment, ["Cabin", "cabin"]) ??
        requestedCabin
    ),
    departure: normalizeDateTime(getSegmentDeparture(firstSegment)),
    arrival: normalizeDateTime(getSegmentArrival(lastSegment)),
    stops: Math.max(segments.length - 1, Number(getProviderValue(trip, ["Stops", "stops"]) ?? 0)),
    durationMinutes: normalizeDurationMinutes(
      getProviderValue(trip, ["DurationMinutes", "durationMinutes", "TotalDurationMinutes", "total_duration_minutes", "Duration", "duration"]),
      getSegmentDeparture(firstSegment),
      getSegmentArrival(lastSegment)
    ),
    cashPrice: null,
    cashAvailable: false,
    awardOptions: [award],
    flightSegments: segments.map(normalizeFlightSegment),
    direction,
    fallbackMode: "seats-aero-cached",
    automationProgram: award.program,
    automationWorkerName: workerName,
    provider: "seats-aero",
    verification: "discovered_cached",
    retrievedAt,
    providerUpdatedAt:
      normalizeDateTimeOrNull(getProviderValue(trip, ["UpdatedAt", "updatedAt", "updated_at"])) ??
      normalizeDateTimeOrNull(getProviderValue(availability, ["UpdatedAt", "updatedAt", "updated_at"])),
    providerEvidence: buildProviderEvidence({ trip, availability, cabin: requestedCabin, bookingLinks }),
  };
}

export function sanitizeBookingLinks(links, allowlist = DEFAULT_BOOKING_HOSTS) {
  return links
    .map((link) => {
      const urlValue = typeof link === "string" ? link : link?.url ?? link?.URL ?? link?.href ?? link?.Href;
      if (!urlValue) return null;
      try {
        const url = new URL(urlValue);
        if (url.protocol !== "https:" || !allowlist.has(url.hostname.toLowerCase())) {
          return null;
        }
        return {
          label: typeof link === "object" ? link.label ?? link.Label ?? link.text ?? link.Text ?? url.hostname : url.hostname,
          url: url.toString(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchSeatsAeroJson(fetchImpl, url, apiKey) {
  const response = await fetchImpl(url, {
    headers: {
      "Partner-Authorization": apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Seats.aero request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function buildAwardOption({ trip, availability, cabin, source, bookingLinks, sourceProgramMap }) {
  const miles = normalizePositiveNumber(
    getCabinValue(trip, cabin, ["MileageCost", "Miles", "Mileage"]) ??
      getProviderValue(trip, ["MileageCost", "mileageCost", "Miles", "miles"]) ??
      getCabinValue(availability, cabin, ["MileageCost", "Miles", "Mileage"])
  );
  const taxes = normalizeMoney(
    getCabinValue(trip, cabin, ["TotalTaxes", "Taxes"]) ??
      getProviderValue(trip, ["TotalTaxes", "totalTaxes", "Taxes", "taxes"]) ??
      getCabinValue(availability, cabin, ["TotalTaxes", "Taxes"]) ??
      0
  );
  const remainingSeats = normalizeNullableNumber(
    getCabinValue(trip, cabin, ["RemainingSeats", "AvailableSeats", "Seats"]) ??
      getProviderValue(trip, ["RemainingSeats", "remainingSeats", "Seats", "seats"]) ??
      getCabinValue(availability, cabin, ["RemainingSeats", "AvailableSeats", "Seats"])
  );
  const availabilityId = stringifyProviderValue(
    getProviderValue(trip, ["AvailabilityID", "AvailabilityId", "availability_id"]) ??
      getProviderValue(availability, ["ID", "Id", "id"])
  );
  const tripId = stringifyProviderValue(getProviderValue(trip, ["ID", "Id", "id", "TripID", "TripId"]));
  const routeId = stringifyProviderValue(
    getProviderValue(trip, ["RouteID", "RouteId", "route_id"]) ??
      getProviderValue(availability, ["RouteID", "RouteId", "route_id"])
  );
  const mixedCabinPct = normalizeNullableNumber(
    getProviderValue(trip, ["MixedCabinPct", "mixedCabinPct", "MixedCabinPercentage", "mixed_cabin_pct"]) ??
      getCabinValue(availability, cabin, ["MixedCabinPct", "MixedCabinPercentage"])
  );

  return {
    program: sourceProgramMap[source] ?? normalizeProgram(source),
    source,
    miles,
    taxes,
    taxesCurrency:
      getProviderValue(trip, ["TaxesCurrency", "taxesCurrency", "Currency", "currency"]) ??
      getProviderValue(availability, ["TaxesCurrency", "taxesCurrency", "Currency", "currency"]) ??
      "USD",
    remainingSeats,
    seatCountStatus: getSeatCountStatus(remainingSeats),
    verification: "discovered_cached",
    availabilityId,
    tripId,
    routeId,
    mixedCabinPct,
    bookingLinks,
  };
}

function buildProviderEvidence({ trip, availability, cabin, bookingLinks }) {
  return [
    {
      provider: "seats-aero",
      type: "cached_availability",
      source: getProviderValue(trip, ["Source", "source"]) ?? getProviderValue(availability, ["Source", "source"]),
      availabilityId:
        stringifyProviderValue(getProviderValue(availability, ["ID", "Id", "id"])) ??
        stringifyProviderValue(getProviderValue(trip, ["AvailabilityID", "AvailabilityId", "availability_id"])),
      tripId: stringifyProviderValue(getProviderValue(trip, ["ID", "Id", "id", "TripID", "TripId"])),
      routeId:
        stringifyProviderValue(getProviderValue(trip, ["RouteID", "RouteId", "route_id"])) ??
        stringifyProviderValue(getProviderValue(availability, ["RouteID", "RouteId", "route_id"])),
      updatedAt:
        normalizeDateTimeOrNull(getProviderValue(trip, ["UpdatedAt", "updatedAt", "updated_at"])) ??
        normalizeDateTimeOrNull(getProviderValue(availability, ["UpdatedAt", "updatedAt", "updated_at"])),
      cabin,
      raw: {
        mileageCost:
          getCabinValue(trip, cabin, ["MileageCost", "Miles", "Mileage"]) ??
          getCabinValue(availability, cabin, ["MileageCost", "Miles", "Mileage"]),
        taxes:
          getCabinValue(trip, cabin, ["TotalTaxes", "Taxes"]) ??
          getCabinValue(availability, cabin, ["TotalTaxes", "Taxes"]),
        remainingSeats:
          getCabinValue(trip, cabin, ["RemainingSeats", "AvailableSeats", "Seats"]) ??
          getCabinValue(availability, cabin, ["RemainingSeats", "AvailableSeats", "Seats"]),
        direct:
          getCabinValue(trip, cabin, ["Direct"]) ??
          getCabinValue(availability, cabin, ["Direct"]),
      },
      bookingLinks,
    },
  ];
}

function extractTripSegments(trip) {
  return extractArray(trip, [
    "AvailabilitySegments",
    "availabilitySegments",
    "availability_segments",
    "Segments",
    "segments",
    "FlightSegments",
    "flightSegments",
    "segment",
  ]);
}

function normalizeFlightSegment(segment) {
  return {
    origin: normalizeAirportCode(getSegmentOrigin(segment)),
    destination: normalizeAirportCode(getSegmentDestination(segment)),
    departure: normalizeDateTime(getSegmentDeparture(segment)),
    arrival: normalizeDateTime(getSegmentArrival(segment)),
    marketingCarrier: getSegmentCarrier(segment),
    operatingCarrier: getProviderValue(segment, ["OperatingCarrier", "operatingCarrier", "OperatingAirline", "operatingAirline"]) ?? null,
    flightNumber: stringifyProviderValue(getProviderValue(segment, ["FlightNumber", "flightNumber", "Number", "number"])),
    cabin: normalizeCabin(getProviderValue(segment, ["Cabin", "cabin"])),
    fareClass: stringifyProviderValue(getProviderValue(segment, ["FareClass", "fareClass", "BookingClass", "bookingClass"])),
    aircraft: stringifyProviderValue(getProviderValue(segment, ["Aircraft", "aircraft", "AircraftName", "aircraftName"])),
    distance: normalizeNullableNumber(getProviderValue(segment, ["Distance", "distance"])),
  };
}

function getCabinValue(record, cabin, suffixes) {
  if (!record) return undefined;
  const prefixes = CABIN_FIELD_PREFIXES[cabin] ?? CABIN_FIELD_PREFIXES.economy;
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const value = getProviderValue(record, [
        `${prefix}${suffix}`,
        `${prefix}_${suffix}`,
        `${prefix.toLowerCase()}${suffix}`,
        `${prefix.toLowerCase()}_${suffix.toLowerCase()}`,
      ]);
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function getSegmentOrigin(segment) {
  return (
    getProviderValue(segment, ["OriginAirport", "originAirport", "Origin", "origin"]) ??
    getProviderValue(segment?.Origin ?? segment?.origin, ["Iata", "IATA", "iata", "Code", "code"])
  );
}

function getSegmentDestination(segment) {
  return (
    getProviderValue(segment, ["DestinationAirport", "destinationAirport", "Destination", "destination"]) ??
    getProviderValue(segment?.Destination ?? segment?.destination, ["Iata", "IATA", "iata", "Code", "code"])
  );
}

function getSegmentDeparture(segment) {
  return getProviderValue(segment, ["DepartureTime", "departureTime", "Departure", "departure", "DepartsAt", "departsAt"]);
}

function getSegmentArrival(segment) {
  return getProviderValue(segment, ["ArrivalTime", "arrivalTime", "Arrival", "arrival", "ArrivesAt", "arrivesAt"]);
}

function getSegmentCarrier(segment) {
  return getProviderValue(segment, ["MarketingCarrier", "marketingCarrier", "Carrier", "carrier", "Airline", "airline"]);
}

function getSeatCountStatus(remainingSeats) {
  if (remainingSeats === null || remainingSeats === undefined) {
    return "unknown";
  }
  if (remainingSeats === 0) {
    return "zero_or_unknown";
  }
  return "reported";
}

function createRequestBudget(limit) {
  return {
    count: 0,
    consume(label) {
      if (this.count + 1 > limit) {
        throw new Error(`Seats.aero request budget exceeded before ${label}.`);
      }
      this.count += 1;
    },
  };
}

function extractArray(record, keys) {
  if (Array.isArray(record)) {
    return record;
  }
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function getProviderValue(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeAirportList(values) {
  const airports = Array.isArray(values) ? values : String(values ?? "").split(",");
  const normalized = airports.map(normalizeAirportCode).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("Seats.aero search requires at least one airport.");
  }
  return normalized;
}

function normalizeAirportCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeCabin(value) {
  const cabin = String(value ?? "economy").trim().toLowerCase();
  if (cabin === "premium") return "premium-economy";
  return cabin || "economy";
}

function normalizeAirlineName(value) {
  const name = String(value ?? "Seats.aero").trim();
  return name || "Seats.aero";
}

function normalizeProgram(value) {
  const program = String(value ?? "seats-aero").trim().toLowerCase();
  return program.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "seats-aero";
}

function normalizeDateTime(value) {
  return String(value ?? "").trim();
}

function normalizeDateTimeOrNull(value) {
  const normalized = normalizeDateTime(value);
  return normalized || null;
}

function normalizeDurationMinutes(value, departure, arrival) {
  const number = normalizeNullableNumber(value);
  if (number !== null && number > 0) {
    return number;
  }

  const start = new Date(departure);
  const end = new Date(arrival);
  const minutes = (end.getTime() - start.getTime()) / 60000;
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.round(minutes);
  }

  return 1;
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("Seats.aero award result requires positive mileage.");
  }
  return number;
}

function normalizeMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.round(number * 100) / 100;
}

function normalizeNullableNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringifyProviderValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return String(value);
}

function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

function redactUrl(url) {
  return url.toString();
}
