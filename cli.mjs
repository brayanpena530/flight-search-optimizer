#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderHealth, resolveSearch } from "./server.mjs";
import { normalizeAndValidateSearchState } from "./search-state.mjs";

const VERSION = "1.1";

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    writeJson({ ok: false, error: error.message, code: "CLI_ERROR" });
    process.exitCode = 1;
  });
}

export async function runCli(args, io = defaultIo()) {
  const command = args[0] ?? "help";
  const flags = parseFlags(args.slice(1));

  if (command === "help" || flags.help) {
    io.write(helpText());
    return 0;
  }

  if (command === "health") {
    io.write(JSON.stringify(await buildProviderHealth(), null, flags.pretty ? 2 : 0));
    io.write("\n");
    return 0;
  }

  let input;
  try {
    input = await readSearchInput(flags, io);
  } catch (error) {
    writeJson({ ok: false, error: error.message, code: "INPUT_ERROR" }, io);
    return 2;
  }

  const { searchState, errors } = normalizeAndValidateSearchState(input);
  if (command === "validate") {
    writeJson({ ok: errors.length === 0, searchState, errors }, io, flags.pretty);
    return errors.length === 0 ? 0 : 2;
  }

  if (command !== "search") {
    writeJson({ ok: false, error: `Unknown command: ${command}`, code: "UNKNOWN_COMMAND" }, io);
    return 2;
  }

  if (errors.length > 0) {
    writeJson({ ok: false, error: "Search input is invalid.", code: "VALIDATION_ERROR", errors }, io, flags.pretty);
    return 2;
  }

  const result = await resolveSearch(searchState);
  const output = flags.full
    ? buildFullResult(result, searchState, flags.limit)
    : buildCompactResult(result, searchState, flags.limit);
  writeJson(output, io, flags.pretty);
  return result.itineraries.length > 0 ? 0 : 1;
}

function buildCompactResult(result, searchState, requestedLimit) {
  const limit = clampInteger(requestedLimit, 5, 1, 10);
  return {
    schemaVersion: VERSION,
    outputMode: "compact",
    ok: result.ok,
    providerId: result.providerId,
    query: {
      origin: searchState.origin,
      destination: searchState.destination,
      tripType: searchState.tripType,
      departure: [searchState.earliestDeparture, searchState.latestDeparture],
      return: searchState.tripType === "one-way" ? null : [searchState.earliestReturn, searchState.latestReturn],
      passengers: searchState.passengers.adults,
      cabin: searchState.cabinPreference,
      carryOnBagsPerTraveler: searchState.carryOnBagsPerTraveler,
      rankingFocus: searchState.rankingFocus,
      nearbyAirportMaxGroundTravelMinutes: searchState.nearbyAirportMaxGroundTravelMinutes,
      nearbyAirportGroundCostPerHour: searchState.nearbyAirportGroundCostPerHour,
    },
    sources: result.sources,
    coverage: summarizeCoverage(result),
    outcome: summarizeOutcome(result),
    candidates: result.itineraries.slice(0, limit).map(summarizeItinerary),
    insights: result.insights,
    diagnostics: result.diagnostics,
    diagnosticSummary: result.diagnosticSummary,
    recommendations: result.recommendations,
    warnings: result.warnings,
    transferPartnerData: result.transferPartnerData ?? null,
    attempts: result.attempts,
    workers: result.workers,
    truncated: result.itineraries.length > limit,
  };
}

function buildFullResult(result, searchState, requestedLimit) {
  const compact = buildCompactResult(result, searchState, requestedLimit);
  const limit = clampInteger(requestedLimit, 5, 1, 10);
  return {
    ...compact,
    outputMode: "full",
    details: Object.fromEntries(
      result.itineraries.slice(0, limit).map((itinerary, index) => [
        `option_${index + 1}`,
        itinerary,
      ])
    ),
  };
}

function summarizeItinerary(itinerary, index) {
  const breakdown = (itinerary.paymentBreakdown ?? []).map(summarizePaymentComponent);
  const caveats = collectCaveats(itinerary);
  const links = collectItineraryLinks(itinerary);
  const programs = [...new Set(breakdown.map((item) => item.program).filter(Boolean))];
  const methods = [...new Set(breakdown.map((item) => item.method).filter(Boolean))];
  return {
    optionId: `option_${index + 1}`,
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
    payment: {
      label: itinerary.label ?? null,
      method: methods.length === 1 ? methods[0] : "mixed",
      program: programs.length === 1 ? programs[0] : "mixed",
      programs,
      cashOutlay: itinerary.cashOutlay ?? null,
      pointsUsed: itinerary.pointsUsed ?? null,
      centsPerPoint: itinerary.centsPerPoint ?? null,
      breakdown,
    },
    effectiveCost: itinerary.effectiveCost ?? null,
    durationMinutes: itinerary.totalDurationMinutes ?? itinerary.durationMinutes ?? null,
    travelMetrics: itinerary.travelMetrics ?? null,
    airportAccess: itinerary.airportAccess ?? null,
    groundTravelCost: itinerary.valueBreakdown?.groundTravelCost ?? 0,
    riskFlags: itinerary.riskFlags ?? [],
    carryOn: summarizeCarryOn(itinerary.carryOn),
    qualityPenalty: itinerary.qualityPenalty ?? null,
    verification: findVerification(itinerary),
    explanation: itinerary.explanation ?? null,
    caveats,
    caveatBadges: buildCaveatBadges(caveats),
    searchLinks: links.searchLinks,
    bookingLinks: links.bookingLinks,
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

function summarizeCarryOn(carryOn) {
  if (!carryOn) return null;
  return {
    status: carryOn.status,
    requestedPerTraveler: carryOn.requestedPerTraveler,
    estimatedTotalCost: carryOn.estimatedTotalCost,
    priceIncludesRequestedCarryOn: carryOn.priceIncludesRequestedCarryOn,
    legs: (carryOn.legs ?? []).map(({ direction, allowance }) => ({
      direction,
      status: allowance.status,
      fareFamily: allowance.fareFamily,
      airline: allowance.airline,
      confidence: allowance.confidence,
      source: allowance.source,
      priceIncludesRequestedCarryOn: allowance.priceIncludesRequestedCarryOn,
      rulesVersion: allowance.rulesVersion,
    })),
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


function summarizePaymentComponent(payment) {
  return {
    direction: payment.direction ?? null,
    label: payment.label ?? null,
    method: payment.redemptionType
      ?? (payment.program === "cash" ? "cash" : payment.sourceCurrency ? "points-transfer" : "airline-miles"),
    program: payment.program ?? null,
    sourceCurrency: payment.sourceCurrency ?? null,
    cashOutlay: payment.cashOutlay ?? null,
    pointsUsed: payment.pointsUsed ?? payment.awardMiles ?? null,
    awardMiles: payment.awardMiles ?? null,
  };
}

function summarizeOutcome(result) {
  const candidateCount = result.itineraries.length;
  if (candidateCount > 0) {
    return {
      status: "candidates-found",
      candidateCount,
      message: `${candidateCount} ranked candidate${candidateCount === 1 ? "" : "s"} found.`,
      reasonCodes: [],
    };
  }

  const diagnostics = result.diagnostics ?? {};
  const reasonCodes = [];
  if ((diagnostics.totalSegments ?? 0) === 0) reasonCodes.push("NO_SEGMENT_INVENTORY");
  if ((diagnostics.outboundCandidates ?? 0) === 0) reasonCodes.push("NO_OUTBOUND_CANDIDATES");
  if ((diagnostics.returnCandidates ?? 0) === 0) reasonCodes.push("NO_RETURN_CANDIDATES");
  if ((diagnostics.rejectedChronology ?? 0) > 0) reasonCodes.push("CHRONOLOGY_REJECTED");
  if ((diagnostics.rejectedStayLength ?? 0) > 0) reasonCodes.push("STAY_LENGTH_REJECTED");
  if ((diagnostics.rejectedPaymentRules ?? 0) > 0) reasonCodes.push("PAYMENT_RULES_REJECTED");
  if ((diagnostics.rejectedPairBalance ?? 0) > 0) reasonCodes.push("PAIR_BALANCE_REJECTED");

  return {
    status: "no-candidates",
    candidateCount: 0,
    message: result.recommendations?.[0] ?? "No complete itineraries matched the search constraints.",
    reasonCodes,
  };
}

function summarizeCoverage(result) {
  return {
    sourceCount: result.sources.length,
    segmentCount: result.segments.length,
    candidateCount: result.itineraries.length,
    retrievedAt: result.segments
      .flatMap((segment) => [segment.providerEvidence?.retrievedAt, segment.providerEvidence?.RetrievedAt])
      .filter(Boolean)
      .sort()
      .at(-1) ?? null,
    cachedAwards: result.segments.some((segment) => segment.verification === "discovered_cached"),
  };
}

function findVerification(itinerary) {
  return [itinerary.outbound, itinerary.inbound]
    .flatMap((segment) => [segment?.verification, ...(segment?.flightSegments ?? []).map((item) => item.verification)])
    .find(Boolean) ?? null;
}

function collectCaveats(itinerary) {
  return [...new Set([...(itinerary.caveats ?? []), ...(itinerary.warnings ?? [])]
    .filter((value) => typeof value === "string" && value.length > 0))];
}

async function readSearchInput(flags, io) {
  let input = {};
  if (flags.input) {
    input = JSON.parse(await readFile(resolve(flags.input), "utf8"));
  } else if (flags.stdin || !hasSearchFlags(flags)) {
    const stdin = await readStdin(io);
    if (stdin.trim()) input = JSON.parse(stdin);
  }

  return {
    ...input,
    origin: flags.origin ?? input.origin,
    destination: flags.destination ?? input.destination,
    earliestDeparture: flags.depart ?? input.earliestDeparture,
    latestDeparture: flags.departBy ?? flags.latestDeparture ?? flags.depart ?? input.latestDeparture,
    earliestReturn: flags.return ?? input.earliestReturn,
    latestReturn: flags.returnBy ?? flags.latestReturn ?? flags.return ?? input.latestReturn,
    tripType: flags.oneWay ? "one-way" : (flags.tripType ?? input.tripType),
    useNearbyAirports: flags.nearby === undefined ? input.useNearbyAirports : flags.nearby,
    nearbyAirportMaxGroundTravelMinutes: flags.nearbyAirportMaxGroundTravelMinutes
      ?? input.nearbyAirportMaxGroundTravelMinutes,
    nearbyAirportGroundCostPerHour: flags.nearbyAirportGroundCostPerHour
      ?? input.nearbyAirportGroundCostPerHour,
    dataStrategy: flags.strategy ?? input.dataStrategy,
    rankingFocus: flags.focus ?? input.rankingFocus,
    awardDataMode: flags.awards ?? input.awardDataMode,
  };
}

async function readStdin(io) {
  if (io.stdinText !== undefined) return io.stdinText;
  return new Promise((resolveInput) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolveInput(value));
  });
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? (
      args[index + 1] === undefined || args[index + 1].startsWith("--")
        ? true
        : args[++index]
    );
    flags[toCamelCase(key)] = value;
  }
  for (const key of ["nearby", "oneWay", "full", "pretty", "stdin", "help"]) {
    if (flags[key] !== undefined) flags[key] = flags[key] === true || flags[key] === "true";
  }
  return flags;
}

function hasSearchFlags(flags) {
  return ["input", "origin", "destination", "depart", "return", "oneWay", "tripType", "stdin", "nearbyAirportMaxGroundTravelMinutes", "nearbyAirportGroundCostPerHour"].some((key) => flags[key] !== undefined);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function writeJson(value, io = defaultIo(), pretty = false) {
  io.write(JSON.stringify(value, null, pretty ? 2 : 0));
  io.write("\n");
}

function defaultIo() {
  return { write: (value) => process.stdout.write(value) };
}

function helpText() {
  return `Flight Search Optimizer CLI\n\nCommands:\n  search    Run a bounded search (JSON decision packet by default)\n  validate  Normalize and validate a search request\n  health    Report configured provider capabilities\n\nSearch input:\n  node cli.mjs search --input query.json\n  Get-Content query.json | node cli.mjs search --stdin\n  node cli.mjs search --origin IAH --destination JFK --depart 2026-10-01 --return 2026-10-08\n  node cli.mjs search --origin IAH --destination JFK --one-way --depart 2026-10-01\n  node cli.mjs search --origin IAH --destination NYC --depart 2026-10-01 --depart-by 2026-10-03 --return 2026-10-08 --return-by 2026-10-10\n\nOptions:\n  --depart-by DATE  Last acceptable departure date\n  --return-by DATE  Last acceptable return date\n  --one-way          Search one-way flights without a return window\n  --full            Include full provider segments and evidence\n  --pretty          Indent JSON output\n  --limit N         Return 1-10 candidates (default 5)\n  --strategy sample-only | official-first\n`;
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
