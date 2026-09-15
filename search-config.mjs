export const AIRLINE_PROGRAMS = [
  { id: "united", name: "United", seatsAeroSource: "united" },
  { id: "delta", name: "Delta", seatsAeroSource: "delta" },
  { id: "jetblue", name: "JetBlue", seatsAeroSource: "jetblue" },
  { id: "frontier", name: "Frontier", seatsAeroSource: "frontier" },
  { id: "southwest", name: "Southwest", seatsAeroSource: null },
  { id: "american", name: "American", seatsAeroSource: "american" },
  { id: "alaska", name: "Alaska", seatsAeroSource: "alaska" },
];

export const AWARD_PROGRAM_IDS = AIRLINE_PROGRAMS.map((program) => program.id);

export function formatAirlineProgramName(programId) {
  return AIRLINE_PROGRAMS.find((program) => program.id === programId)?.name ?? programId;
}

export function getSeatsAeroSource(programId) {
  return AIRLINE_PROGRAMS.find((program) => program.id === programId)?.seatsAeroSource ?? null;
}

export const SEATS_AERO_SOURCE_TO_PROGRAM = Object.fromEntries(
  AIRLINE_PROGRAMS.filter((program) => program.seatsAeroSource).map((program) => [
    program.seatsAeroSource,
    program.id,
  ])
);

export const TRANSFER_PARTNERS = {
  amex: ["delta", "jetblue"],
  chase: ["united", "southwest", "jetblue"],
};

export const PARTNER_MAP = TRANSFER_PARTNERS;

const AIRPORT_METRO_DEFINITIONS = [
  { id: "HOU", city: "Houston", airports: ["IAH", "HOU"], primary: "IAH", groundTravelMinutes: { IAH: 0, HOU: 35 } },
  { id: "NYC", city: "New York City", airports: ["JFK", "LGA", "EWR"], primary: "JFK", groundTravelMinutes: { JFK: 0, LGA: 35, EWR: 45 } },
  { id: "ORD", city: "Chicago", airports: ["ORD", "MDW"], primary: "ORD", groundTravelMinutes: { ORD: 0, MDW: 35 } },
  { id: "LAX", city: "Los Angeles", airports: ["LAX", "BUR", "SNA", "ONT"], primary: "LAX", groundTravelMinutes: { LAX: 0, BUR: 45, SNA: 60, ONT: 75 } },
  { id: "DFW", city: "Dallas-Fort Worth", airports: ["DFW", "DAL"], primary: "DFW", groundTravelMinutes: { DFW: 0, DAL: 35 } },
  { id: "WAS", city: "Washington, DC", airports: ["DCA", "IAD", "BWI"], primary: "DCA", groundTravelMinutes: { DCA: 0, IAD: 45, BWI: 55 } },
  { id: "SFO", city: "San Francisco Bay Area", airports: ["SFO", "OAK", "SJC"], primary: "SFO", groundTravelMinutes: { SFO: 0, OAK: 35, SJC: 65 } },
  { id: "MIA", city: "South Florida", airports: ["MIA", "FLL", "PBI"], primary: "MIA", groundTravelMinutes: { MIA: 0, FLL: 45, PBI: 90 } },
  { id: "BOS", city: "Boston / New England", airports: ["BOS", "PVD", "BDL"], primary: "BOS", groundTravelMinutes: { BOS: 0, PVD: 75, BDL: 105 } },
  { id: "SEA", city: "Seattle", airports: ["SEA", "PAE"], primary: "SEA", groundTravelMinutes: { SEA: 0, PAE: 55 } },
];

export const AIRPORT_METROS = Object.fromEntries(
  AIRPORT_METRO_DEFINITIONS.map((metro) => [metro.id, metro])
);

export const AIRPORT_GROUPS = Object.fromEntries(
  AIRPORT_METRO_DEFINITIONS.flatMap((metro) => metro.airports.map((airport) => [airport, metro.airports]))
    .concat(AIRPORT_METRO_DEFINITIONS.map((metro) => [metro.id, metro.airports]))
);

export function getAirportMetro(input) {
  const code = String(input ?? "").toUpperCase();
  return AIRPORT_METRO_DEFINITIONS.find((metro) => metro.id === code || metro.airports.includes(code)) ?? null;
}

export const TIME_WINDOWS = {
  morning: [5, 11],
  afternoon: [12, 17],
  evening: [18, 23],
};

export function getAirportAccess(input) {
  const code = String(input ?? "").toUpperCase();
  const metro = getAirportMetro(code);
  if (!metro) return { airport: code, metroId: null, city: null, isPrimary: true, groundTravelMinutes: 0 };
  return {
    airport: code,
    metroId: metro.id,
    city: metro.city,
    isPrimary: code === metro.primary,
    groundTravelMinutes: metro.groundTravelMinutes?.[code] ?? 0,
  };
}

export function expandAirports(input, useNearbyAirports, maxGroundTravelMinutes = Infinity) {
  if (!useNearbyAirports) {
    return [input];
  }

  const metro = getAirportMetro(input);
  if (!metro) return [input];
  return metro.airports.filter((airport) =>
    (metro.groundTravelMinutes?.[airport] ?? 0) <= maxGroundTravelMinutes
  );
}
