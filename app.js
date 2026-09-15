import { getProviderCards, resolveSegments } from "./providers.js";
import { AIRLINE_PROGRAMS, TRANSFER_PARTNERS, formatAirlineProgramName } from "./search-config.mjs";
import {
  analyzeSearch,
  buildHighlightedCandidates,
  buildSearchRecommendations,
  rankItineraries,
  summarizeDiagnostics,
} from "./search-engine.mjs";
import { normalizeAndValidateSearchState } from "./search-state.mjs";

const STORAGE_KEY = "flight-search-optimizer-state";

const form = document.querySelector("#planner-form");
const resultsRoot = document.querySelector("#results");
const resultsSummary = document.querySelector("#results-summary");
const providerStatusRoot = document.querySelector("#provider-status");
const providerCardsRoot = document.querySelector("#provider-cards");
const diagnosticsRoot = document.querySelector("#search-diagnostics");
const insightsRoot = document.querySelector("#insights");
const validationRoot = document.querySelector("#validation-errors");
const connectionButton = document.querySelector("#check-connection");
const connectionStatusRoot = document.querySelector("#connection-status");
const awardProgramControlsRoot = document.querySelector("#award-program-controls");
const airlineBalanceControlsRoot = document.querySelector("#airline-balance-controls");
const transferRatioControlsRoot = document.querySelector("#transfer-ratio-controls");

boot();

async function boot() {
  renderAwardProgramControls();
  renderAirlineBalanceControls();
  renderTransferRatioControls();
  hydrateForm();
  renderProviderCards();
  form.addEventListener("input", persistFormState);
  form.addEventListener("submit", handleSubmit);
  connectionButton?.addEventListener("click", checkConnection);
  renderProviderStatus({
    selectedStrategy: form.elements.namedItem("dataStrategy").value,
    selectedMode: form.elements.namedItem("awardDataMode").value,
    attempts: [],
    finalSource: null,
    sources: [],
    workers: [],
  });
  renderResults([]);
}

function renderProviderCards() {
  providerCardsRoot.innerHTML = getProviderCards()
    .map(
      (provider) => `
        <article class="provider-card">
          <div class="provider-topline">
            <strong>${provider.name}</strong>
            <span class="provider-badge ${provider.badgeClass}">${provider.statusLabel}</span>
          </div>
          <p>${provider.description}</p>
          <p class="provider-meta">${provider.capabilities}</p>
        </article>
      `
    )
    .join("");
}

function renderAwardProgramControls() {
  awardProgramControlsRoot.innerHTML = AIRLINE_PROGRAMS.map(
    (program) => `
      <label class="checkbox-row compact">
        <input name="${awardProgramFieldName(program.id)}" type="checkbox" checked />
        <span>${program.name}</span>
      </label>
    `
  ).join("");
}

function renderAirlineBalanceControls() {
  airlineBalanceControlsRoot.innerHTML = AIRLINE_PROGRAMS.map(
    (program) => `
      <label>
        <span>${program.name} ${airlineBalanceUnit(program.id)}</span>
        <input name="${airlineBalanceFieldName(program.id)}" type="number" min="0" step="1000" value="${defaultAirlineBalance(program.id)}" required />
      </label>
    `
  ).join("");
}

function renderTransferRatioControls() {
  transferRatioControlsRoot.innerHTML = Object.entries(TRANSFER_PARTNERS)
    .flatMap(([currency, partners]) =>
      partners.map(
        (program) => `
          <label>
            <span>${formatProgram(currency)} to ${formatAirlineProgramName(program)}</span>
            <input name="${transferRatioFieldName(currency, program)}" type="number" min="0.01" step="0.01" value="1.00" required />
          </label>
        `
      )
    )
    .join("");
}

function hydrateForm() {
  const savedState = localStorage.getItem(STORAGE_KEY);
  if (!savedState) {
    return;
  }

  const parsedState = JSON.parse(savedState);
  for (const [key, value] of Object.entries(parsedState)) {
    const field = form.elements.namedItem(key);
    if (!field) {
      continue;
    }

    if (field.type === "checkbox") {
      field.checked = value;
      continue;
    }

    field.value = value;
  }
}

function persistFormState() {
  const currentState = {};
  for (const element of form.elements) {
    if (!element.name) {
      continue;
    }

    currentState[element.name] = element.type === "checkbox" ? element.checked : element.value;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
}

async function handleSubmit(event) {
  event.preventDefault();
  const rawInput = readForm(new FormData(form));
  const { searchState, errors } = normalizeAndValidateSearchState(rawInput);
  const validationErrors = [...errors, ...rawInput.clientErrors];
  renderValidationErrors(validationErrors);
  if (validationErrors.length > 0) {
    resetSearchFeedback(searchState);
    return;
  }

  const providerResult = await runSearch(searchState);
  if (providerResult.validationErrors?.length) {
    renderValidationErrors(providerResult.validationErrors);
    resetSearchFeedback(searchState);
    return;
  }

  const analysis = providerResult.diagnostics ? null : analyzeSearch(searchState, providerResult.segments ?? []);
  const resolvedDiagnostics = providerResult.diagnostics ?? analysis?.diagnostics ?? null;
  const resolvedRankedOptions = providerResult.itineraries ?? analysis?.itineraries ?? rankItineraries(searchState, providerResult.segments);
  const resolvedRecommendations =
    providerResult.recommendations ??
    buildSearchRecommendations(searchState, resolvedDiagnostics, providerResult.warnings ?? []);
  const hydratedProviderResult = {
    ...providerResult,
    diagnostics: resolvedDiagnostics,
    recommendations: resolvedRecommendations,
  };

  renderValidationErrors([]);
  renderProviderStatus(hydratedProviderResult);
  renderDiagnostics(
    hydratedProviderResult.diagnostics,
    hydratedProviderResult.diagnosticSummary,
    hydratedProviderResult.recommendations
  );
  renderInsights(hydratedProviderResult.insights);
  renderResults(resolvedRankedOptions, searchState, hydratedProviderResult);
}

function readForm(formData) {
  const parsedAwardImport = parseAwardImportJson(formData.get("awardImportJson"));
  return {
    clientErrors: parsedAwardImport.errors,
    origin: formData.get("origin").trim().toUpperCase(),
    destination: formData.get("destination").trim().toUpperCase(),
    useNearbyAirports: formData.get("useNearbyAirports") === "on",
    earliestDeparture: formData.get("earliestDeparture"),
    latestDeparture: formData.get("latestDeparture"),
    earliestReturn: formData.get("earliestReturn"),
    latestReturn: formData.get("latestReturn"),
    minStayNights: Number(formData.get("minStayNights")),
    maxStayNights: Number(formData.get("maxStayNights")),
    passengers: {
      adults: Number(formData.get("adultTravelers")),
    },
    departureTimePreference: formData.get("departureTimePreference"),
    returnTimePreference: formData.get("returnTimePreference"),
    timePreferenceMode: formData.get("timePreferenceMode"),
    timePreferencePenaltyDollars: Number(formData.get("timePreferencePenaltyDollars")),
    cabinPreference: formData.get("cabinPreference"),
    maxStops: Number(formData.get("maxStops")),
    rankingFocus: formData.get("rankingFocus"),
    dataStrategy: formData.get("dataStrategy"),
    awardDataMode: formData.get("awardDataMode"),
    awardPrograms: selectedAwardPrograms(formData),
    awardImports: parsedAwardImport.value,
    balances: {
      amex: Number(formData.get("amexPoints")),
      chase: Number(formData.get("chasePoints")),
      ...readAirlineBalances(formData),
    },
    thresholds: {
      amex: Number(formData.get("amexMinCpp")),
      chase: Number(formData.get("chaseMinCpp")),
      airline: Number(formData.get("airlineMinCpp")),
    },
    valuations: {
      amex: Number(formData.get("amexCentsPerPoint")),
      chase: Number(formData.get("chaseCentsPerPoint")),
      airline: Number(formData.get("airlineCentsPerMile")),
    },
    redemptionRates: {
      amexTravel: Number(formData.get("amexTravelRedemptionCpp")),
      chaseTravel: Number(formData.get("chaseTravelRedemptionCpp")),
    },
    transferRatios: readTransferRatios(formData),
  };
}

function parseAwardImportJson(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return {
      value: {},
      errors: [],
    };
  }

  try {
    return {
      value: JSON.parse(trimmed),
      errors: [],
    };
  } catch (error) {
    return {
      value: {},
      errors: [`Inline award import JSON is invalid: ${error.message}`],
    };
  }
}

function selectedAwardPrograms(formData) {
  return AIRLINE_PROGRAMS
    .filter((program) => formData.get(awardProgramFieldName(program.id)) === "on")
    .map((program) => program.id);
}

function readAirlineBalances(formData) {
  return Object.fromEntries(
    AIRLINE_PROGRAMS.map((program) => [program.id, Number(formData.get(airlineBalanceFieldName(program.id)))])
  );
}

function readTransferRatios(formData) {
  return Object.fromEntries(
    Object.entries(TRANSFER_PARTNERS).map(([currency, partners]) => [
      currency,
      Object.fromEntries(
        partners.map((program) => [program, Number(formData.get(transferRatioFieldName(currency, program)))])
      ),
    ])
  );
}

function awardProgramFieldName(programId) {
  return `awardProgram${toPascalCase(programId)}`;
}

function airlineBalanceFieldName(programId) {
  return {
    jetblue: "jetbluePoints",
    southwest: "southwestPoints",
  }[programId] ?? `${programId}Miles`;
}

function airlineBalanceUnit(programId) {
  return {
    jetblue: "points",
    southwest: "points",
  }[programId] ?? "miles";
}

function defaultAirlineBalance(programId) {
  return {
    united: 22000,
    delta: 18000,
    jetblue: 9000,
    frontier: 7000,
    southwest: 12000,
  }[programId] ?? 0;
}

function transferRatioFieldName(currency, programId) {
  return `${currency}To${toPascalCase(programId)}Ratio`;
}

function toPascalCase(value) {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function renderProviderStatus(providerResult) {
  const attemptMarkup = providerResult.attempts.length
    ? providerResult.attempts
        .map((attempt) => `${attempt.name}: ${attempt.outcome}`)
        .join(" | ")
    : "No provider request has run yet.";

  const finalSource = providerResult.finalSource
    ? `Current source: ${providerResult.finalSource.name}.`
    : "Current source: none yet.";
  const sourceBlend = providerResult.sources?.length
    ? `Resolved sources: ${providerResult.sources
        .map(
          (source) =>
            `${source.role} from ${source.name} [${formatSourceStatus(source.status)}]${source.programs?.length ? ` (${source.programs.join(", ")})` : ""}`
        )
        .join(" | ")}.`
    : "Resolved sources: none yet.";
  const workerBlend = providerResult.workers?.length
    ? `Workers: ${providerResult.workers
        .map((worker) => `${worker.workerName} [${worker.program}] ${worker.outcome}`)
        .join(" | ")}.`
    : "Workers: none yet.";
  const warningMarkup = providerResult.warnings?.length
    ? `<div class="provider-warning">${providerResult.warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}</div>`
    : "";

  providerStatusRoot.innerHTML = `
    <div class="provider-status-card">
      <div class="provider-topline">
        <strong>Data pipeline</strong>
        <span class="provider-badge provider-badge-info">${formatStrategy(providerResult.selectedStrategy)}</span>
      </div>
      <p>${finalSource} Award mode: ${formatAwardMode(providerResult.selectedMode)}.</p>
      <p>${sourceBlend}</p>
      <p>${workerBlend}</p>
      <p class="provider-meta">${attemptMarkup}</p>
      ${warningMarkup}
    </div>
  `;
}

async function runSearch(searchState) {
  return resolveSegments(searchState);
}

async function checkConnection() {
  if (!connectionStatusRoot) {
    return;
  }

  connectionStatusRoot.innerHTML = `<p class="connection-line">Checking live providers…</p>`;

  let health;
  try {
    const response = await fetch("/api/providers/health");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    health = await response.json();
  } catch (error) {
    connectionStatusRoot.innerHTML = `<p class="connection-line connection-bad">Could not reach the backend (${error.message}). Start it with <code>node server.mjs</code>.</p>`;
    return;
  }

  connectionStatusRoot.innerHTML = health.providers
    .map((provider) => {
      const stateClass = ["live", "cached", "configured"].includes(provider.status)
        ? "connection-good"
        : "connection-bad";
      const detail = provider.detail ? ` — ${provider.detail}` : "";
      return `<p class="connection-line ${stateClass}"><strong>${provider.name}:</strong> ${formatConnectionStatus(
        provider.status
      )}${detail}</p>`;
    })
    .join("");
}

function formatConnectionStatus(status) {
  return {
    live: "live and authenticated",
    cached: "cached data available",
    checking: "configured",
    "missing-credentials": "not configured",
    "auth-failed": "authentication failed",
    "not-implemented": "not implemented yet",
  }[status] ?? status;
}

function resetSearchFeedback(searchState) {
  renderProviderStatus({
    selectedStrategy: searchState.dataStrategy,
    selectedMode: searchState.awardDataMode,
    attempts: [],
    finalSource: null,
    sources: [],
    workers: [],
    warnings: [],
  });
  renderDiagnostics(null);
  renderInsights(null);
  renderResults([]);
}

function renderValidationErrors(errors) {
  if (!errors?.length) {
    validationRoot.innerHTML = "";
    return;
  }

  validationRoot.innerHTML = `
    <div class="validation-card">
      <strong>Fix these inputs before searching:</strong>
      <ul>${errors.map((error) => `<li>${error}</li>`).join("")}</ul>
    </div>
  `;
}

function renderDiagnostics(diagnostics, summaryLines = null, recommendations = []) {
  if (!diagnostics && !summaryLines?.length) {
    diagnosticsRoot.innerHTML = "";
    return;
  }

  const lines = summaryLines?.length ? summaryLines : summarizeDiagnostics(diagnostics);
  const awardDetails = (diagnostics?.awardRejectionDetails ?? []).slice(0, 3).map(formatAwardRejection);
  diagnosticsRoot.innerHTML = `
    <article class="insight-card diagnostics-card">
      <h3>Search Diagnostics</h3>
      ${lines.map((line) => `<p class="insight-line">${line}</p>`).join("")}
      ${awardDetails.length ? `<h4>Award rejection examples</h4>${awardDetails.map((line) => `<p class="insight-line">${line}</p>`).join("")}` : ""}
      ${recommendations.length ? `<h4>Recommendations</h4>${recommendations.map((line) => `<p class="insight-line">${escapeHtml(line)}</p>`).join("")}` : ""}
    </article>
  `;
}

function formatAwardRejection(rejection) {
  const source = rejection.sourceCurrency ? `${formatProgramName(rejection.sourceCurrency)} transfer` : formatProgramName(rejection.program);
  if (rejection.reason.includes("balance")) {
    return `${source}: requires ${formatNumber(rejection.requiredPoints)} points; ${formatNumber(rejection.availablePoints)} available (${formatNumber(rejection.shortfall)} short).`;
  }
  if (rejection.actualCpp !== undefined) {
    return `${source}: ${rejection.actualCpp.toFixed(2)} cpp is below the ${rejection.thresholdCpp.toFixed(2)} cpp threshold.`;
  }
  return `${source}: rejected because ${rejection.reason}.`;
}

function formatSegmentSource(segment, label) {
  const providerNames = segment.sources?.map((source) =>
    `${source.providerName} [${formatSourceStatus(source.status)}]`
  ).join(", ") ?? "Unknown source";
  const workerNames = segment.automationDetails?.length
    ? ` via ${segment.automationDetails.map((detail) => `${detail.workerName} (${detail.program})`).join(", ")}`
    : "";
  return `${label}: ${providerNames}${workerNames}`;
}

function formatSourceStatus(status) {
  return {
    live: "live",
    cached: "cached",
    sample: "sample-backed",
  }[status] ?? "status unknown";
}

function renderResults(rankedOptions, searchState = null, providerResult = null) {
  if (rankedOptions.length === 0) {
    const sourceLabel = providerResult?.finalSource?.name ?? "selected data source";
    resultsSummary.textContent = searchState
      ? `No itineraries from ${sourceLabel} match the current search, timing rules, and redemption thresholds.`
      : "Submit the planner to compare candidate itineraries.";
    const guidance = providerResult?.recommendations ?? [];
    resultsRoot.innerHTML = `
      <div class="empty-state">
        <strong>No ranked results yet.</strong>
        ${guidance.length ? `<ul class="guidance-list">${guidance.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}
      </div>
    `;
    return;
  }

  const sourceLabel = providerResult?.finalSource?.name ?? "current provider";
  const sourceBlend = providerResult?.sources?.length
    ? providerResult.sources.map((source) => `${source.role}: ${source.name}`).join(", ")
    : sourceLabel;
  resultsSummary.textContent = `${rankedOptions.length} itinerary pairings ranked by ${formatRankingFocus(
    searchState?.rankingFocus
  )} using ${sourceBlend}.`;
  const highlightedCandidates = providerResult?.highlightedCandidates
    ?? buildHighlightedCandidates(rankedOptions, providerResult?.insights);
  resultsRoot.innerHTML = `${renderHighlightedCandidates(highlightedCandidates)}
    <div class="full-results-heading">
      <h3>All ranked options</h3>
      <span>${rankedOptions.length} total</span>
    </div>
    ${rankedOptions
    .map(
      (option, index) => `
        <article class="result-item" id="option_${index + 1}">
          <div class="result-topline">
            <div class="result-title">#${index + 1} ${option.outbound.origin} to ${option.outbound.destination} then ${option.inbound.origin} to ${option.inbound.destination}</div>
            <div class="score-pill">Cash outlay ${formatCurrency(option.cashOutlay)}</div>
          </div>
          <div class="result-meta">
            <span class="tag">${option.bookingLabel ?? option.bookingType}</span>
            <span>${option.passengerCount} adult${option.passengerCount === 1 ? "" : "s"}</span>
            <span>${formatDate(option.outbound.departure)} outbound</span>
            <span>${formatDate(option.inbound.departure)} return</span>
            <span>${option.stayNights} nights</span>
            <span>${formatDuration(option.totalDurationMinutes)} total travel</span>
            ${option.travelMetrics?.totalLayoverMinutes !== null && option.travelMetrics?.totalLayoverMinutes !== undefined
              ? `<span>${formatDuration(option.travelMetrics.totalLayoverMinutes)} layovers</span>`
              : ""}
            ${option.travelMetrics?.longestLayoverMinutes > 0
              ? `<span>${formatDuration(option.travelMetrics.longestLayoverMinutes)} longest layover</span>`
              : ""}
          </div>
          ${option.riskFlags?.length ? `<div class="caveat-line risk-line">${option.riskFlags.map(formatRiskFlag).join(" ")}</div>` : ""}
          ${renderTicketingMetadata(option.ticketing)}
          ${renderLegMetrics(option.travelMetrics)}
          <div class="result-meta source-line">
            <span>${formatSegmentSource(option.outbound, "Outbound")}</span>
            <span>${formatSegmentSource(option.inbound, "Return")}</span>
          </div>
          ${renderCachedAwardMetadata(option)}
          <div class="result-costs">
            <div class="cost-block">
              <span class="cost-label">Best method</span>
              <span class="cost-value">${option.label}</span>
            </div>
            <div class="cost-block">
              <span class="cost-label">Effective cost</span>
              <span class="cost-value">${formatCurrency(option.effectiveCost)}</span>
            </div>
            <div class="cost-block">
              <span class="cost-label">Points or miles</span>
              <span class="cost-value">${formatNumber(option.pointsUsed)}</span>
            </div>
            <div class="cost-block">
              <span class="cost-label">Average cpp</span>
              <span class="cost-value">${option.centsPerPoint ? `${option.centsPerPoint.toFixed(2)} cpp` : "n/a"}</span>
            </div>
          </div>
          ${renderPaymentBreakdown(option.paymentBreakdown)}
          ${renderCaveats(option)}
          ${renderBalanceImpact(option.balanceImpact)}
          ${renderValueBreakdown(option.valueBreakdown)}
          <p class="result-explanation">${option.explanation}</p>
        </article>
      `
    )
    .join("")}`;
}

function renderHighlightedCandidates(highlights = []) {
  if (!highlights.length) return "";

  const candidatesByOption = new Map();
  for (const highlight of highlights) {
    const existing = candidatesByOption.get(highlight.optionId);
    if (existing) {
      existing.labels.push(highlight.label);
      continue;
    }
    candidatesByOption.set(highlight.optionId, {
      optionId: highlight.optionId,
      itinerary: highlight.itinerary,
      labels: [highlight.label],
    });
  }

  return `
    <section class="highlighted-results" aria-labelledby="highlighted-results-title">
      <div class="highlighted-results-heading">
        <div>
          <p class="eyebrow">Start here</p>
          <h3 id="highlighted-results-title">Highlighted options</h3>
        </div>
        <p>Practical winners across price, schedule, speed, and payment method.</p>
      </div>
      <div class="highlighted-results-grid">
        ${[...candidatesByOption.values()].map(renderHighlightedCandidate).join("")}
      </div>
    </section>
  `;
}

function renderHighlightedCandidate({ optionId, itinerary, labels }) {
  const layovers = itinerary.travelMetrics?.totalLayoverMinutes;
  const risks = (itinerary.riskFlags ?? []).slice(0, 2);
  return `
    <article class="highlighted-result-item">
      <div class="highlight-labels">
        ${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
      </div>
      <strong>${escapeHtml(itinerary.outbound.origin)} to ${escapeHtml(itinerary.outbound.destination)}</strong>
      <div class="highlighted-result-cost">${formatCurrency(itinerary.cashOutlay)} cash</div>
      <div class="highlighted-result-meta">
        <span>${formatDuration(itinerary.totalDurationMinutes)} travel</span>
        ${Number.isFinite(layovers) ? `<span>${formatDuration(layovers)} layovers</span>` : ""}
        <span>${formatNumber(itinerary.pointsUsed)} points</span>
      </div>
      ${risks.length ? `<p class="highlighted-result-risks">${risks.map(formatRiskFlag).join(" · ")}</p>` : ""}
      <a href="#${optionId}">View full option ${optionId.replace("option_", "#")}</a>
    </article>
  `;
}

function renderBalanceImpact(balanceImpact = []) {
  const usedBalances = balanceImpact.filter((item) => item.used > 0);
  if (!usedBalances.length) {
    return "";
  }

  return `
    <div class="balance-impact">
      <span class="balance-impact-label">Balance impact</span>
      ${usedBalances
        .map(
          (item) =>
            `<span>${item.label}: -${formatNumber(item.used)} (${formatNumber(item.remaining)} left)</span>`
        )
        .join("")}
    </div>
  `;
}

function renderValueBreakdown(valueBreakdown) {
  if (!valueBreakdown) {
    return "";
  }

  return `
    <div class="value-breakdown">
      <span>Cash fare baseline ${formatCurrency(valueBreakdown.referenceCashPrice)}</span>
      <span>Cash saved ${formatCurrency(valueBreakdown.cashSavings)}</span>
      <span>Point value cost ${formatCurrency(valueBreakdown.pointOpportunityCost)}</span>
      <span>Time preference penalty ${formatCurrency(valueBreakdown.timePreferencePenalty)}</span>
      <span>Formula total ${formatCurrency(valueBreakdown.effectiveCost)}</span>
    </div>
  `;
}

function renderCachedAwardMetadata(option) {
  const segments = [option.outbound, option.inbound].filter(Boolean);
  const cachedSegments = segments.filter((segment) => segment.verification === "discovered_cached");
  const evidence = summarizeAwardEvidence(segments);
  const links = collectBookingLinks(segments);
  const items = [];

  if (cachedSegments.length > 0) {
    items.push(`${cachedSegments.length === 2 ? "Both" : "One"} direction${cachedSegments.length === 1 ? "" : "s"} from cached awards`);
  }

  const lastSeen = latestTimestamp(segments.map((segment) => segment.providerUpdatedAt));
  if (lastSeen) {
    items.push(`Last seen ${formatTimestamp(lastSeen)}`);
  }

  const retrievedAt = latestTimestamp(segments.map((segment) => segment.retrievedAt));
  if (retrievedAt) {
    items.push(`Retrieved ${formatTimestamp(retrievedAt)}`);
  }

  if (evidence.length > 0) {
    items.push(...evidence);
  }

  if (links.length > 0) {
    items.push(
      ...links.map(
        (link) =>
          `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`
      )
    );
  }

  if (items.length === 0) {
    return "";
  }

  return `
    <div class="result-meta availability-line">
      ${items.map((item) => `<span>${item}</span>`).join("")}
    </div>
  `;
}

function summarizeAwardEvidence(segments) {
  const summaries = [];
  const awardOptions = segments.flatMap((segment) => segment.awardOptions ?? []);
  const reportedSeats = awardOptions
    .map((award) => award.remainingSeats)
    .filter((seats) => Number.isFinite(seats) && seats > 0);
  if (reportedSeats.length > 0) {
    summaries.push(`${Math.min(...reportedSeats)}+ seats reported`);
  } else if (awardOptions.some((award) => award.seatCountStatus === "zero_or_unknown")) {
    summaries.push("Seat count unknown");
  }

  const mixedCabinPct = awardOptions
    .map((award) => award.mixedCabinPct)
    .filter((percent) => Number.isFinite(percent) && percent > 0);
  if (mixedCabinPct.length > 0) {
    summaries.push(`Mixed cabin up to ${Math.max(...mixedCabinPct)}%`);
  }

  return summaries;
}

function collectBookingLinks(segments) {
  const seen = new Set();
  const links = [];
  for (const evidence of segments.flatMap((segment) => segment.providerEvidence ?? [])) {
    if (evidence.searchLink && !seen.has(evidence.searchLink)) {
      seen.add(evidence.searchLink);
      links.push({ label: "View search", url: evidence.searchLink });
    }
    for (const link of evidence.bookingLinks ?? []) {
      if (!link?.url || seen.has(link.url)) continue;
      seen.add(link.url);
      links.push({
        label: `Book on ${link.label ?? getLinkHost(link.url)}`,
        url: link.url,
      });
    }
  }
  for (const award of segments.flatMap((segment) => segment.awardOptions ?? [])) {
    for (const link of award.bookingLinks ?? []) {
      if (!link?.url || seen.has(link.url)) {
        continue;
      }
      seen.add(link.url);
      links.push({
        label: `Book on ${link.label ?? getLinkHost(link.url)}`,
        url: link.url,
      });
    }
  }

  return links.slice(0, 5);
}

function renderCaveats(option) {
  const caveats = [
    ...(option.caveats ?? []),
    ...(option.paymentBreakdown ?? []).flatMap((item) => item.caveats ?? []),
  ];
  const uniqueCaveats = [...new Set(caveats)].filter(Boolean);
  if (!uniqueCaveats.length) {
    return "";
  }

  const badges = buildCaveatBadges(uniqueCaveats);

  return `
    <div class="caveat-line compact-caveats">
      ${badges.map((badge) => `<span>${escapeHtml(badge)}</span>`).join("")}
      <details>
        <summary>Provider details</summary>
        ${uniqueCaveats.map((caveat) => `<p>${escapeHtml(caveat)}</p>`).join("")}
      </details>
    </div>
  `;
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

function renderPaymentBreakdown(paymentBreakdown = []) {
  if (!paymentBreakdown.length) {
    return "";
  }

  return `
    <div class="result-meta payment-line">
      ${paymentBreakdown.map((item) => `<span>${formatPaymentBreakdown(item)}</span>`).join("")}
    </div>
  `;
}

function formatPaymentBreakdown(item) {
  if (item.redemptionType === "card-travel") {
    return `${capitalizeWords(item.direction)} ${formatProgramName(item.program)} travel redemption: ${formatNumber(
      item.pointsUsed
    )} points at ${item.centsPerPoint.toFixed(2)} cpp`;
  }

  if (item.sourceCurrency && item.transferRatio) {
    return `${capitalizeWords(item.direction)} transfer: ${formatNumber(item.pointsUsed)} ${formatProgramName(
      item.sourceCurrency
    )} -> ${formatNumber(item.awardMiles)} ${formatProgramName(item.program)} at ${item.transferRatio.toFixed(2)}:1`;
  }

  if (item.program !== "cash") {
    return `${capitalizeWords(item.direction)} award: ${formatNumber(item.pointsUsed)} ${formatProgramName(item.program)}`;
  }

  return `${capitalizeWords(item.direction)} cash: ${formatCurrency(item.cashOutlay)}`;
}

function renderInsights(insights) {
  if (!insights) {
    insightsRoot.innerHTML = "";
    return;
  }

  insightsRoot.innerHTML = [
    renderInsightCard("Best Overall", insights.bestOverall ? [formatOverallInsight(insights.bestOverall)] : ["No result yet."]),
    renderInsightCard("Best Options by Category", formatCategoryInsights(insights.bestByCategory)),
    renderInsightCard("Best Departure Dates", insights.bestByDepartureDate.map((item) => formatBucketInsight(item, "depart"))),
    renderInsightCard("Best Return Dates", insights.bestByReturnDate.map((item) => formatBucketInsight(item, "return"))),
    renderInsightCard("Best Stay Lengths", insights.bestByStayLength.map((item) => formatBucketInsight(item, "stay"))),
  ].join("");
}

function formatCategoryInsights(categories = {}) {
  return [
    ["Cheapest", categories.cheapest],
    ["Best effective cost", categories.bestEffectiveCost],
    ["Best preference match", categories.bestPreference],
    ["Best schedule", categories.bestSchedule],
    ["Fastest", categories.fastest],
    ["Best cash", categories.bestCash],
    ["Best award", categories.bestAward],
  ].map(([label, itinerary]) => itinerary ? `${label}: ${formatItineraryInsight(itinerary)}` : `${label}: none found`);
}

function formatItineraryInsight(itinerary) {
  const layoverNote = itinerary.travelMetrics?.totalLayoverMinutes !== null && itinerary.travelMetrics?.totalLayoverMinutes !== undefined
    ? `, ${formatDuration(itinerary.travelMetrics.totalLayoverMinutes)} layovers`
    : "";
  const riskNote = itinerary.riskFlags?.length ? `, ${itinerary.riskFlags.join(", ")}` : "";
  return `${formatCurrency(itinerary.cashOutlay)} cash, ${formatDuration(itinerary.totalDurationMinutes)} travel${layoverNote}${riskNote}`;
}

function renderInsightCard(title, lines) {
  return `
    <article class="insight-card">
      <h3>${title}</h3>
      ${lines.map((line) => `<p class="insight-line">${line}</p>`).join("")}
    </article>
  `;
}

function formatOverallInsight(itinerary) {
  return `${itinerary.outbound.departure.slice(0, 10)} out, ${itinerary.inbound.departure.slice(
    0,
    10
  )} back, ${formatCurrency(itinerary.cashOutlay)} cash, ${formatCurrency(itinerary.effectiveCost)} effective, ${formatDuration(
    itinerary.totalDurationMinutes
  )} travel${itinerary.riskFlags?.length ? `, ${itinerary.riskFlags.join(", ")}` : ""}`;
}

function formatRiskFlag(flag) {
  const labels = {
    "long-layover": "Long layover",
    "overnight-travel": "Overnight travel",
    "very-early-return": "Very early return",
    "separate-tickets-likely": "Separate tickets likely",
    "baggage-rules-may-differ": "Baggage rules may differ",
    "change-rules-may-differ": "Change rules may differ",
    "missed-connection-not-protected": "Missed connection not protected",
    "reservation-not-confirmed": "Reservation not confirmed",
  };
  return `<span>${labels[flag] ?? flag}</span>`;
}

function renderTicketingMetadata(ticketing) {
  if (!ticketing) return "";
  const details = [
    ticketing.ticketCount === "unknown" ? "Ticket count unknown" : `${ticketing.ticketCount} ticket${ticketing.ticketCount === 1 ? "" : "s"}`,
    `Reservation: ${ticketing.reservationStatus}`,
    `Connection protection: ${ticketing.connectionProtection}`,
    `Baggage: ${ticketing.baggageRules}`,
    `Changes: ${ticketing.changeRules}`,
  ];
  return `<div class="ticketing-line">${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}</div>`;
}

function renderLegMetrics(metrics) {
  if (!metrics) return "";
  const legs = [
    ["Outbound", metrics.outbound],
    ["Return", metrics.return],
  ].filter(([, leg]) => leg);
  if (!legs.length) return "";

  return `
    <div class="leg-metrics">
      ${legs.map(([label, leg]) => `
        <div class="leg-metric">
          <strong>${label}</strong>
          <span>${formatDuration(leg.durationMinutes)} total</span>
          <span>${leg.airMinutes === null ? "Air time unknown" : `${formatDuration(leg.airMinutes)} air`}</span>
          <span>${leg.layoverMinutes === null ? "Layover time unknown" : `${formatDuration(leg.layoverMinutes)} layovers`}</span>
          <span>${leg.stops} stop${leg.stops === 1 ? "" : "s"}</span>
          ${leg.arrivesNextDay ? "<span>Arrives next day</span>" : ""}
          ${leg.overnight && !leg.arrivesNextDay ? "<span>Overnight connection</span>" : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function formatBucketInsight(item, kind) {
  const label = kind === "stay" ? `${item.key} nights` : item.key;
  const pointsNote = item.pointsUsed > 0 ? `, ${formatNumber(item.pointsUsed)} points/miles` : "";
  const savingsNote = item.cashSavings > 0 ? `, saves ${formatCurrency(item.cashSavings)}` : "";
  const timeNote = item.timePreferencePenalty > 0 ? `, ${formatCurrency(item.timePreferencePenalty)} time penalty` : "";
  return `${label}: ${item.label}; ${formatCurrency(item.cashOutlay)} cash, ${formatCurrency(
    item.effectiveCost
  )} effective${pointsNote}${savingsNote}${timeNote}`;
}

function formatRankingFocus(focus) {
  return {
    "cash-first": "lowest cash out of pocket",
    "effective-cost": "lowest effective cost",
    fastest: "shortest total flight time",
  }[focus] ?? "lowest cash out of pocket";
}

function formatProgram(program) {
  return {
    amex: "Amex",
    chase: "Chase",
    cash: "Cash",
  }[program] ?? formatAirlineProgramName(program);
}

function formatCurrency(amount) {
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(Number(amount))) {
    return "Unknown";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(amount));
}

function formatNumber(amount) {
  return new Intl.NumberFormat("en-US").format(amount);
}

function formatProgramName(program) {
  return {
    amex: "Amex",
    chase: "Chase",
    amexTravel: "Amex",
    chaseTravel: "Chase",
    cash: "Cash",
  }[program] ?? formatAirlineProgramName(program);
}

function capitalizeWords(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `${hours}h ${remainderMinutes}m`;
}

function latestTimestamp(values) {
  const timestamps = values
    .map((value) => (value ? new Date(value) : null))
    .filter((date) => date && Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime());

  return timestamps[0] ?? null;
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function getLinkHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "provider site";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatStrategy(strategy) {
  return {
    "official-first": "Official APIs first",
    "official-then-automation": "Official APIs then automation",
    "sample-only": "Sample data only",
  }[strategy] ?? strategy;
}

function formatAwardMode(mode) {
  return {
    "cash-and-awards": "cash plus awards",
    "cash-only": "cash only",
  }[mode] ?? mode;
}
