#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { querySerpApiBookingOptions } from "./cash-providers/serpapi-google-flights.mjs";
import { resolveSearch } from "./server.mjs";
import { normalizeAndValidateSearchState } from "./search-state.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SCHEMA_VERSION = "1.0";
const SEARCH_TTL_MS = 30 * 60 * 1000;
const MAX_SEARCH_BYTES = 6 * 1024;
const MAX_DETAIL_BYTES = 12 * 1024;
const searches = new Map();

export const MCP_TOOLS = [
  tool("start_flight_search", "Start a bounded flight search and return an opaque search ID.", {
    type: "object",
    properties: { query: { type: "object", description: "Structured flight search constraints." } },
    required: ["query"],
  }),
  tool("get_search_results", "Read compact ranked results for a previously started search.", {
    type: "object",
    properties: { searchId: { type: "string" }, responseDetail: { type: "string", enum: ["brief", "standard"] } },
    required: ["searchId"],
  }),
  tool("get_option_details", "Inspect one finalist with segment, payment, caveat, and source evidence.", {
    type: "object",
    properties: { searchId: { type: "string" }, optionId: { type: "string" } },
    required: ["searchId", "optionId"],
  }),
  tool("compare_options", "Compare two to four finalists from one search.", {
    type: "object",
    properties: { searchId: { type: "string" }, optionIds: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } } },
    required: ["searchId", "optionIds"],
  }),
  tool("recheck_option", "Report the strongest available freshness check for a finalist.", {
    type: "object",
    properties: { searchId: { type: "string" }, optionId: { type: "string" } },
    required: ["searchId", "optionId"],
  }),
  tool("get_traveler_profile", "Read the local profile assumptions used by a search.", {
    type: "object",
    properties: { profileId: { type: "string" } },
  }),
];

function tool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

export async function handleMcpRequest(request, dependencies = {}) {
  if (!request || request.jsonrpc !== "2.0") return errorResponse(null, -32600, "Invalid JSON-RPC request.");
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;

  try {
    if (request.method === "initialize") {
      return successResponse(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "flight-search-optimizer", version: SCHEMA_VERSION },
      });
    }
    if (request.method === "ping") return successResponse(request.id, {});
    if (request.method === "tools/list") return successResponse(request.id, { tools: MCP_TOOLS });
    if (request.method === "tools/call") return await handleToolCall(request.id, request.params ?? {}, dependencies);
    return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return errorResponse(request.id, -32000, error.message);
  }
}

async function handleToolCall(id, params, dependencies = {}) {
  const name = params.name;
  const args = params.arguments ?? {};
  let payload;
  switch (name) {
    case "start_flight_search": payload = await startFlightSearch(args, dependencies.resolveSearch ?? resolveSearch); break;
    case "get_search_results": payload = getSearchResults(args); break;
    case "get_option_details": payload = await getOptionDetails(args, dependencies.queryBookingOptions); break;
    case "compare_options": payload = compareOptions(args); break;
    case "recheck_option": payload = await recheckOption(args, dependencies.queryBookingOptions); break;
    case "get_traveler_profile": payload = getTravelerProfile(args); break;
    default: return errorToolResponse(id, `Unknown tool: ${name}`);
  }
  return successResponse(id, { content: [{ type: "text", text: boundedJson(payload, MAX_SEARCH_BYTES) }], structuredContent: payload });
}

async function startFlightSearch({ query }, resolveSearchImpl = resolveSearch) {
  const { searchState, errors } = normalizeAndValidateSearchState(query ?? {});
  if (errors.length > 0) throw new Error(`Invalid search query: ${errors.join(" ")}`);

  const searchId = `srch_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const record = {
    searchId,
    queryHash: hashJson(searchState),
    profileId: query.profileId ?? "default",
    profileVersion: query.profileVersion ?? 1,
    status: "pending",
    createdAt: Date.now(),
    searchState,
    result: null,
    error: null,
    resolveSearch: resolveSearchImpl,
    optionDetails: new Map(),
  };
  searches.set(searchId, record);
  void runStoredSearch(record);
  return { schemaVersion: SCHEMA_VERSION, searchId, status: record.status, queryHash: record.queryHash, profileVersion: record.profileVersion };
}

async function runStoredSearch(record) {
  try {
    record.result = await record.resolveSearch(record.searchState);
    record.status = "complete";
  } catch (error) {
    record.error = error.message;
    record.status = "failed";
  }
}

function getSearchResults({ searchId, responseDetail = "brief" }) {
  const record = getRecord(searchId);
  if (record.status === "pending") return { schemaVersion: SCHEMA_VERSION, searchId, status: "pending" };
  if (record.status === "failed") return { schemaVersion: SCHEMA_VERSION, searchId, status: "failed", error: record.error };
  return boundPayload({
    schemaVersion: SCHEMA_VERSION,
    searchId,
    status: "complete",
    profileVersion: record.profileVersion,
    queryHash: record.queryHash,
    coverage: buildCoverage(record.result),
    assumptions: buildAssumptions(record.searchState),
    diagnostics: record.result.diagnostics,
    recommendations: record.result.recommendations ?? [],
    candidates: record.result.itineraries.slice(0, 5).map((item, index) => summarizeCandidate(item, index)),
    nextActions: ["get_option_details", "recheck_option"],
    truncated: false,
    responseDetail,
  }, MAX_SEARCH_BYTES);
}

async function getOptionDetails({ searchId, optionId }, queryBookingOptions = querySerpApiBookingOptions) {
  const record = getCompleteRecord(searchId);
  const index = parseOptionId(optionId);
  const itinerary = record.result.itineraries[index];
  if (!itinerary) throw new Error(`Unknown option ID: ${optionId}.`);
  const bookingLookups = await loadBookingLookups(record, optionId, itinerary, queryBookingOptions);
  return boundPayload({
    schemaVersion: SCHEMA_VERSION,
    searchId,
    optionId,
    route: summarizeCandidate(itinerary, index),
    segments: [itinerary.outbound, itinerary.inbound].map((segment) => summarizeSegment(segment, bookingLookups.get(segment))),
    payment: (itinerary.paymentBreakdown ?? []).slice(0, 6),
    effectiveCost: itinerary.effectiveCost ?? null,
    caveats: itinerary.caveats ?? [],
    sources: [itinerary.outbound, itinerary.inbound].flatMap((segment) => (segment?.sources ?? []).slice(0, 6)),
    providerCaveats: [...new Set(
      [itinerary.outbound, itinerary.inbound].flatMap((segment) => [
        ...(segment?.providerCaveats ?? []),
        ...(segment?.providerEvidence ?? []).flatMap((evidence) => evidence.caveats ?? []),
      ])
    )].slice(0, 6),
  }, MAX_DETAIL_BYTES);
}

function compareOptions({ searchId, optionIds }) {
  const record = getCompleteRecord(searchId);
  if (!Array.isArray(optionIds) || optionIds.length < 2 || optionIds.length > 4) throw new Error("optionIds must contain 2 to 4 options.");
  const candidates = optionIds.map((optionId) => {
    const index = parseOptionId(optionId);
    const item = record.result.itineraries[index];
    if (!item) throw new Error(`Unknown option ID: ${optionId}.`);
    return { optionId, candidate: summarizeCandidate(item, index) };
  });
  return { schemaVersion: SCHEMA_VERSION, searchId, options: candidates, differences: buildDifferences(candidates.map((item) => item.candidate)) };
}

async function recheckOption({ searchId, optionId }, queryBookingOptions = querySerpApiBookingOptions) {
  const record = getCompleteRecord(searchId);
  const index = parseOptionId(optionId);
  const itinerary = record.result.itineraries[index];
  if (!itinerary) throw new Error(`Unknown option ID: ${optionId}.`);
  const bookingLookups = await loadBookingLookups(record, optionId, itinerary, queryBookingOptions);
  const successfulLookups = [...bookingLookups.values()].filter((lookup) => lookup?.ok);
  if (successfulLookups.length > 0) {
    const verification = successfulLookups.every((lookup) => lookup.verification === "provider_refreshed")
      ? "provider_refreshed"
      : "discovered_cached";
    return {
      schemaVersion: SCHEMA_VERSION,
      searchId,
      optionId,
      status: verification,
      verification,
      cache: successfulLookups.map((lookup) => lookup.cache).filter(Boolean),
      bookingLinks: successfulLookups.flatMap((lookup) => lookup.bookingLinks ?? []).slice(0, 8),
      bookingOptions: successfulLookups.flatMap((lookup) => lookup.bookingOptions ?? []).slice(0, 8),
      caveat: "Verify current price and availability again at the seller before booking.",
    };
  }

  const hasSerpApiEvidence = [itinerary.outbound, itinerary.inbound]
    .some((segment) => (segment?.providerEvidence ?? []).some((evidence) => evidence.provider === "serpapi-google-flights"));
  if (hasSerpApiEvidence) {
    return {
      schemaVersion: SCHEMA_VERSION,
      searchId,
      optionId,
      status: "unavailable",
      verification: "unverifiable",
      reason: "SerpApi booking options could not be refreshed.",
      caveat: "Verify current price and availability directly in Google Flights or with the seller before booking.",
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    searchId,
    optionId,
    status: "unavailable",
    verification: "discovered_cached",
    reason: "No stronger provider recheck is available for this result. Seats.aero cached inventory must be confirmed at booking time.",
    caveat: "Confirm the award is still available at the same mileage price and taxes before transferring points.",
  };
}

function getTravelerProfile({ profileId = "default" }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileId,
    profileVersion: 1,
    configured: false,
    balances: {},
    valuations: {},
    transferRatios: {},
    note: "No persistent traveler profile is configured; provide balances and assumptions in the search query.",
  };
}

function getRecord(searchId) {
  const record = searches.get(searchId);
  if (!record || Date.now() - record.createdAt > SEARCH_TTL_MS) {
    searches.delete(searchId);
    throw new Error(`Unknown or expired search ID: ${searchId}.`);
  }
  return record;
}

function getCompleteRecord(searchId) {
  const record = getRecord(searchId);
  if (record.status === "pending") throw new Error(`Search ${searchId} is still pending.`);
  if (record.status === "failed") throw new Error(record.error ?? `Search ${searchId} failed.`);
  return record;
}

function summarizeCandidate(itinerary, index) {
  const links = collectItineraryLinks(itinerary);
  return {
    optionId: `opt_${index + 1}`,
    labels: itinerary.labels ?? [],
    route: itinerary.inbound
      ? `${itinerary.outbound?.origin ?? "?"}-${itinerary.outbound?.destination ?? "?"} / ${itinerary.inbound?.origin ?? "?"}-${itinerary.inbound?.destination ?? "?"}`
      : `${itinerary.outbound?.origin ?? "?"}-${itinerary.outbound?.destination ?? "?"}`,
    dates: [itinerary.outbound?.departure?.slice(0, 10), itinerary.inbound?.departure?.slice(0, 10)].filter(Boolean),
    bookingType: itinerary.bookingType ?? null,
    bookingLabel: itinerary.bookingLabel ?? itinerary.bookingType ?? null,
    ticketing: itinerary.ticketing ?? null,
    flightDetails: {
      outbound: summarizeFlightLeg(itinerary.outbound),
      return: summarizeFlightLeg(itinerary.inbound),
    },
    cash: { currency: "USD", outlay: itinerary.cashOutlay ?? null },
    points: { program: getSingleProgram(itinerary), amount: itinerary.pointsUsed ?? null },
    effectiveCost: { currency: "USD", amount: itinerary.effectiveCost ?? null },
    durationMinutes: itinerary.totalDurationMinutes ?? itinerary.durationMinutes ?? null,
    travelMetrics: itinerary.travelMetrics ?? null,
    riskFlags: itinerary.riskFlags ?? [],
    searchLinks: links.searchLinks,
    bookingLinks: links.bookingLinks,
    verification: findVerification(itinerary),
    reasonCodes: itinerary.labels ?? [],
    caveats: [...new Set([
      ...(itinerary.caveats ?? []),
      ...(itinerary.outbound?.providerCaveats ?? []),
      ...(itinerary.inbound?.providerCaveats ?? []),
    ])].slice(0, 4),
    caveatBadges: buildCaveatBadges(itinerary.caveats ?? []),
  };
}

function summarizeFlightLeg(segment) {
  if (!segment) return null;
  const flights = (segment.flightSegments ?? []).slice(0, 6).map((flight) => ({
    airline: flight.marketingCarrier ?? flight.airline ?? segment.airline ?? null,
    flightNumber: flight.flightNumber ?? null,
    origin: flight.origin ?? null,
    destination: flight.destination ?? null,
    departure: flight.departure ?? null,
    arrival: flight.arrival ?? null,
    cabin: flight.cabin ?? segment.cabin ?? null,
  }));
  return {
    airline: segment.airline ?? flights[0]?.airline ?? null,
    origin: segment.origin ?? flights[0]?.origin ?? null,
    destination: segment.destination ?? flights.at(-1)?.destination ?? null,
    departure: segment.departure ?? flights[0]?.departure ?? null,
    arrival: segment.arrival ?? flights.at(-1)?.arrival ?? null,
    stops: segment.stops ?? Math.max(flights.length - 1, 0),
    durationMinutes: segment.durationMinutes ?? null,
    flightNumbers: flights.map((flight) => flight.flightNumber).filter(Boolean),
    flights,
  };
}

function collectItineraryLinks(itinerary) {
  const segments = [itinerary.outbound, itinerary.inbound].filter(Boolean);
  const searchLinks = dedupeLinks(segments.flatMap((segment) => (segment.providerEvidence ?? [])
    .filter((evidence) => evidence.searchLink)
    .map((evidence) => ({ label: "View search", url: evidence.searchLink }))));
  const bookingLinks = dedupeLinks([
    ...segments.flatMap((segment) => (segment.providerEvidence ?? []).flatMap((evidence) => evidence.bookingLinks ?? [])),
    ...segments.flatMap((segment) => (segment.awardOptions ?? []).flatMap((award) => award.bookingLinks ?? [])),
  ]);
  return { searchLinks, bookingLinks };
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    if (!link?.url || seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  }).slice(0, 8).map((link) => ({ ...link, requiresRecheck: true }));
}

function buildCaveatBadges(caveats) {
  const badges = [];
  for (const caveat of caveats) {
    if (/Google Flights results may be cached or change/i.test(caveat)) badges.push("Price may change");
    else if (/Seats\.aero award results are cached|Confirm the award is still available/i.test(caveat)) badges.push("Cached award space");
    else if (/transfer points/i.test(caveat)) badges.push("Confirm before transferring");
    else if (/Separate one-way tickets|separate tickets/i.test(caveat)) badges.push("Separate tickets likely");
    else if (/single reservation|reservation/i.test(caveat)) badges.push("Reservation unconfirmed");
    else if (/sample inventory|sample-backed/i.test(caveat)) badges.push("Sample-backed");
    else badges.push("Review caveat");
  }
  return [...new Set(badges)];
}

function summarizeSegment(segment, bookingLookup = null) {
  if (!segment) return null;
  const evidence = (segment.providerEvidence ?? []).slice(0, 4).map((item) => ({
    provider: item.provider ?? null,
    type: item.type ?? null,
    searchLink: item.searchLink ?? null,
    bookingToken: item.bookingToken ?? null,
    cache: bookingLookup?.cache ?? item.cache ?? null,
    retrievedAt: item.retrievedAt ?? null,
    priceInsights: item.priceInsights ?? null,
    baggage: bookingLookup?.baggage ?? item.baggage ?? null,
    bookingOptions: bookingLookup?.bookingOptions ?? item.bookingOptions ?? [],
    bookingLinks: bookingLookup?.bookingLinks ?? item.bookingLinks ?? [],
    caveats: item.caveats ?? [],
  }));
  return {
    origin: segment.origin,
    destination: segment.destination,
    departure: segment.departure,
    arrival: segment.arrival,
    airline: segment.airline,
    cabin: segment.cabin,
    stops: segment.stops,
    durationMinutes: segment.durationMinutes,
    flightSegments: (segment.flightSegments ?? []).slice(0, 6),
    verification: segment.verification ?? null,
    provider: segment.provider ?? null,
    retrievedAt: segment.retrievedAt ?? segment.providerEvidence?.retrievedAt ?? null,
    providerUpdatedAt: segment.providerUpdatedAt ?? null,
    bookingLinks: evidence.flatMap((item) => item.bookingLinks ?? []).slice(0, 8),
    providerCaveats: segment.providerCaveats ?? [],
    providerEvidence: evidence,
  };
}

async function loadBookingLookups(record, optionId, itinerary, queryBookingOptions) {
  const existing = record.optionDetails.get(optionId);
  if (existing) return existing;

  const segments = [itinerary.outbound, itinerary.inbound].filter(Boolean);
  const lookupEntries = await Promise.all(segments.map(async (segment) => {
    const evidence = (segment.providerEvidence ?? []).find(
      (item) => item.provider === "serpapi-google-flights" && item.bookingToken
    );
    if (!evidence) return [segment, null];
    try {
      const lookup = await queryBookingOptions({ bookingToken: evidence.bookingToken });
      return [segment, lookup];
    } catch (error) {
      return [segment, { ok: false, reason: error.message }];
    }
  }));
  const lookups = new Map(lookupEntries);
  record.optionDetails.set(optionId, lookups);
  return lookups;
}

function buildCoverage(result) {
  return {
    sources: result.sources,
    retrievedAt: result.segments.map((segment) => segment.retrievedAt ?? segment.providerEvidence?.retrievedAt).filter(Boolean).sort().at(-1) ?? null,
    verification: [...new Set(result.segments.map((segment) => segment.verification).filter(Boolean))],
  };
}

function buildAssumptions(searchState) {
  return [
    `${searchState.passengers.adults} adult traveler${searchState.passengers.adults === 1 ? "" : "s"}`,
    `${searchState.cabinPreference} cabin`,
    searchState.useNearbyAirports ? "nearby airports enabled" : "exact airports only",
    `ranking focus: ${searchState.rankingFocus}`,
  ];
}

function buildDifferences(candidates) {
  const fields = ["cash.outlay", "points.amount", "effectiveCost.amount", "durationMinutes", "verification"];
  return fields.map((field) => ({ field, values: candidates.map((candidate) => ({ optionId: candidate.optionId, value: readPath(candidate, field) })) }));
}

function readPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object) ?? null;
}

function getSingleProgram(itinerary) {
  const programs = [...new Set((itinerary.paymentBreakdown ?? []).map((item) => item.program).filter((program) => program && program !== "cash"))];
  return programs.length === 1 ? programs[0] : programs.length > 1 ? "mixed" : null;
}

function findVerification(itinerary) {
  return [itinerary.outbound, itinerary.inbound]
    .flatMap((segment) => [segment?.verification, ...(segment?.flightSegments ?? []).map((item) => item.verification)])
    .find(Boolean) ?? "unverifiable";
}

function parseOptionId(optionId) {
  const match = /^opt_(\d+)$/.exec(String(optionId));
  if (!match) throw new Error(`Invalid option ID: ${optionId}.`);
  return Number(match[1]) - 1;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function boundPayload(payload, byteLimit) {
  const text = boundedJson(payload, byteLimit);
  return JSON.parse(text);
}

function boundedJson(value, byteLimit) {
  const prepared = prepareWireValue(value);
  const text = JSON.stringify(prepared);
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return text;
  if (Array.isArray(prepared.candidates)) {
    while (prepared.candidates.length > 0) {
      prepared.candidates.pop();
      prepared.truncated = true;
      const candidateText = JSON.stringify(prepared);
      if (Buffer.byteLength(candidateText, "utf8") <= byteLimit) return candidateText;
    }
  }
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, truncated: true, note: "Response exceeded the configured byte limit; request fewer details." });
}

function prepareWireValue(value) {
  if (typeof value === "string") {
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }
  if (Array.isArray(value)) return value.map(prepareWireValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prepareWireValue(item)]));
  }
  return value;
}

function successResponse(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function errorToolResponse(id, message) { return successResponse(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }) }] }); }

export async function runMcpStdio({ input = process.stdin, output = process.stdout } = {}) {
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try { response = await handleMcpRequest(JSON.parse(line)); }
      catch (error) { response = errorResponse(null, -32700, `Parse error: ${error.message}`); }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMcpStdio().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
