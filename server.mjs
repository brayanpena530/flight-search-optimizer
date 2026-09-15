import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SEATS_AERO_CAPABILITIES } from "./award-providers/seats-aero.mjs";
import { runAutomationWorkers } from "./automation-workers.mjs";
import {
  getSerpApiKey,
  SERPAPI_CAPABILITIES,
  querySerpApiGoogleFlights,
} from "./cash-providers/serpapi-google-flights.mjs";
import { expandAirports } from "./search-config.mjs";
import { createOptimizerService, segmentSignature } from "./optimizer-service.mjs";
import { normalizeAndValidateSearchState } from "./search-state.mjs";
import { getTransferPartnerCache, transferRatiosFromRecords } from "./transfer-partner-cache.mjs";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));

loadDotEnvFile();

const PORT = Number(process.env.PORT ?? 8000);
const AMADEUS_BASE_URL = process.env.AMADEUS_BASE_URL ?? "https://test.api.amadeus.com";
const AMADEUS_MAX_OFFERS_PER_DAY = Number(process.env.AMADEUS_MAX_OFFERS_PER_DAY ?? 5);
// Live searches can fan out across nearby-airport groups and date windows. Cap the
// total number of flight-offer requests per search so a wide window cannot stall the
// page or burn through Amadeus rate limits in a single submission.
const AMADEUS_MAX_REQUESTS_PER_SEARCH = Number(process.env.AMADEUS_MAX_REQUESTS_PER_SEARCH ?? 60);
// Amadeus (especially the test environment) rate-limits aggressively and answers with
// HTTP 429. Retry those with exponential backoff instead of aborting the whole search.
const AMADEUS_MAX_RETRIES = Number(process.env.AMADEUS_MAX_RETRIES ?? 2);
const AMADEUS_RETRY_BASE_MS = Number(process.env.AMADEUS_RETRY_BASE_MS ?? 500);
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS ?? 20_000);
const tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function loadDotEnvFile() {
  const envPath = join(ROOT_DIR, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }

  return value;
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url?.startsWith("/api/providers/health")) {
      await handleProviderHealth(request, response);
      return;
    }

    if (request.url?.startsWith("/api/providers/")) {
      await handleProviderApi(request, response);
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Internal server error", detail: String(error) }));
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`Flight Search Optimizer server listening on http://localhost:${PORT}`);
  });
}

async function handleProviderApi(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, reason: "Only POST is supported." }));
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const providerId = url.pathname.split("/").pop();
  const rawSearchState = await readJsonBody(request);
  const { searchState, errors } = normalizeAndValidateSearchState(rawSearchState);

  if (providerId !== "sample-segments" && errors.length > 0) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, providerId, validationErrors: errors }));
    return;
  }

  if (providerId === "sample-segments") {
    const segments = await loadSampleSegments();
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, segments, providerId }));
    return;
  }

  if (providerId === "amadeus-flight-offers") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(await queryAmadeusStub(searchState)));
    return;
  }

  if (providerId === "duffel") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(await queryDuffelStub(searchState)));
    return;
  }

  if (providerId === "award-automation") {
    const segments = await loadSampleSegments();
    const automationResult = await runAutomationWorkers({
      segments,
      searchState,
      matchesFallbackWindow,
    });
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        ok: true,
        segments: automationResult.segments,
        workers: automationResult.attemptedWorkers,
        providerId,
      })
    );
    return;
  }

  if (providerId === "search") {
    const searchResult = await resolveSearch(searchState);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(searchResult));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: false, reason: "Unknown provider route." }));
}

async function handleProviderHealth(request, response) {
  const health = await buildProviderHealth();

  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(health));
}

export async function buildProviderHealth() {
  const amadeusConfigured = Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
  const health = {
    ok: true,
    checkedAt: new Date().toISOString(),
    providers: [
      {
        id: "serpapi-google-flights",
        name: "SerpApi Google Flights",
        capability: "cash",
        configured: Boolean(getSerpApiKey()),
        status: getSerpApiKey()
          ? "live"
          : "missing-credentials",
        detail: getSerpApiKey()
          ? "Google Flights cash discovery is configured. Booking options are fetched only when a finalist is inspected or rechecked."
          : "Set SERPAPI_API_KEY in .env to enable bounded Google Flights cash discovery.",
        capabilities: SERPAPI_CAPABILITIES,
      },
      {
        id: "amadeus-flight-offers",
        name: "Amadeus Flight Offers",
        capability: "cash",
        configured: amadeusConfigured,
        baseUrl: AMADEUS_BASE_URL,
        status: amadeusConfigured ? "checking" : "missing-credentials",
        detail: amadeusConfigured
          ? null
          : "Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET in .env to enable live cash fares.",
      },
      {
        id: "duffel",
        name: "Duffel",
        capability: "cash",
        configured: Boolean(process.env.DUFFEL_API_TOKEN),
        status: "not-implemented",
        detail: "Live offer creation and mapping are not implemented yet.",
      },
      {
        id: "seats-aero",
        name: "Seats.aero Cached Awards",
        capability: "awards",
        configured: Boolean(process.env.SEATS_AERO_API_KEY),
        status: process.env.SEATS_AERO_API_KEY ? "cached" : "missing-credentials",
        detail: process.env.SEATS_AERO_API_KEY
          ? "Cached award search is configured. Live Search is not enabled for personal Pro API keys."
          : "Set SEATS_AERO_API_KEY in .env to enable cached award discovery.",
        capabilities: SEATS_AERO_CAPABILITIES,
      },
    ],
  };

  if (amadeusConfigured) {
    const amadeus = health.providers.find((provider) => provider.id === "amadeus-flight-offers");
    try {
      await getAmadeusAccessToken();
      amadeus.status = "live";
      amadeus.detail = "Authenticated with Amadeus. Live cash fares are available.";
    } catch (error) {
      amadeus.status = "auth-failed";
      amadeus.detail = `Credentials present but authentication failed: ${error.message}`;
    }
  }

  return health;
}

const optimizerService = createOptimizerService({ resolveCashSegments, resolveAwardSegments });
export async function resolveSearch(searchState) {
  const transferCache = await getTransferPartnerCache();
  const enrichedSearchState = {
    ...searchState,
    transferRatios: transferRatiosFromRecords(transferCache.records),
  };
  const result = await optimizerService.resolveSearch(enrichedSearchState);
  return {
    ...result,
    transferPartnerData: {
      status: transferCache.status,
      fetchedAt: transferCache.fetchedAt,
      records: transferCache.records,
    },
    warnings: [...(transferCache.warnings ?? []), ...(result.warnings ?? [])],
  };
}

async function resolveCashSegments(searchState, attempts) {
  const cashSources = buildCashSourcePlan(searchState);
  const results = await querySources(cashSources, searchState, "cash", attempts);
  const successes = selectSuccessfulSources(results);
  const segments = successes.flatMap(({ source, result }) => result.segments.map((segment) => ({
    ...segment,
    cashAvailable: true,
    sourceProviderId: source.id,
    sourceProviderName: source.name,
    sourceCapability: "cash",
    sourceStatus: getSegmentSourceStatus(source, segment),
  })));
  return summarizeResolution(successes, segments, "cash", results);
}

async function resolveAwardSegments(searchState, attempts) {
  const awardSources = buildAwardSourcePlan(searchState);
  const results = await querySources(awardSources, searchState, "awards", attempts);
  const successes = selectSuccessfulSources(results);
  const segments = successes.flatMap(({ source, result }) => result.segments.map((segment) => ({
    ...segment,
    cashAvailable: false,
    sourceProviderId: source.id,
    sourceProviderName: source.name,
    sourceCapability: "awards",
    sourceStatus: getSegmentSourceStatus(source, segment),
  })));
  const resolution = summarizeResolution(successes, segments, "awards", results);
  resolution.workers = results.flatMap(({ result }) => result.workers ?? []);
  return resolution;
}

async function querySources(sources, searchState, capability, attempts) {
  const results = await Promise.all(sources.map(async (source) => {
    try {
      const result = await withTimeout(source.query(searchState), PROVIDER_TIMEOUT_MS);
      return { source, result };
    } catch (error) {
      return { source, result: { ok: false, reason: error.message } };
    }
  }));

  for (const { source, result } of results) {
    attempts.push({
      name: source.name,
      outcome: result.ok
        ? `loaded ${result.segments.length} ${capability} segment candidates`
        : result.reason,
    });
  }
  return results;
}

function summarizeResolution(successes, segments, capability, results) {
  const sourceSummaries = successes.map(({ source, result }) => {
    const sourceSegments = result.segments ?? [];
    const status = source.type === "sample"
      ? "sample"
      : sourceSegments.some((segment) => segment.verification === "discovered_cached")
        ? "cached"
        : "live";
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      capability,
      status,
      notes: result.notes ?? [],
    };
  });
  const types = [...new Set(sourceSummaries.map((source) => source.type))];
  return {
    providerName: sourceSummaries.length === 1 ? sourceSummaries[0].name : sourceSummaries.length > 1 ? `Multiple ${capability} sources` : null,
    providerType: types.length === 1 ? types[0] : types.length > 1 ? "mixed" : null,
    sources: sourceSummaries,
    notes: sourceSummaries.flatMap((source) => source.notes),
    segments,
    workers: [],
    failedSources: results.filter(({ result }) => !result.ok).map(({ source, result }) => ({ name: source.name, reason: result.reason })),
  };
}

function getSegmentSourceStatus(source, segment) {
  if (source.type === "sample") return "sample";
  if (segment.verification === "discovered_cached") return "cached";
  return "live";
}

function selectSuccessfulSources(results) {
  const successful = results.filter(({ result }) => result.ok);
  const primary = successful.filter(({ source }) => !source.fallback);
  return primary.length > 0 ? primary : successful;
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Provider timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function buildCashSourcePlan(searchState) {
  const officialSources = [
    {
      id: "serpapi-google-flights",
      name: "SerpApi Google Flights",
      type: "official",
      query: (searchState) => querySerpApiGoogleFlights({ searchState }),
    },
    {
      id: "amadeus-flight-offers",
      name: "Amadeus Flight Offers",
      type: "official",
      query: queryAmadeusStub,
    },
    {
      id: "duffel",
      name: "Duffel",
      type: "official",
      query: queryDuffelStub,
    },
  ];
  const sampleSource = {
    id: "sample-segments",
    name: "Sample Segment Inventory",
    type: "sample",
    fallback: true,
    query: querySampleSegments,
  };

  if (searchState.dataStrategy === "sample-only") {
    return [sampleSource];
  }

  return [...officialSources, sampleSource];
}

function buildAwardSourcePlan(searchState) {
  const sampleSource = {
    id: "sample-segments",
    name: "Sample Segment Inventory",
    type: "sample",
    fallback: true,
    query: querySampleAwardSegments,
  };
  const automationSource = {
    id: "award-automation",
    name: "Award Automation Fallback",
    type: "automation",
    query: queryAwardAutomation,
  };

  if (searchState.dataStrategy === "sample-only") {
    return [sampleSource];
  }

  if (searchState.dataStrategy === "official-first" || searchState.dataStrategy === "official-then-automation") {
    return [automationSource, sampleSource];
  }

  return [sampleSource];
}

async function querySampleSegments() {
  return {
    ok: true,
    segments: await loadSampleSegments(),
  };
}

async function querySampleAwardSegments() {
  const segments = await loadSampleSegments();
  return {
    ok: true,
    segments: segments.filter((segment) => Array.isArray(segment.awardOptions) && segment.awardOptions.length > 0),
  };
}

async function queryAwardAutomation(searchState) {
  const segments = await loadSampleSegments();
  const automationResult = await runAutomationWorkers({
    segments,
    searchState,
    matchesFallbackWindow,
  });

  if (automationResult.segments.length === 0) {
    return {
      ok: false,
      reason: buildAutomationFailureReason(automationResult.attemptedWorkers),
      segments: [],
      workers: automationResult.attemptedWorkers,
    };
  }

  return {
    ok: true,
    segments: automationResult.segments,
    workers: automationResult.attemptedWorkers,
  };
}

function buildAutomationFailureReason(workers) {
  if (!workers.length) {
    return "No award automation workers were selected.";
  }

  const failedWorkers = workers.filter((worker) => worker.mode === "error");
  if (failedWorkers.length === workers.length) {
    return `All award automation workers failed: ${failedWorkers
      .map((worker) => `${worker.program} ${worker.outcome}`)
      .join("; ")}.`;
  }

  return "Award automation produced no segment candidates for the selected programs and trip window.";
}

async function queryAmadeusStub(searchState) {
  if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) {
    return {
      ok: false,
      reason: "Missing AMADEUS_CLIENT_ID or AMADEUS_CLIENT_SECRET.",
    };
  }

  let accessToken;
  try {
    accessToken = await getAmadeusAccessToken();
  } catch (error) {
    return {
      ok: false,
      reason: `Amadeus authentication failed: ${error.message}`,
    };
  }

  // Shared budget/failure tracker so the outbound and return passes together stay
  // within one request allowance and report partial failures instead of aborting.
  const requestContext = {
    budget: AMADEUS_MAX_REQUESTS_PER_SEARCH,
    used: 0,
    failures: [],
    budgetExhausted: false,
  };

  const [outboundSegments, returnSegments] = await Promise.all([
    collectAmadeusSegments({
      origins: expandAirports(searchState.origin, searchState.useNearbyAirports),
      destinations: expandAirports(searchState.destination, searchState.useNearbyAirports),
      startDate: searchState.earliestDeparture,
      endDate: searchState.latestDeparture,
      searchState,
      accessToken,
      adults: searchState.passengers.adults,
      requestContext,
    }),
    collectAmadeusSegments({
      origins: expandAirports(searchState.destination, searchState.useNearbyAirports),
      destinations: expandAirports(searchState.origin, searchState.useNearbyAirports),
      startDate: searchState.earliestReturn,
      endDate: searchState.latestReturn,
      searchState,
      accessToken,
      adults: searchState.passengers.adults,
      requestContext,
    }),
  ]);

  const segments = dedupeSegments([...outboundSegments, ...returnSegments]);

  if (segments.length === 0) {
    return {
      ok: false,
      reason: summarizeAmadeusFailure(requestContext),
    };
  }

  return {
    ok: true,
    segments,
    providerId: "amadeus-flight-offers",
    notes: buildAmadeusNotes(requestContext),
  };
}

function summarizeAmadeusFailure(requestContext) {
  if (requestContext.failures.length === 0) {
    return "Amadeus returned no cash fares for the requested airports and dates.";
  }

  const sample = requestContext.failures.slice(0, 3).join("; ");
  const suffix = requestContext.failures.length > 3 ? `; and ${requestContext.failures.length - 3} more` : "";
  return `Amadeus returned no usable cash fares. Errors: ${sample}${suffix}.`;
}

function buildAmadeusNotes(requestContext) {
  const notes = [];
  if (requestContext.budgetExhausted) {
    notes.push(
      `Live cash search hit its ${requestContext.budget}-request budget; narrow the date window or disable nearby airports for fuller coverage.`
    );
  }
  if (requestContext.failures.length > 0) {
    notes.push(`${requestContext.failures.length} live cash request(s) failed and were skipped.`);
  }
  return notes;
}

async function queryDuffelStub(searchState) {
  if (!process.env.DUFFEL_API_TOKEN) {
    return {
      ok: false,
      reason: "Missing DUFFEL_API_TOKEN.",
    };
  }

  return {
    ok: false,
    reason: `Duffel backend contract is scaffolded for ${searchState.origin}-${searchState.destination} but live offer creation and mapping are not implemented yet.`,
  };
}

async function loadSampleSegments() {
  const dataPath = join(ROOT_DIR, "data", "sample-flights.json");
  const raw = await readFile(dataPath, "utf-8");
  return JSON.parse(raw);
}

function matchesFallbackWindow(segment, searchState) {
  const date = segment.departure?.slice(0, 10);
  if (!date) {
    return false;
  }

  const inOutboundWindow =
    searchState.earliestDeparture &&
    searchState.latestDeparture &&
    date >= searchState.earliestDeparture &&
    date <= searchState.latestDeparture;
  const inReturnWindow =
    searchState.earliestReturn &&
    searchState.latestReturn &&
    date >= searchState.earliestReturn &&
    date <= searchState.latestReturn;

  return inOutboundWindow || inReturnWindow;
}

async function getAmadeusAccessToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.accessToken;
  }

  const formBody = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET,
  });

  const response = await fetch(`${AMADEUS_BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  if (!response.ok) {
    throw new Error(`token endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  tokenCache.accessToken = payload.access_token;
  tokenCache.expiresAt = Date.now() + Number(payload.expires_in ?? 0) * 1000;
  return tokenCache.accessToken;
}

async function collectAmadeusSegments({
  origins,
  destinations,
  startDate,
  endDate,
  searchState,
  accessToken,
  adults,
  requestContext,
}) {
  const dates = enumerateDates(startDate, endDate);
  const allSegments = [];

  for (const origin of origins) {
    for (const destination of destinations) {
      if (origin === destination) {
        continue;
      }

      for (const departureDate of dates) {
        if (requestContext.used >= requestContext.budget) {
          requestContext.budgetExhausted = true;
          return allSegments.filter(Boolean);
        }
        requestContext.used += 1;

        try {
          const offers = await fetchAmadeusFlightOffers({
            origin,
            destination,
            departureDate,
            accessToken,
            cabinPreference: searchState.cabinPreference,
            maxStops: searchState.maxStops,
            adults,
          });
          allSegments.push(...offers.map((offer) => mapAmadeusOfferToSegment(offer, origin, destination, adults)));
        } catch (error) {
          // One failing airport pair or date must not sink the entire live search.
          requestContext.failures.push(`${origin}-${destination} on ${departureDate}: ${error.message}`);
        }
      }
    }
  }

  return allSegments.filter(Boolean);
}

async function fetchAmadeusFlightOffers({
  origin,
  destination,
  departureDate,
  accessToken,
  cabinPreference,
  maxStops,
  adults,
}) {
  const params = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate,
    adults: String(adults),
    max: String(AMADEUS_MAX_OFFERS_PER_DAY),
  });

  const travelClass = mapCabinToAmadeus(cabinPreference);
  if (travelClass) {
    params.set("travelClass", travelClass);
  }

  if (maxStops === 0) {
    params.set("nonStop", "true");
  }

  const url = `${AMADEUS_BASE_URL}/v2/shopping/flight-offers?${params.toString()}`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.ok) {
      const payload = await response.json();
      return payload.data ?? [];
    }

    // Back off and retry on rate limits; the Amadeus test tier returns 429 often.
    if (response.status === 429 && attempt < AMADEUS_MAX_RETRIES) {
      await delay(resolveRetryDelayMs(response, attempt));
      continue;
    }

    throw new Error(
      `flight offers endpoint returned HTTP ${response.status} for ${origin}-${destination} on ${departureDate}`
    );
  }
}

function resolveRetryDelayMs(response, attempt) {
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return AMADEUS_RETRY_BASE_MS * 2 ** attempt;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapAmadeusOfferToSegment(offer, requestedOrigin, requestedDestination, adults = 1) {
  const itinerary = offer.itineraries?.[0];
  const segments = itinerary?.segments ?? [];
  if (segments.length === 0) {
    return null;
  }

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const stops = Math.max(segments.length - 1, 0);
  const totalCashPrice = Number(offer.price?.grandTotal ?? offer.price?.total ?? 0);
  if (!Number.isFinite(totalCashPrice) || totalCashPrice <= 0) {
    return null;
  }
  const passengerCount = Math.max(Number(adults) || 1, 1);
  const cashPrice = roundCurrency(totalCashPrice / passengerCount);

  return {
    origin: firstSegment.departure?.iataCode ?? requestedOrigin,
    destination: lastSegment.arrival?.iataCode ?? requestedDestination,
    airline: offer.validatingAirlineCodes?.[0] ?? firstSegment.carrierCode ?? "Unknown",
    cabin: mapAmadeusCabinToUi(extractOfferCabin(offer)),
    departure: firstSegment.departure?.at,
    arrival: lastSegment.arrival?.at,
    stops,
    durationMinutes: parseIsoDurationToMinutes(itinerary.duration),
    cashPrice,
    awardOptions: [],
  };
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function mapCabinToAmadeus(cabinPreference) {
  return {
    economy: "ECONOMY",
    "premium-economy": "PREMIUM_ECONOMY",
    business: "BUSINESS",
  }[cabinPreference];
}

function extractOfferCabin(offer) {
  // Amadeus reports the booked cabin per traveler/segment, not on the itinerary
  // segment object. Use the first fare detail as the representative cabin.
  return offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin;
}

function mapAmadeusCabinToUi(travelClass) {
  return {
    ECONOMY: "economy",
    PREMIUM_ECONOMY: "premium-economy",
    BUSINESS: "business",
  }[travelClass] ?? "economy";
}

function parseIsoDurationToMinutes(duration) {
  if (!duration) {
    return 0;
  }

  const match = /P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/.exec(duration);
  if (!match) {
    return 0;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  return hours * 60 + minutes;
}

function dedupeSegments(segments) {
  const seen = new Set();
  return segments.filter((segment) => {
    const key = segmentSignature(segment);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT_DIR, normalizedPath);

  if (!filePath.startsWith(ROOT_DIR) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = extname(filePath);
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}
