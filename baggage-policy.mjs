export const CARRY_ON_RULES_VERSION = "2026-09-17";

const DEFAULT_FEE_ESTIMATE = 60;

// Keep this intentionally small and auditable. Provider-reported baggage text
// always wins; these rules are only a fallback for the airlines the optimizer
// currently supports as award programs.
const AIRLINE_RULES = Object.freeze({
  american: rule("American Airlines", ["american", "american airlines", "aa"], {
    default: included("American includes one carry-on and one personal item on Basic Economy and higher fares.", "https://www.aa.com/web/i18n/travel-info/experience/seats/basic-economy.html"),
  }),
  delta: rule("Delta Air Lines", ["delta", "delta air lines", "dl"], {
    default: included("Delta Main Basic and higher fares include one carry-on bag.", "https://www.delta.com/us/en/onboard/onboard-experience/basic-economy"),
  }),
  jetblue: rule("JetBlue", ["jetblue", "jetblue airways", "b6"], {
    default: included("JetBlue includes one carry-on and one personal item on all fares.", "https://www.jetblue.com/help/carry-on-bags"),
  }),
  alaska: rule("Alaska Airlines", ["alaska", "alaska airlines", "as"], {
    default: included("Alaska Saver and higher fares include one carry-on and one personal item.", "https://www.alaskaair.com/content/travel-info/flight-experience/saver"),
  }),
  southwest: rule("Southwest Airlines", ["southwest", "southwest airlines", "wn"], {
    default: included("Southwest includes one carry-on and one personal item for ticketed passengers.", "https://support.southwest.com/helpcenter/article/carryon-baggage-policy"),
  }),
  united: rule("United Airlines", ["united", "united airlines", "ua"], {
    basic: unknown("United Basic Economy carry-on eligibility varies by route and traveler benefits; verify the exact offer.", "https://www.united.com/en/us/fly/travel/inflight/basic-economy.html"),
    economy: included("United standard Economy includes one carry-on; Basic Economy is evaluated separately.", "https://www.united.com/en/us/fly/travel/inflight/basic-economy.html"),
    award: included("United award tickets normally include one carry-on; verify partner-operated and Basic Economy exceptions.", "https://www.united.com/en/us/fly/travel/inflight/basic-economy.html"),
    default: unknown("A bare United Economy cabin label does not distinguish Basic Economy from standard Economy.", "https://www.united.com/en/us/fly/travel/inflight/basic-economy.html"),
  }),
  frontier: rule("Frontier Airlines", ["frontier", "frontier airlines", "f9"], {
    basic: feeRequired("Frontier Basic includes a personal item, but a carry-on costs extra.", "https://www.flyfrontier.com/travel/travel-info/bag-options/"),
    economy: included("Frontier Economy, Premium, and Business bundles include one carry-on.", "https://www.flyfrontier.com/ways-to-save/bundles"),
    premium: included("Frontier Economy, Premium, and Business bundles include one carry-on.", "https://www.flyfrontier.com/ways-to-save/bundles"),
    business: included("Frontier Economy, Premium, and Business bundles include one carry-on.", "https://www.flyfrontier.com/ways-to-save/bundles"),
    award: unknown("Frontier award baggage depends on whether a bundle or bag is added during redemption.", "https://www.flyfrontier.com/ways-to-save/bundles"),
    default: unknown("Frontier carry-on inclusion depends on the selected fare or bundle.", "https://www.flyfrontier.com/travel/travel-info/bag-options/"),
  }),
});

export function resolveCarryOnAllowance(segment, {
  bookingType = "cash",
  requestedPerTraveler = 1,
  fallbackFeeDollars = DEFAULT_FEE_ESTIMATE,
} = {}) {
  const requested = normalizeRequestedBags(requestedPerTraveler);
  const airlineRule = findAirlineRule(segment);
  const fareFamily = detectFareFamily(segment, bookingType);
  const exact = parseProviderBaggage(segment);
  const searchPriced = bookingType === "cash" && hasCarryOnSearchConstraint(segment);

  if (requested === 0) {
    return {
      requestedPerTraveler: 0,
      status: "not-requested",
      quantityPerTraveler: 0,
      fareFamily,
      airline: airlineRule?.name ?? segment?.airline ?? "Unknown",
      source: "traveler-request",
      confidence: "confirmed",
      priceIncludesRequestedCarryOn: true,
      estimatedFeePerTravelerPerLeg: 0,
      rulesVersion: CARRY_ON_RULES_VERSION,
      note: "No carry-on bag was requested.",
      sourceUrl: null,
    };
  }

  if (exact) {
    return {
      requestedPerTraveler: requested,
      ...exact,
      fareFamily,
      airline: airlineRule?.name ?? segment?.airline ?? "Unknown",
      source: "provider-reported",
      confidence: "confirmed",
      priceIncludesRequestedCarryOn: searchPriced || exact.status === "included",
      estimatedFeePerTravelerPerLeg: exact.status === "fee-required" && !searchPriced ? fallbackFeeDollars : 0,
      rulesVersion: CARRY_ON_RULES_VERSION,
      sourceUrl: null,
    };
  }

  const fallback = airlineRule?.fares?.[fareFamily] ?? airlineRule?.fares?.default;
  if (fallback) {
    return {
      requestedPerTraveler: requested,
      status: fallback.status,
      quantityPerTraveler: fallback.status === "included" ? 1 : 0,
      fareFamily,
      airline: airlineRule.name,
      source: "airline-rule",
      confidence: fallback.status === "unknown" ? "uncertain" : "inferred",
      priceIncludesRequestedCarryOn: searchPriced || fallback.status === "included",
      estimatedFeePerTravelerPerLeg:
        fallback.status === "fee-required" && !searchPriced ? fallbackFeeDollars : 0,
      rulesVersion: CARRY_ON_RULES_VERSION,
      note: fallback.note,
      sourceUrl: fallback.sourceUrl,
    };
  }

  return {
    requestedPerTraveler: requested,
    status: "unknown",
    quantityPerTraveler: null,
    fareFamily,
    airline: segment?.airline ?? "Unknown",
    source: searchPriced ? "search-constraint" : "unavailable",
    confidence: "uncertain",
    priceIncludesRequestedCarryOn: searchPriced,
    estimatedFeePerTravelerPerLeg: 0,
    rulesVersion: CARRY_ON_RULES_VERSION,
    note: searchPriced
      ? "The cash search requested carry-on pricing, but the fare allowance was not reported."
      : "Carry-on inclusion could not be determined from provider data or the airline rules table.",
    sourceUrl: null,
  };
}

export function carryOnCostForSegment(allowance, passengerCount) {
  if (!allowance || allowance.requestedPerTraveler <= 0 || allowance.priceIncludesRequestedCarryOn) return 0;
  const fee = Number(allowance.estimatedFeePerTravelerPerLeg);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  return roundCurrency(fee * Math.max(1, Number(passengerCount) || 1) * allowance.requestedPerTraveler);
}

export function carryOnCaveats(allowance) {
  if (!allowance || allowance.status === "not-requested") return [];
  if (allowance.status === "fee-required" && allowance.estimatedFeePerTravelerPerLeg > 0) {
    return [`Carry-on is not included; ranking adds an estimated $${allowance.estimatedFeePerTravelerPerLeg} per traveler for this leg.`];
  }
  return [];
}

function parseProviderBaggage(segment) {
  const texts = collectBaggageText(segment);
  for (const text of texts) {
    const normalized = text.toLowerCase();
    if (/\b(?:no|zero|0)\s+(?:free\s+)?carry[ -]?on\b|carry[ -]?on[^.]{0,35}(?:not included|additional charge|for a fee|costs? extra)/i.test(normalized)) {
      return { status: "fee-required", quantityPerTraveler: 0, note: text };
    }
    const match = normalized.match(/\b(\d+)\s+(?:free\s+|complimentary\s+)?carry[ -]?on\b/i);
    if (match && Number(match[1]) > 0) {
      return { status: "included", quantityPerTraveler: Number(match[1]), note: text };
    }
    if (/\b(?:free|complimentary|included)\s+carry[ -]?on\b|carry[ -]?on[^.]{0,25}\bincluded\b/i.test(normalized)) {
      return { status: "included", quantityPerTraveler: 1, note: text };
    }
  }
  return null;
}

function collectBaggageText(segment) {
  const values = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") Object.values(value).forEach(add);
  };
  add(segment?.baggage);
  for (const flight of segment?.flightSegments ?? []) {
    add(flight.baggage);
    add(flight.extensions);
  }
  for (const evidence of segment?.providerEvidence ?? []) {
    add(evidence.baggage);
    for (const option of evidence.bookingOptions ?? []) {
      add(option.baggage);
      add(option.extensions);
    }
  }
  return [...new Set(values)];
}

function detectFareFamily(segment, bookingType) {
  if (bookingType === "award") return "award";
  const fareText = [
    segment?.fareFamily,
    ...(segment?.flightSegments ?? []).flatMap((flight) => [flight.fareClass, ...(flight.extensions ?? [])]),
    ...(segment?.providerEvidence ?? []).flatMap((evidence) =>
      (evidence.bookingOptions ?? []).flatMap((option) => [option.optionTitle, ...(option.extensions ?? [])])
    ),
  ].filter(Boolean).join(" ").toLowerCase();
  const cabin = String(segment?.cabin ?? "").toLowerCase();

  if (/blue basic|main basic|basic economy|basic fare|\bbasic\b|\bsaver\b/.test(fareText)) return "basic";
  if (/business|first|polaris|mint/.test(fareText) || /business|first/.test(cabin)) return "business";
  if (/premium economy|premium-economy|premium bundle|premium class/.test(fareText) || cabin.includes("premium")) return "premium";
  if (/economy bundle|main cabin|standard economy/.test(fareText)) return "economy";
  return "unknown";
}

function hasCarryOnSearchConstraint(segment) {
  return (segment?.providerEvidence ?? []).some((evidence) => Number(evidence.requestedCarryOnBags) > 0);
}

function findAirlineRule(segment) {
  const candidates = [
    segment?.airline,
    ...(segment?.flightSegments ?? []).flatMap((flight) => [flight.marketingCarrier, flight.operatingCarrier]),
  ].filter(Boolean).map(normalizeAirline);
  return Object.values(AIRLINE_RULES).find((item) => item.aliases.some((alias) => candidates.includes(alias))) ?? null;
}

function rule(name, aliases, fares) {
  return { name, aliases: aliases.map(normalizeAirline), fares };
}

function included(note, sourceUrl) {
  return { status: "included", note, sourceUrl };
}

function feeRequired(note, sourceUrl) {
  return { status: "fee-required", note, sourceUrl };
}

function unknown(note, sourceUrl) {
  return { status: "unknown", note, sourceUrl };
}

function normalizeAirline(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeRequestedBags(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 1;
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
