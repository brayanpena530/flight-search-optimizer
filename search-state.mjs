import { AWARD_PROGRAM_IDS, TRANSFER_PARTNERS, formatAirlineProgramName } from "./search-config.mjs";

const ALLOWED_AWARD_PROGRAMS = new Set(AWARD_PROGRAM_IDS);
const ALLOWED_TIME_PREFERENCES = new Set(["any", "morning", "afternoon", "evening"]);
const ALLOWED_TIME_MODES = new Set(["soft", "hard"]);
const ALLOWED_CABINS = new Set(["any", "economy", "premium-economy", "business"]);
const ALLOWED_STRATEGIES = new Set(["official-first", "official-then-automation", "sample-only"]);
const ALLOWED_AWARD_MODES = new Set(["cash-and-awards", "cash-only"]);
const ALLOWED_RANKING_FOCUS = new Set(["cash-first", "effective-cost", "fastest"]);
const ALLOWED_TRIP_TYPES = new Set(["round-trip", "one-way"]);

export function normalizeAndValidateSearchState(input) {
  const searchState = normalizeSearchState(input);
  return {
    searchState,
    errors: validateSearchState(searchState),
  };
}

export function normalizeSearchState(input = {}) {
  const balances = input.balances ?? {};
  const thresholds = input.thresholds ?? {};
  const valuations = input.valuations ?? {};
  const redemptionRates = input.redemptionRates ?? {};
  const transferRatios = input.transferRatios ?? {};
  const passengers = input.passengers ?? {};

  return {
    tripType: normalizeTripType(input.tripType ?? input.type),
    origin: normalizeAirportCode(input.origin),
    destination: normalizeAirportCode(input.destination),
    useNearbyAirports: Boolean(input.useNearbyAirports),
    nearbyAirportMaxGroundTravelMinutes: normalizeNumber(input.nearbyAirportMaxGroundTravelMinutes, 90),
    nearbyAirportGroundCostPerHour: normalizeNumber(input.nearbyAirportGroundCostPerHour, 20),
    earliestDeparture: normalizeDate(input.earliestDeparture),
    latestDeparture: normalizeDate(input.latestDeparture),
    earliestReturn: normalizeDate(input.earliestReturn),
    latestReturn: normalizeDate(input.latestReturn),
    passengers: {
      adults: normalizeInteger(passengers.adults ?? input.adultTravelers, 1),
    },
    carryOnBagsPerTraveler: normalizeInteger(input.carryOnBagsPerTraveler, 1),
    carryOnFallbackFeeDollars: normalizeNumber(input.carryOnFallbackFeeDollars, 60),
    minStayNights: normalizeInteger(input.minStayNights, 1),
    maxStayNights: normalizeInteger(input.maxStayNights, 7),
    departureTimePreference: normalizeChoice(input.departureTimePreference, "any"),
    returnTimePreference: normalizeChoice(input.returnTimePreference, "any"),
    timePreferenceMode: normalizeChoice(input.timePreferenceMode, "soft"),
    timePreferencePenaltyDollars: normalizeNumber(input.timePreferencePenaltyDollars, 18),
    cabinPreference: normalizeChoice(input.cabinPreference, "economy"),
    maxStops: normalizeInteger(input.maxStops, 1),
    rankingFocus: normalizeChoice(input.rankingFocus, "cash-first"),
    dataStrategy: normalizeChoice(input.dataStrategy, "official-first"),
    awardDataMode: normalizeChoice(input.awardDataMode, "cash-and-awards"),
    awardPrograms: normalizeAwardPrograms(input.awardPrograms),
    awardImports: normalizeAwardImports(input.awardImports),
    balances: {
      amex: normalizeNumber(balances.amex, 0),
      chase: normalizeNumber(balances.chase, 0),
      ...normalizeAirlineBalances(balances),
    },
    thresholds: {
      amex: normalizeNumber(thresholds.amex, 1),
      chase: normalizeNumber(thresholds.chase, 1),
      airline: normalizeNumber(thresholds.airline, 1),
    },
    valuations: {
      amex: normalizeNumber(valuations.amex, 1),
      chase: normalizeNumber(valuations.chase, 1),
      airline: normalizeNumber(valuations.airline, 1),
    },
    redemptionRates: {
      amexTravel: normalizeNumber(redemptionRates.amexTravel, 1),
      chaseTravel: normalizeNumber(redemptionRates.chaseTravel, 1.25),
    },
    transferRatios: normalizeTransferRatios(transferRatios),
  };
}

export function validateSearchState(searchState) {
  const errors = [];

  if (!/^[A-Z]{3}$/.test(searchState.origin)) {
    errors.push("Origin must be a 3-letter airport code.");
  }

  if (!/^[A-Z]{3}$/.test(searchState.destination)) {
    errors.push("Destination must be a 3-letter airport code.");
  }

  if (searchState.origin && searchState.destination && searchState.origin === searchState.destination) {
    errors.push("Origin and destination must be different airports.");
  }

  if (!searchState.earliestDeparture || !searchState.latestDeparture) {
    errors.push("Departure window is required.");
  } else if (searchState.earliestDeparture > searchState.latestDeparture) {
    errors.push("Earliest departure cannot be after latest departure.");
  }

  if (!ALLOWED_TRIP_TYPES.has(searchState.tripType)) {
    errors.push("Trip type must be one-way or round-trip.");
  }

  if (searchState.tripType === "round-trip") {
    if (!searchState.earliestReturn || !searchState.latestReturn) {
      errors.push("Return window is required for round-trip searches.");
    } else if (searchState.earliestReturn > searchState.latestReturn) {
      errors.push("Earliest return cannot be after latest return.");
    }

    if (
      searchState.latestReturn &&
      searchState.earliestDeparture &&
      searchState.latestReturn <= searchState.earliestDeparture
    ) {
      errors.push("Return window must allow travel after the departure window starts.");
    }
  }

  if (!Number.isInteger(searchState.minStayNights) || searchState.minStayNights < 1) {
    errors.push("Minimum stay nights must be at least 1.");
  }

  if (!Number.isInteger(searchState.maxStayNights) || searchState.maxStayNights < 1) {
    errors.push("Maximum stay nights must be at least 1.");
  }

  if (searchState.minStayNights > searchState.maxStayNights) {
    errors.push("Minimum stay nights cannot exceed maximum stay nights.");
  }

  if (!Number.isInteger(searchState.maxStops) || searchState.maxStops < 0) {
    errors.push("Maximum stops must be 0 or greater.");
  }

  if (!Number.isInteger(searchState.passengers.adults) || searchState.passengers.adults < 1) {
    errors.push("Adult travelers must be at least 1.");
  }

  if (![0, 1].includes(searchState.carryOnBagsPerTraveler)) {
    errors.push("Carry-on bags per traveler must be 0 or 1.");
  }

  if (searchState.carryOnFallbackFeeDollars < 0) {
    errors.push("Carry-on fallback fee cannot be negative.");
  }

  if (!ALLOWED_TIME_PREFERENCES.has(searchState.departureTimePreference)) {
    errors.push("Departure time preference is invalid.");
  }

  if (!ALLOWED_TIME_PREFERENCES.has(searchState.returnTimePreference)) {
    errors.push("Return time preference is invalid.");
  }

  if (!ALLOWED_TIME_MODES.has(searchState.timePreferenceMode)) {
    errors.push("Time preference mode is invalid.");
  }

  if (!ALLOWED_CABINS.has(searchState.cabinPreference)) {
    errors.push("Cabin preference is invalid.");
  }

  if (searchState.timePreferencePenaltyDollars < 0) {
    errors.push("Soft time preference penalty cannot be negative.");
  }

  if (searchState.nearbyAirportMaxGroundTravelMinutes < 0) {
    errors.push("Nearby-airport maximum ground-travel minutes cannot be negative.");
  }

  if (searchState.nearbyAirportGroundCostPerHour < 0) {
    errors.push("Nearby-airport ground-travel cost per hour cannot be negative.");
  }

  if (!ALLOWED_STRATEGIES.has(searchState.dataStrategy)) {
    errors.push("Data strategy is invalid.");
  }

  if (!ALLOWED_AWARD_MODES.has(searchState.awardDataMode)) {
    errors.push("Award data mode is invalid.");
  }

  if (!ALLOWED_RANKING_FOCUS.has(searchState.rankingFocus)) {
    errors.push("Ranking focus is invalid.");
  }

  if (searchState.awardPrograms.some((program) => !ALLOWED_AWARD_PROGRAMS.has(program))) {
    errors.push("One or more award programs are invalid.");
  }

  for (const [program, payload] of Object.entries(searchState.awardImports)) {
    if (!ALLOWED_AWARD_PROGRAMS.has(program)) {
      errors.push(`Award import program ${program} is invalid.`);
      continue;
    }

    const records = Array.isArray(payload) ? payload : payload?.segments;
    if (!Array.isArray(records)) {
      errors.push(`${formatAirlineProgramName(program)} award import must be an array or an object with a segments array.`);
    }
  }

  for (const [label, amount] of Object.entries(searchState.balances)) {
    if (amount < 0) {
      errors.push(`${capitalize(label)} balance cannot be negative.`);
    }
  }

  for (const [label, amount] of Object.entries(searchState.thresholds)) {
    if (amount < 0) {
      errors.push(`${capitalize(label)} threshold cannot be negative.`);
    }
  }

  for (const [label, amount] of Object.entries(searchState.valuations)) {
    if (amount <= 0) {
      errors.push(`${capitalize(label)} valuation must be greater than 0.`);
    }
  }

  for (const [label, amount] of Object.entries(searchState.redemptionRates)) {
    if (amount < 0) {
      errors.push(`${capitalize(label)} redemption rate cannot be negative.`);
    }
  }

  for (const [currency, ratios] of Object.entries(searchState.transferRatios)) {
    for (const [program, ratio] of Object.entries(ratios)) {
      if (ratio <= 0) {
        errors.push(`${capitalize(currency)} to ${capitalize(program)} transfer ratio must be greater than 0.`);
      }
    }
  }

  return errors;
}

function normalizeAirportCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeDate(value) {
  return String(value ?? "").trim();
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeChoice(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeTripType(value) {
  const normalized = String(value ?? "round-trip").trim().toLowerCase();
  if (["oneway", "one_way", "one-way", "2"].includes(normalized)) return "one-way";
  return "round-trip";
}

function normalizeAwardPrograms(value) {
  if (value === undefined) {
    return [...AWARD_PROGRAM_IDS];
  }

  const programs = Array.isArray(value) ? value : [];
  return [...new Set(programs.map((program) => String(program ?? "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeAirlineBalances(balances) {
  return Object.fromEntries(
    AWARD_PROGRAM_IDS.map((program) => [program, normalizeNumber(balances[program], 0)])
  );
}

function normalizeTransferRatios(transferRatios) {
  return Object.fromEntries(
    Object.entries(TRANSFER_PARTNERS).map(([currency, partners]) => [
      currency,
      Object.fromEntries(
        partners.map((program) => [program, normalizeNumber(transferRatios[currency]?.[program], 1)])
      ),
    ])
  );
}

function normalizeAwardImports(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([program, payload]) => [String(program ?? "").trim().toLowerCase(), payload])
      .filter(([program]) => program)
  );
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
