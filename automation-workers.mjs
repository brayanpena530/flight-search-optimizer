import { readFile } from "node:fs/promises";
import { querySeatsAeroCachedAwards } from "./award-providers/seats-aero.mjs";
import {
  AIRLINE_PROGRAMS,
  SEATS_AERO_SOURCE_TO_PROGRAM,
  expandAirports,
  formatAirlineProgramName,
  getSeatsAeroSource,
} from "./search-config.mjs";

export const AUTOMATION_WORKERS = Object.fromEntries(
  AIRLINE_PROGRAMS.map((program) => [program.id, createImportCapableWorker(`${program.name} Award Worker`, program.id)])
);

export function resolveAutomationPrograms(searchState) {
  return searchState.awardPrograms ?? [];
}

export async function runAutomationWorkers({ segments, searchState, matchesFallbackWindow }) {
  const programs = resolveAutomationPrograms(searchState);
  const attemptedWorkers = [];
  const workerSegments = [];

  for (const program of programs) {
    const worker = AUTOMATION_WORKERS[program];
    if (!worker) {
      attemptedWorkers.push({
        program,
        workerName: "Unknown worker",
        outcome: "No worker registered.",
      });
      continue;
    }

    try {
      const result = await worker.collect({ segments, searchState, matchesFallbackWindow });
      attemptedWorkers.push({
        program,
        workerName: worker.name,
        outcome: `loaded ${result.segments.length} segment candidates`,
        mode: result.mode ?? "unknown",
      });
      workerSegments.push(...result.segments);
    } catch (error) {
      attemptedWorkers.push({
        program,
        workerName: worker.name,
        outcome: `failed: ${error.message}`,
        mode: "error",
      });
    }
  }

  return {
    attemptedWorkers,
    segments: dedupeWorkerSegments(workerSegments),
  };
}

function createSampleWorker(name, program) {
  return {
    name,
    async collect({ segments, searchState, matchesFallbackWindow }) {
      const filteredSegments = segments
        .filter((segment) => Array.isArray(segment.awardOptions) && segment.awardOptions.length > 0)
        .filter((segment) => matchesFallbackWindow(segment, searchState))
        .map((segment) => ({
          ...segment,
          awardOptions: segment.awardOptions.filter((award) => award.program === program),
        }))
        .filter((segment) => segment.awardOptions.length > 0)
        .map((segment) => ({
          ...segment,
          fallbackMode: "sample-award-automation",
          automationProgram: program,
          automationWorkerName: name,
        }));

      return {
        mode: "sample-award-automation",
        segments: filteredSegments,
      };
    },
  };
}

function createImportCapableWorker(name, program) {
  const sampleWorker = createSampleWorker(name, program);

  return {
    name,
    async collect({ segments, searchState, matchesFallbackWindow }) {
      const inlineImport = getInlineAwardImport(searchState, program);
      if (inlineImport) {
        const importedSegments = loadImportedAwardRecords({
          recordsPayload: inlineImport,
          program,
          workerName: this.name,
          searchState,
          matchesFallbackWindow,
        });

        return {
          mode: `inline-${program}-awards`,
          segments: importedSegments,
        };
      }

      const seatsAeroSource = getSeatsAeroSource(program);
      if (process.env.SEATS_AERO_API_KEY && seatsAeroSource) {
        const seatsAeroResult = await querySeatsAeroCachedAwards({
          apiKey: process.env.SEATS_AERO_API_KEY,
          baseUrl: process.env.SEATS_AERO_BASE_URL,
          originAirports: expandAirports(searchState.origin, searchState.useNearbyAirports),
          destinationAirports: expandAirports(searchState.destination, searchState.useNearbyAirports),
          outboundWindow: {
            startDate: searchState.earliestDeparture,
            endDate: searchState.latestDeparture,
          },
          returnWindow: {
            startDate: searchState.earliestReturn,
            endDate: searchState.latestReturn,
          },
          sources: [seatsAeroSource],
          cabin: searchState.cabinPreference,
          onlyDirectFlights: searchState.maxStops === 0,
          take: Number(process.env.SEATS_AERO_TAKE ?? 25),
          maxAvailability: Number(process.env.SEATS_AERO_MAX_AVAILABILITY ?? 4),
          requestBudget: Number(process.env.SEATS_AERO_REQUEST_BUDGET ?? 10),
          sourceProgramMap: SEATS_AERO_SOURCE_TO_PROGRAM,
          workerName: this.name,
        });

        if (seatsAeroResult.segments.length > 0) {
          return {
            mode: `seats-aero-${program}-cached`,
            segments: seatsAeroResult.segments,
            provider: seatsAeroResult.provider,
            requestCount: seatsAeroResult.requestCount,
            searches: seatsAeroResult.searches,
            capabilities: seatsAeroResult.capabilities,
          };
        }
      }

      const importPath = getAwardImportPath(program);
      if (importPath) {
        const importedSegments = await loadImportedAwardSegments({
          filePath: importPath,
          program,
          workerName: this.name,
          searchState,
          matchesFallbackWindow,
        });

        return {
          mode: `imported-${program}-awards`,
          segments: importedSegments,
        };
      }

      return {
        mode: "unavailable",
        segments: [],
      };
    },
  };
}

function getInlineAwardImport(searchState, program) {
  return searchState.awardImports?.[program] ?? null;
}

function getAwardImportPath(program) {
  const envKey = `${program.toUpperCase()}_AWARD_IMPORT_PATH`;
  return process.env[envKey];
}

async function loadImportedAwardSegments({ filePath, program, workerName, searchState, matchesFallbackWindow }) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return loadImportedAwardRecords({
    recordsPayload: parsed,
    program,
    workerName,
    searchState,
    matchesFallbackWindow,
  });
}

function loadImportedAwardRecords({ recordsPayload, program, workerName, searchState, matchesFallbackWindow }) {
  const records = Array.isArray(recordsPayload) ? recordsPayload : recordsPayload?.segments;

  if (!Array.isArray(records)) {
    throw new Error(`${formatAirlineProgramName(program)} award import must be a JSON array or an object with a segments array.`);
  }

  return records
    .map((record) => normalizeImportedAwardSegment(record, program, workerName))
    .filter((segment) => matchesFallbackWindow(segment, searchState));
}

function normalizeImportedAwardSegment(record, program, workerName) {
  const cashPrice = normalizePositiveNumber(
    record.cashPrice ?? record.referenceCashPrice,
    "cashPrice or referenceCashPrice"
  );
  const awardOptions = Array.isArray(record.awardOptions)
    ? record.awardOptions
    : [
        {
          program,
          miles: record.miles,
          taxes: record.taxes,
        },
      ];
  const normalizedAwardOptions = awardOptions
    .filter((award) => award.program === program || award.program === undefined)
    .map((award) => ({
      program,
      miles: normalizePositiveNumber(award.miles, "award miles"),
      taxes: normalizeNonNegativeNumber(award.taxes ?? 5.6, "award taxes"),
    }));

  if (normalizedAwardOptions.length === 0) {
    throw new Error(`${formatAirlineProgramName(program)} award import segment has no award options for ${program}.`);
  }

  return {
    origin: normalizeRequiredString(record.origin, "origin"),
    destination: normalizeRequiredString(record.destination, "destination"),
    airline: record.airline ?? formatAirlineProgramName(program),
    cabin: record.cabin ?? "economy",
    departure: normalizeRequiredString(record.departure, "departure"),
    arrival: normalizeRequiredString(record.arrival, "arrival"),
    stops: normalizeNonNegativeNumber(record.stops ?? 0, "stops"),
    durationMinutes: normalizePositiveNumber(record.durationMinutes, "durationMinutes"),
    cashPrice,
    cashAvailable: false,
    awardOptions: normalizedAwardOptions,
    fallbackMode: `imported-${program}-awards`,
    automationProgram: program,
    automationWorkerName: workerName,
  };
}

function normalizeRequiredString(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Award import segment is missing ${fieldName}.`);
  }

  return normalized;
}

function normalizePositiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Award import segment requires a positive ${fieldName}.`);
  }

  return number;
}

function normalizeNonNegativeNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Award import segment requires a non-negative ${fieldName}.`);
  }

  return number;
}

function dedupeWorkerSegments(segments) {
  const mergedByKey = new Map();

  for (const segment of segments) {
    const key = [
      segment.origin,
      segment.destination,
      segment.departure,
      segment.arrival,
      segment.airline,
      segment.automationProgram,
    ].join("|");

    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, segment);
    }
  }

  return [...mergedByKey.values()];
}
