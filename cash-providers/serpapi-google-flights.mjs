import { expandAirports } from "../search-config.mjs";

const DEFAULT_BASE_URL = "https://serpapi.com/search";
const DEFAULT_MAX_REQUESTS = 6;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SEGMENTS_PER_RESPONSE = 30;
const MAX_BOOKING_OPTIONS = 8;
const MAX_BOOKING_LINKS = 8;
const CASH_PRICE_CAVEAT =
  "Verify current price and availability before booking; Google Flights results may be cached or change.";

export const SERPAPI_CAPABILITIES = Object.freeze({
  cashSearchSupported: true,
  bookingOptionsOnDemand: true,
  departureTokenFollowUp: true,
  cacheAllowedByDefault: true,
});

export function getSerpApiKey(env = process.env) {
  return [env.SERPAPI_GOOGLE_FLIGHTS, env.SERPAPI_API_KEY, env.SERPAPI_KEY, env.SERP_API_KEY]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) ?? "";
}

export function buildSerpApiParams({
  origin,
  destination,
  outboundDate,
  returnDate,
  adults = 1,
  cabin = "economy",
  maxStops,
  bags = 0,
  currency = "USD",
  gl,
  hl,
  noCache = false,
  bookingToken,
  departureToken,
}) {
  const params = new URLSearchParams({
    engine: "google_flights",
    output: "json",
  });

  if (bookingToken) {
    params.set("booking_token", String(bookingToken));
  } else if (departureToken) {
    params.set("departure_token", String(departureToken));
    if (origin) params.set("departure_id", normalizeAirportList(origin));
    if (destination) params.set("arrival_id", normalizeAirportList(destination));
    if (outboundDate) params.set("outbound_date", normalizeDate(outboundDate));
    if (returnDate) params.set("return_date", normalizeDate(returnDate));
  } else {
    params.set("departure_id", normalizeAirportList(origin));
    params.set("arrival_id", normalizeAirportList(destination));
    params.set("type", returnDate ? "1" : "2");
    params.set("outbound_date", normalizeDate(outboundDate));
    if (returnDate) params.set("return_date", normalizeDate(returnDate));
    params.set("travel_class", mapTravelClass(cabin));
    params.set("adults", String(normalizePositiveInteger(adults, 1)));
    if (Number(bags) > 0) params.set("bags", String(normalizeNonNegativeInteger(bags, 0)));
    if (maxStops !== undefined && maxStops !== null) {
      params.set("stops", mapStops(maxStops));
    }
  }

  params.set("currency", String(currency || "USD").toUpperCase());
  if (gl) params.set("gl", String(gl).toLowerCase());
  if (hl) params.set("hl", String(hl).toLowerCase());
  // SerpApi serves an exact cached query by default. Opting into no_cache is
  // deliberately explicit because it consumes a paid search when cache exists.
  if (noCache) params.set("no_cache", "true");
  return params;
}

export function buildSerpApiUrl({ baseUrl = DEFAULT_BASE_URL, apiKey, ...options }) {
  if (!apiKey) throw new Error("SerpApi API key is required.");
  const params = buildSerpApiParams(options);
  params.set("api_key", String(apiKey));
  return new URL(`?${params.toString()}`, ensureQuestionMarkBase(baseUrl));
}

export function buildSerpApiSearchRequests({
  origin,
  destination,
  earliestDeparture,
  latestDeparture,
  earliestReturn,
  latestReturn,
  tripType = "round-trip",
  useNearbyAirports = false,
  cabin = "economy",
  maxStops,
  adults = 1,
  requestBudget = DEFAULT_MAX_REQUESTS,
  maxDatesPerDirection,
  nearbyAirportMaxGroundTravelMinutes = Infinity,
  ...options
}) {
  const budget = normalizePositiveInteger(requestBudget, DEFAULT_MAX_REQUESTS);
  const nativeRoundTripBudget = tripType === "one-way" ? 0 : 1;
  const departureTokenBudget = tripType === "one-way" ? 0 : budget >= 6 ? 2 : 1;
  const directionBudget = tripType === "one-way"
    ? budget
    : Math.max(1, Math.floor(Math.max(0, budget - nativeRoundTripBudget - departureTokenBudget) / 2));
  const perDirection = Math.max(
    1,
    Math.min(
      maxDatesPerDirection === undefined
        ? directionBudget
        : normalizePositiveInteger(maxDatesPerDirection, 1),
      directionBudget
    )
  );
  const outboundWindowDates = enumerateDates(earliestDeparture, latestDeparture);
  const returnWindowDates = tripType === "one-way" ? [] : enumerateDates(earliestReturn, latestReturn);
  const outboundDates = selectBoundedDates(outboundWindowDates, perDirection);
  const returnDates = selectBoundedDates(returnWindowDates, perDirection);
  const originIds = useNearbyAirports
    ? expandAirports(String(origin ?? "").toUpperCase(), true, nearbyAirportMaxGroundTravelMinutes).join(",")
    : String(origin ?? "");
  const destinationIds = useNearbyAirports
    ? expandAirports(String(destination ?? "").toUpperCase(), true, nearbyAirportMaxGroundTravelMinutes).join(",")
    : String(destination ?? "");
  const allRequests = [
    ...(tripType === "one-way" ? [] : outboundDates.slice(0, nativeRoundTripBudget).map((date, index) => ({
      direction: "round-trip",
      nativeRoundTrip: true,
      origin: originIds,
      destination: destinationIds,
      outboundDate: date,
      returnDate: returnDates[index] ?? returnDates[0],
      cabin,
      maxStops,
      adults,
      ...options,
    }))),
    ...outboundDates.map((date) => ({
      direction: "outbound",
      origin: originIds,
      destination: destinationIds,
      outboundDate: date,
      returnDate: undefined,
      cabin,
      maxStops,
      adults,
      ...options,
    })),
    ...returnDates.map((date) => ({
      direction: "return",
      origin: destinationIds,
      destination: originIds,
      outboundDate: date,
      returnDate: undefined,
      cabin,
      maxStops,
      adults,
      ...options,
    })),
  ];

  const requests = tripType === "one-way" ? allRequests.slice(0, budget) : allRequests.slice(0, budget);
  return {
    requests: requests.slice(0, budget - departureTokenBudget),
    requestedCount: allRequests.length,
    budget,
    departureTokenBudget,
    truncated: allRequests.length > budget - departureTokenBudget || outboundWindowDates.length > outboundDates.length || returnWindowDates.length > returnDates.length,
  };
}

export async function querySerpApiGoogleFlights(options = {}) {
  const {
    apiKey = getSerpApiKey(),
    fetchImpl = globalThis.fetch,
    baseUrl = process.env.SERPAPI_BASE_URL ?? DEFAULT_BASE_URL,
    searchState,
    requestBudget = Number(process.env.SERPAPI_MAX_REQUESTS_PER_SEARCH ?? DEFAULT_MAX_REQUESTS),
    timeoutMs = Number(process.env.SERPAPI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    noCache = String(process.env.SERPAPI_NO_CACHE ?? "").toLowerCase() === "true",
    retrievedAt = new Date().toISOString(),
  } = options;

  if (!apiKey) {
    return { ok: false, segments: [], notes: [], reason: "Missing SERPAPI_API_KEY." };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, segments: [], notes: [], reason: "SerpApi adapter requires a fetch implementation." };
  }
  if (!searchState) {
    return { ok: false, segments: [], notes: [], reason: "SerpApi search state is required." };
  }

  const plan = buildSerpApiSearchRequests({
    origin: searchState.origin,
    destination: searchState.destination,
    earliestDeparture: searchState.earliestDeparture,
    latestDeparture: searchState.latestDeparture,
    earliestReturn: searchState.earliestReturn,
    latestReturn: searchState.latestReturn,
    tripType: searchState.tripType,
    useNearbyAirports: searchState.useNearbyAirports,
    cabin: searchState.cabinPreference,
    maxStops: searchState.maxStops,
    adults: searchState.passengers?.adults ?? 1,
    bags: (searchState.carryOnBagsPerTraveler ?? 1) * (searchState.passengers?.adults ?? 1),
    requestBudget,
    nearbyAirportMaxGroundTravelMinutes: searchState.nearbyAirportMaxGroundTravelMinutes,
    noCache,
  });
  const initialResults = await Promise.all(
    plan.requests.map((request) =>
      fetchSerpApiResult({
        fetchImpl,
        baseUrl,
        apiKey,
        timeoutMs,
        retrievedAt,
        request,
      })
    )
  );
  const tokenWork = initialResults
    .map((result, index) => ({ result, request: plan.requests[index] }))
    .filter(({ result, request }) => request.nativeRoundTrip && result.ok)
    .flatMap(({ result, request }) => result.segments
      .map((segment) => ({ segment, token: segment.providerEvidence?.[0]?.departureToken, origin: request.origin, destination: request.destination, outboundDate: request.outboundDate, returnDate: request.returnDate }))
      .filter(({ token }) => token)
      .slice(0, plan.departureTokenBudget));
  const tokenResults = await Promise.all(tokenWork.map(({ token, origin, destination, outboundDate, returnDate }) => fetchSerpApiResult({
    fetchImpl,
    baseUrl,
    apiKey,
    timeoutMs,
    retrievedAt,
    request: { departureToken: token, origin, destination, outboundDate, returnDate, direction: "return" },
  })));
  const results = [...initialResults, ...tokenResults];
  const successes = results.filter((result) => result.ok);
  const pairedOutboundSignatures = new Set(
    tokenWork
      .filter((_, index) => tokenResults[index]?.segments?.some((segment) => Number.isFinite(segment.cashPrice)))
      .map(({ segment }) => segmentSignature(segment))
  );
  const roundTripSegments = tokenWork.flatMap(({ segment: outbound }, index) => {
    const inbound = tokenResults[index]?.segments?.[0];
    if (!inbound || !Number.isFinite(inbound.cashPrice)) return [];
    const bundleId = `${outbound.origin}-${outbound.destination}-${outbound.departure}-${inbound.departure}`;
    return [
      { ...outbound, cashPrice: inbound.cashPrice, roundTripBundleId: bundleId, roundTripBundlePrice: inbound.cashPrice },
      { ...inbound, direction: "round-trip-return", cashPrice: null, roundTripBundleId: bundleId, roundTripBundlePrice: inbound.cashPrice },
    ];
  });
  const segments = dedupeSegments([
    ...initialResults.flatMap((result, index) => plan.requests[index]?.nativeRoundTrip
      ? (result.segments ?? []).filter((segment) => !pairedOutboundSignatures.has(segmentSignature(segment)))
      : (result.segments ?? [])),
    ...roundTripSegments,
  ]);
  const failures = results.filter((result) => !result.ok).map((result) => result.reason);
  const notes = [];

  const totalRequestCount = plan.requests.length + tokenWork.length;
  if (plan.truncated) {
    notes.push(
      `SerpApi cash search used ${totalRequestCount} of its ${plan.budget}-request budget; widen coverage with SERPAPI_MAX_REQUESTS_PER_SEARCH or narrow the date window.`
    );
  } else {
    notes.push(`SerpApi cash search used ${totalRequestCount} request(s) within its ${plan.budget}-request budget.`);
  }
  if (failures.length > 0) {
    notes.push(`${failures.length} SerpApi request(s) failed and were skipped.`);
    notes.push(`SerpApi failure details: ${failures.slice(0, 2).join("; ")}`);
  }
  if (segments.length === 0) {
    return {
      ok: false,
      segments: [],
      notes,
      reason: failures.length > 0
        ? `SerpApi returned no usable cash fares. ${failures.slice(0, 2).join("; ")}`
        : "SerpApi returned no cash fares for the bounded date windows.",
      requestCount: plan.requests.length + tokenWork.length,
    };
  }

  return {
    ok: true,
    providerId: "serpapi-google-flights",
    provider: "serpapi-google-flights",
    capabilities: SERPAPI_CAPABILITIES,
    segments,
    notes,
    requestCount: plan.requests.length + tokenWork.length,
    partial: failures.length > 0,
  };
}

function segmentSignature(segment) {
  return [segment.origin, segment.destination, segment.departure, segment.arrival, segment.airline].join("|");
}

export async function querySerpApiBookingOptions(options = {}) {
  const {
    apiKey = getSerpApiKey(),
    fetchImpl = globalThis.fetch,
    baseUrl = process.env.SERPAPI_BASE_URL ?? DEFAULT_BASE_URL,
    bookingToken,
    timeoutMs = Number(process.env.SERPAPI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    noCache = String(process.env.SERPAPI_NO_CACHE ?? "").toLowerCase() === "true",
    retrievedAt = new Date().toISOString(),
  } = options;

  if (!apiKey) return { ok: false, reason: "Missing SERPAPI_API_KEY." };
  if (!bookingToken) return { ok: false, reason: "SerpApi booking token is missing." };
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "SerpApi adapter requires a fetch implementation." };
  }

  const result = await fetchSerpApiResult({
    fetchImpl,
    baseUrl,
    apiKey,
    timeoutMs,
    retrievedAt,
    request: { bookingToken, noCache },
    bookingLookup: true,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    provider: "serpapi-google-flights",
    retrievedAt,
    verification: result.metadata.verification,
    cache: result.cache,
    selectedFlights: result.selectedFlights,
    baggage: result.baggage,
    bookingOptions: result.bookingOptions,
    bookingLinks: result.bookingLinks,
    priceInsights: result.priceInsights,
    caveats: [CASH_PRICE_CAVEAT],
  };
}

export function mapSerpApiResponse(payload, request, { retrievedAt = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("SerpApi response was not a JSON object.");
  }
  if (payload.error) throw new Error(`SerpApi returned an error: ${String(payload.error)}`);
  const hasFlightArrays = Array.isArray(payload.best_flights) || Array.isArray(payload.other_flights);
  const hasBookingArrays = Array.isArray(payload.booking_options) || Array.isArray(payload.selected_flights);
  if (!hasFlightArrays && !hasBookingArrays) {
    throw new Error("SerpApi response did not contain flight or booking-option results.");
  }

  const metadata = buildMetadata(payload, request, retrievedAt);
  const flights = [...(payload.best_flights ?? []), ...(payload.other_flights ?? [])]
    .slice(0, MAX_SEGMENTS_PER_RESPONSE);
  const segments = flights
    .map((flight) => mapFlightToSegment(flight, request, metadata))
    .filter(Boolean);
  const rawBookingOptions = Array.isArray(payload.booking_options) ? payload.booking_options : [];
  const bookingOptions = normalizeBookingOptions(rawBookingOptions);
  const selectedFlights = Array.isArray(payload.selected_flights)
    ? payload.selected_flights.slice(0, 2).map((flight) => normalizeSelectedFlight(flight))
    : [];
  const baggage = normalizeBaggage(payload.baggage_prices);
  const bookingLinks = collectBookingLinks(
    rawBookingOptions.flatMap(getBookingSources)
  );

  return {
    segments,
    metadata,
    cache: metadata.cache,
    selectedFlights,
    baggage,
    bookingOptions,
    bookingLinks,
    priceInsights: normalizePriceInsights(payload.price_insights),
  };
}

async function fetchSerpApiResult({
  fetchImpl,
  baseUrl,
  apiKey,
  timeoutMs,
  retrievedAt,
  request,
  bookingLookup = false,
}) {
  let url;
  try {
    url = buildSerpApiUrl({ baseUrl, apiKey, ...request });
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  } catch (error) {
    return { ok: false, reason: `SerpApi request failed: ${error.message}` };
  }
  if (!response?.ok) {
    let detail = "";
    try {
      const body = await response?.text?.();
      detail = body ? ` ${String(body).slice(0, 240)}` : "";
    } catch {
      // Preserve the HTTP failure when the provider does not expose a readable body.
    }
    return { ok: false, reason: `SerpApi request failed with HTTP ${response?.status ?? "unknown"}.${detail}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, reason: `SerpApi returned invalid JSON: ${error.message}` };
  }

  try {
    const mapped = mapSerpApiResponse(payload, request, { retrievedAt });
    return { ok: true, ...mapped };
  } catch (error) {
    return { ok: false, reason: `SerpApi response was malformed: ${error.message}` };
  }
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mapFlightToSegment(flight, request, metadata) {
  const flightSegments = Array.isArray(flight?.flights) ? flight.flights : [];
  if (flightSegments.length === 0) return null;
  const first = flightSegments[0];
  const last = flightSegments[flightSegments.length - 1];
  const price = Number(flight.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const normalizedSegments = flightSegments.map((item) => ({
    origin: normalizeAirportCode(item.departure_airport?.id),
    destination: normalizeAirportCode(item.arrival_airport?.id),
    departure: normalizeDateTime(item.departure_airport?.time),
    arrival: normalizeDateTime(item.arrival_airport?.time),
    marketingCarrier: normalizeText(item.airline),
    operatingCarrier: normalizeText(item.plane_and_crew_by),
    flightNumber: normalizeText(item.flight_number),
    cabin: mapTravelClassToCabin(item.travel_class),
    fareClass: null,
    aircraft: normalizeText(item.airplane),
    distance: null,
    extensions: boundedStrings(item.extensions, 6, 160),
    baggage: null,
  }));

  const providerEvidence = {
    provider: "serpapi-google-flights",
    type: "cash_search",
    searchLink: metadata.searchLink,
    bookingToken: normalizeText(flight.booking_token),
    departureToken: normalizeText(flight.departure_token),
    priceInsights: metadata.priceInsights,
    cache: metadata.cache,
    retrievedAt: metadata.retrievedAt,
    requestedCarryOnBags: normalizeNonNegativeInteger(request.bags, 0),
    baggage: metadata.baggage,
    bookingOptions: metadata.bookingOptions,
    bookingLinks: metadata.bookingLinks,
    caveats: [CASH_PRICE_CAVEAT],
  };

  return {
    origin: normalizeAirportCode(first.departure_airport?.id) || normalizeAirportCode(request.origin),
    destination: normalizeAirportCode(last.arrival_airport?.id) || normalizeAirportCode(request.destination),
    airline: normalizeText(first.airline) || "Unknown",
    cabin: mapTravelClassToCabin(first.travel_class) ?? request.cabin ?? "economy",
    departure: normalizeDateTime(first.departure_airport?.time),
    arrival: normalizeDateTime(last.arrival_airport?.time),
    stops: Math.max(flightSegments.length - 1, 0),
    durationMinutes: normalizePositiveNumber(flight.total_duration) ?? sumDurations(flightSegments),
    cashPrice: price,
    cashAvailable: true,
    awardOptions: [],
    flightSegments: normalizedSegments,
    direction: request.direction ?? null,
    provider: "serpapi-google-flights",
    verification: metadata.verification,
    retrievedAt: metadata.retrievedAt,
    providerUpdatedAt: metadata.processedAt,
    providerEvidence: [providerEvidence],
    providerCaveats: [CASH_PRICE_CAVEAT],
  };
}

function buildMetadata(payload, request, retrievedAt) {
  const searchMetadata = payload.search_metadata ?? {};
  const cached = searchMetadata.cached === true ? true : searchMetadata.cached === false ? false : null;
  const cacheStatus = cached === true
    ? "cached"
    : cached === false || request.noCache === true
      ? "fresh"
      : "cache-eligible";
  const processedAt = normalizeText(searchMetadata.processed_at);
  const searchLink = safeHttpsUrl(searchMetadata.google_flights_url) ?? buildGoogleFlightsLink(request);
  return {
    searchLink,
    cache: {
      status: cacheStatus,
      cached,
      cacheAllowed: request.noCache !== true,
      expiresAfter: "approximately 1 hour when served from SerpApi cache",
    },
    retrievedAt,
    processedAt,
    verification: cacheStatus === "fresh" ? "provider_refreshed" : "discovered_cached",
    priceInsights: normalizePriceInsights(payload.price_insights),
    baggage: normalizeBaggage(payload.baggage_prices),
    bookingOptions: normalizeBookingOptions(payload.booking_options),
    bookingLinks: collectBookingLinks(
      (Array.isArray(payload.booking_options) ? payload.booking_options : [])
        .flatMap(getBookingSources)
    ),
  };
}

function normalizeBookingOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, MAX_BOOKING_OPTIONS).map((option) => {
    const sources = getBookingSources(option);
    const source = option?.together ?? option?.departing ?? option?.returning ?? option?.separate ?? {};
    return {
      separateTickets: Boolean(option?.separate_tickets),
      bookWith: normalizeText(source.book_with),
      airline: source.airline === true,
      marketedAs: boundedStrings(source.marketed_as, 8, 80),
      price: normalizePositiveNumber(source.price),
      currency: normalizeText(source.local_prices?.[0]?.currency) ?? "USD",
      localPrice: normalizePositiveNumber(source.local_prices?.[0]?.price),
      optionTitle: normalizeText(source.option_title),
      baggage: boundedStrings(source.baggage_prices, 8, 160),
      extensions: boundedStrings(source.extensions, 8, 160),
      bookingLinks: collectBookingLinks(sources),
      legs: [
        ["together", option?.together],
        ["departing", option?.departing],
        ["returning", option?.returning],
      ].filter(([, item]) => item).map(([direction, item]) => ({
        direction,
        bookWith: normalizeText(item.book_with),
        price: normalizePositiveNumber(item.price),
        currency: normalizeText(item.local_prices?.[0]?.currency) ?? "USD",
        localPrice: normalizePositiveNumber(item.local_prices?.[0]?.price),
        bookingLinks: collectBookingLinks([item]),
      })),
    };
  });
}

function getBookingSources(option) {
  if (!option || typeof option !== "object") return [];
  return [option.together, option.departing, option.returning, option.separate].filter(Boolean);
}

function normalizeSelectedFlight(flight) {
  return {
    price: normalizePositiveNumber(flight?.price),
    type: normalizeText(flight?.type),
    flights: Array.isArray(flight?.flights)
      ? flight.flights.slice(0, 6).map((item) => ({
        origin: normalizeAirportCode(item.departure_airport?.id),
        destination: normalizeAirportCode(item.arrival_airport?.id),
        departure: normalizeDateTime(item.departure_airport?.time),
        arrival: normalizeDateTime(item.arrival_airport?.time),
        airline: normalizeText(item.airline),
        flightNumber: normalizeText(item.flight_number),
      }))
      : [],
  };
}

function normalizeBaggage(value) {
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 4)
      .map(([key, items]) => [key, boundedStrings(items, 8, 160)])
  );
}

function normalizePriceInsights(value) {
  if (!value || typeof value !== "object") return null;
  return {
    lowestPrice: normalizePositiveNumber(value.lowest_price),
    priceLevel: normalizeText(value.price_level),
    typicalPriceRange: Array.isArray(value.typical_price_range)
      ? value.typical_price_range.slice(0, 2).map((item) => normalizePositiveNumber(item))
      : [],
  };
}

function collectBookingLinks(options) {
  return options
    .flatMap((option) => {
      const request = option?.booking_request;
      const url = typeof request === "string" ? request : request?.url;
      const safeUrl = safeHttpsUrl(url);
      if (!safeUrl) return [];
      return [{
        label: normalizeText(option?.book_with) ?? "Open booking option",
        url: safeUrl,
        requiresPostData: Boolean(request?.post_data),
      }];
    })
    .slice(0, MAX_BOOKING_LINKS);
}

function buildGoogleFlightsLink(request) {
  const query = [request.origin, "to", request.destination, request.outboundDate].filter(Boolean).join(" ");
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

function dedupeSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    const key = [segment.direction, segment.origin, segment.destination, segment.departure, segment.arrival, segment.airline].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectBoundedDates(dates, limit) {
  if (dates.length <= limit) return dates;
  if (limit === 1) return [dates[0]];
  const indexes = new Set([0, dates.length - 1]);
  for (let index = 1; indexes.size < limit; index += 1) {
    indexes.add(Math.round((index * (dates.length - 1)) / (limit - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => dates[index]);
}

function enumerateDates(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const dates = [];
  for (let current = start; current <= end; current.setUTCDate(current.getUTCDate() + 1)) {
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function sumDurations(segments) {
  const total = segments.reduce((sum, segment) => sum + (Number(segment.duration) || 0), 0);
  return total > 0 ? total : 1;
}

function mapTravelClass(cabin) {
  return { economy: "1", "premium-economy": "2", premium: "2", business: "3", first: "4" }[
    String(cabin ?? "economy").toLowerCase()
  ] ?? "1";
}

function mapTravelClassToCabin(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("first")) return "first";
  if (normalized.includes("business")) return "business";
  if (normalized.includes("premium")) return "premium-economy";
  if (normalized.includes("economy")) return "economy";
  return null;
}

function mapStops(maxStops) {
  const stops = Number(maxStops);
  if (!Number.isInteger(stops) || stops < 0) return "0";
  return String(Math.min(stops + 1, 3));
}

function normalizeAirportList(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  const normalized = values.map(normalizeAirportCode).filter(Boolean);
  if (normalized.length === 0) throw new Error("SerpApi search requires airport codes.");
  return normalized.join(",");
}

function normalizeAirportCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("SerpApi search requires YYYY-MM-DD dates.");
  return date;
}

function normalizeDateTime(value) {
  return String(value ?? "").trim().replace(" ", "T");
}

function normalizeText(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  return text ? text.slice(0, 240) : null;
}

function boundedStrings(value, limit, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => String(item ?? "").slice(0, maxLength)).filter(Boolean);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeHttpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function ensureQuestionMarkBase(baseUrl) {
  const value = String(baseUrl);
  return value.includes("?") ? `${value}&` : `${value}?`;
}
