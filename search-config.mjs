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

export const AIRPORT_GROUPS = {
  ORD: ["ORD", "MDW"],
  MDW: ["ORD", "MDW"],
  NYC: ["JFK", "LGA", "EWR"],
  JFK: ["JFK", "LGA", "EWR"],
  LGA: ["JFK", "LGA", "EWR"],
  EWR: ["JFK", "LGA", "EWR"],
  HOU: ["IAH", "HOU"],
  IAH: ["IAH", "HOU"],
  LAX: ["LAX", "BUR", "SNA", "ONT"],
  BUR: ["LAX", "BUR", "SNA", "ONT"],
  SNA: ["LAX", "BUR", "SNA", "ONT"],
  ONT: ["LAX", "BUR", "SNA", "ONT"],
};

export const TIME_WINDOWS = {
  morning: [5, 11],
  afternoon: [12, 17],
  evening: [18, 23],
};

export function expandAirports(input, useNearbyAirports) {
  if (!useNearbyAirports) {
    return [input];
  }

  return AIRPORT_GROUPS[input] ?? [input];
}
