import {
  analyzeSearch,
  buildHighlightedCandidates,
  buildSearchInsights,
  buildSearchRecommendations,
  summarizeDiagnostics,
} from "./search-engine.mjs";

/**
 * Build the provider-neutral application service. Provider resolution is injected
 * so HTTP, CLI, MCP, and future scheduler adapters can share one search pipeline.
 */
export function createOptimizerService({ resolveCashSegments, resolveAwardSegments }) {
  if (typeof resolveCashSegments !== "function" || typeof resolveAwardSegments !== "function") {
    throw new TypeError("Optimizer service requires cash and award resolvers.");
  }

  return {
    resolveSearch: (searchState) => resolveSearch(searchState, { resolveCashSegments, resolveAwardSegments }),
  };
}

export { segmentSignature };

async function resolveSearch(searchState, providers) {
  const cashAttempts = [];
  const awardAttempts = [];
  const [cashResolution, awardResolution] = await Promise.all([
    providers.resolveCashSegments(searchState, cashAttempts),
    searchState.awardDataMode === "cash-and-awards"
      ? providers.resolveAwardSegments(searchState, awardAttempts)
      : { providerName: null, providerType: null, segments: [], workers: [] },
  ]);
  const attempts = [...cashAttempts, ...awardAttempts];

  const workerSummaries = awardResolution.workers ?? [];
  const sources = [];
  sources.push(...(cashResolution.sources ?? (cashResolution.providerName ? [{
    role: "cash",
    name: cashResolution.providerName,
    type: cashResolution.providerType,
  }] : [])).map((source) => ({ ...source, role: "cash" })));
  sources.push(...(awardResolution.sources ?? (awardResolution.providerName ? [{
    role: "awards",
    name: awardResolution.providerName,
    type: awardResolution.providerType,
  }] : [])).map((source) => ({ ...source, role: "awards", programs: searchState.awardPrograms ?? [] })));

  const segments = mergeSegmentsForSearch(cashResolution.segments, awardResolution.segments);
  const analysis = analyzeSearch(searchState, segments);
  const insights = buildSearchInsights(analysis.itineraries, searchState.rankingFocus);
  const warnings = buildProviderWarnings(searchState, cashResolution, awardResolution);

  return {
    ok: true,
    providerId: "search",
    selectedStrategy: searchState.dataStrategy,
    selectedMode: searchState.awardDataMode,
    finalSource: cashResolution.providerName ? { name: cashResolution.providerName } : null,
    sources,
    segments,
    itineraries: analysis.itineraries,
    insights,
    highlightedCandidates: buildHighlightedCandidates(analysis.itineraries, insights),
    diagnostics: analysis.diagnostics,
    diagnosticSummary: summarizeDiagnostics(analysis.diagnostics),
    recommendations: buildSearchRecommendations(searchState, analysis.diagnostics, warnings),
    attempts,
    workers: workerSummaries,
    warnings,
  };
}

function mergeSegmentsForSearch(cashSegments, awardSegments) {
  const mergedByKey = new Map();

  for (const segment of cashSegments) {
    mergedByKey.set(segmentSignature(segment), {
      ...segment,
      cashAvailable: true,
      awardOptions: Array.isArray(segment.awardOptions) ? segment.awardOptions : [],
      sources: buildSegmentSources(segment),
      automationDetails: buildSegmentAutomationDetails(segment),
    });
  }

  for (const segment of awardSegments) {
    const key = segmentSignature(segment);
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, {
        ...segment,
        cashAvailable: Boolean(segment.cashAvailable),
        awardOptions: Array.isArray(segment.awardOptions) ? segment.awardOptions : [],
        sources: buildSegmentSources(segment),
        automationDetails: buildSegmentAutomationDetails(segment),
      });
      continue;
    }

    mergedByKey.set(key, {
      ...existing,
      cashAvailable: Boolean(existing.cashAvailable || segment.cashAvailable),
      awardOptions: dedupeAwardOptions([
        ...existing.awardOptions,
        ...(Array.isArray(segment.awardOptions) ? segment.awardOptions : []),
      ]),
      sources: dedupeObjects(
        [...existing.sources, ...buildSegmentSources(segment)],
        (item) => `${item.providerName}|${item.capability}`
      ),
      automationDetails: dedupeObjects(
        [...(existing.automationDetails ?? []), ...buildSegmentAutomationDetails(segment)],
        (item) => `${item.workerName}|${item.program}|${item.fallbackMode ?? ""}`
      ),
    });
  }

  return [...mergedByKey.values()];
}

function segmentSignature(segment) {
  return [
    segment.origin,
    segment.destination,
    segment.departure,
    segment.arrival,
    segment.airline,
    segment.cabin,
    segment.stops,
  ].join("|");
}

function buildSegmentSources(segment) {
  return [{
    providerId: segment.sourceProviderId,
    providerName: segment.sourceProviderName,
    capability: segment.sourceCapability,
    status: segment.sourceStatus ?? null,
  }];
}

function buildSegmentAutomationDetails(segment) {
  if (!segment.automationWorkerName || !segment.automationProgram) return [];
  return [{
    workerName: segment.automationWorkerName,
    program: segment.automationProgram,
    fallbackMode: segment.fallbackMode ?? null,
  }];
}

function dedupeAwardOptions(awardOptions) {
  return dedupeObjects(awardOptions, (award) => `${award.program}|${award.miles}|${award.taxes}`);
}

function dedupeObjects(items, keySelector) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keySelector(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildProviderWarnings(searchState, cashResolution, awardResolution) {
  const warnings = [...(cashResolution.notes ?? [])];

  if (searchState.dataStrategy !== "sample-only" && cashResolution.sources?.length === 0) {
    warnings.push("SerpApi returned no usable cash-flight results. Local sample flights are not used as an automatic fallback.");
  }
  if (
    searchState.dataStrategy !== "sample-only" &&
    searchState.awardDataMode === "cash-and-awards" &&
    awardResolution.sources?.length === 0
  ) {
    warnings.push("Seats.aero returned no usable cached award results. Local sample awards are not used as an automatic fallback.");
  }

  if (searchState.dataStrategy !== "sample-only" && cashResolution.sources?.some((source) => source.type === "sample") && cashResolution.sources.every((source) => source.type === "sample")) {
    warnings.push("Cash results are using local sample inventory because no live official cash provider succeeded.");
  }
  if (
    searchState.dataStrategy !== "sample-only" &&
    searchState.awardDataMode === "cash-and-awards" &&
    awardResolution.sources?.some((source) => source.type === "sample") && awardResolution.sources.every((source) => source.type === "sample")
  ) {
    warnings.push("Award comparisons are using sample inventory. No live official award source is implemented yet.");
  }
  if (awardResolution.workers.some((worker) => worker.mode === "sample-award-automation")) {
    warnings.push("Automation fallback is still sample-backed. Worker routing is real, but the award data is not yet live.");
  }
  if (awardResolution.workers.some((worker) => worker.mode?.startsWith("seats-aero-"))) {
    warnings.push("Seats.aero award results are cached. Confirm the award is still available at the same mileage price and taxes before transferring points.");
  }
  if (awardResolution.workers?.some((worker) => worker.mode === "error")) {
    warnings.push("One or more award automation workers failed. Check the worker status details before trusting award coverage.");
  }

  return [...new Set(warnings.filter((warning) => typeof warning === "string" && warning.trim()))];
}
