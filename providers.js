export const PROVIDERS = [
  {
    id: "serpapi-google-flights",
    name: "SerpApi Google Flights",
    type: "official",
    liveReady: true,
    supportsCash: true,
    supportsAwards: false,
    description:
      "Bounded Google Flights cash discovery with cache-aware provenance and on-demand booking-option lookup when a finalist is inspected.",
  },
  {
    id: "amadeus-flight-offers",
    name: "Amadeus Flight Offers",
    type: "official",
    liveReady: false,
    supportsCash: true,
    supportsAwards: false,
    description: "Official API candidate for cash fares and schedules when Amadeus credentials are configured.",
  },
  {
    id: "duffel",
    name: "Duffel",
    type: "official",
    liveReady: false,
    supportsCash: true,
    supportsAwards: false,
    description: "Official API candidate for cash fare shopping once live offer creation and mapping are implemented.",
  },
  {
    id: "seats-aero-cached-awards",
    name: "Seats.aero Cached Awards",
    type: "official",
    liveReady: true,
    supportsCash: false,
    supportsAwards: true,
    description:
      "Cached award-search source for supported airline programs when SEATS_AERO_API_KEY is configured; confirm availability and price before transferring points.",
  },
  {
    id: "award-automation",
    name: "Award Automation Fallback",
    type: "automation",
    liveReady: false,
    supportsCash: false,
    supportsAwards: true,
    description: "Fallback lane for imported or browser-driven award collection across selected airline programs.",
  },
  {
    id: "sample-segments",
    name: "Sample Segment Inventory",
    type: "sample",
    liveReady: true,
    supportsCash: true,
    supportsAwards: true,
    description: "Local seed data that keeps the optimizer functional until live providers are wired in.",
  },
];

export function getProviderCards() {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    description: provider.description,
    capabilities: `${provider.supportsCash ? "Cash" : "No cash"} | ${
      provider.supportsAwards ? "Awards" : "No awards"
    } | ${provider.type}`,
    statusLabel: provider.liveReady ? "Ready now" : "Planned",
    badgeClass: provider.liveReady ? "provider-badge-ready" : "provider-badge-planned",
  }));
}

export async function resolveSegments(searchState) {
  try {
    const response = await fetch("/api/providers/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchState),
    });

    if (response.status === 400) {
      return response.json();
    }

    if (!response.ok) {
      return buildUnavailableSearchResult(searchState, `Backend returned HTTP ${response.status}.`);
    }

    return response.json();
  } catch (error) {
    return buildUnavailableSearchResult(searchState, `Backend search failed: ${error.message}`);
  }
}

function buildUnavailableSearchResult(searchState, warning) {
  return {
    ok: false,
    selectedStrategy: searchState.dataStrategy,
    selectedMode: searchState.awardDataMode,
    attempts: [
      {
        name: "Backend Search",
        outcome: warning,
      },
    ],
    finalSource: null,
    sources: [],
    workers: [],
    segments: [],
    itineraries: [],
    diagnostics: null,
    diagnosticSummary: [],
    insights: null,
    recommendations: ["Start the local server with `node server.mjs`, then run the search again."],
    warnings: [warning],
  };
}
