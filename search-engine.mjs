import {
  AIRLINE_PROGRAMS,
  PARTNER_MAP,
  TIME_WINDOWS,
  expandAirports,
  getAirportAccess,
  formatAirlineProgramName,
} from "./search-config.mjs";

const TRANSFER_CONFIRMATION_CAVEAT =
  "Confirm the award is still available at the same mileage price and taxes before transferring points.";

export function rankItineraries(searchState, segments) {
  return analyzeSearch(searchState, segments).itineraries;
}

export function analyzeSearch(searchState, segments) {
  const airportScope = {
    origins: expandAirports(searchState.origin, searchState.useNearbyAirports, searchState.nearbyAirportMaxGroundTravelMinutes),
    destinations: expandAirports(searchState.destination, searchState.useNearbyAirports, searchState.nearbyAirportMaxGroundTravelMinutes),
    nearbyAirportMaxGroundTravelMinutes: searchState.nearbyAirportMaxGroundTravelMinutes,
    nearbyAirportGroundCostPerHour: searchState.nearbyAirportGroundCostPerHour,
  };

  const diagnostics = {
    airportScope,
    totalSegments: segments.length,
    outboundCandidates: 0,
    returnCandidates: 0,
    outboundAwardCandidates: 0,
    returnAwardCandidates: 0,
    outboundRejectedAirport: 0,
    outboundRejectedCabin: 0,
    outboundRejectedStops: 0,
    outboundRejectedDate: 0,
    outboundRejectedTime: 0,
    returnRejectedAirport: 0,
    returnRejectedCabin: 0,
    returnRejectedStops: 0,
    returnRejectedDate: 0,
    returnRejectedTime: 0,
    totalPairsChecked: 0,
    rejectedChronology: 0,
    rejectedStayLength: 0,
    rejectedPaymentRules: 0,
    rejectedPairBalance: 0,
    acceptedItineraries: 0,
    awardOptionsEvaluated: 0,
    rejectedAirlineCpp: 0,
    rejectedAirlineBalance: 0,
    acceptedAirlineRedemptions: 0,
    rejectedTransferCpp: 0,
    rejectedTransferBalance: 0,
    acceptedTransferOptions: 0,
    awardProgramCoverage: Object.fromEntries((searchState.awardPrograms ?? []).map((program) => [program, {
      segments: 0,
      options: 0,
      cachedSegments: 0,
    }])),
    awardRejectionSummary: {},
    awardRejectionDetails: [],
  };

  const outboundSegments = segments.filter((segment) =>
    matchesSegment(segment, searchState, airportScope, "outbound", diagnostics)
  );
  const returnSegments = searchState.tripType === "one-way" ? [] : segments.filter((segment) =>
    matchesSegment(segment, searchState, airportScope, "return", diagnostics)
  );

  diagnostics.outboundCandidates = outboundSegments.length;
  diagnostics.returnCandidates = returnSegments.length;
  diagnostics.outboundAwardCandidates = outboundSegments.filter((segment) => segment.awardOptions?.length).length;
  diagnostics.returnAwardCandidates = returnSegments.filter((segment) => segment.awardOptions?.length).length;
  recordAwardCoverage(diagnostics, [...outboundSegments, ...returnSegments], searchState.awardPrograms ?? []);

  const itineraries = [];
  if (searchState.tripType === "one-way") {
    for (const outbound of outboundSegments) {
      const itinerary = buildOneWayItinerary(outbound, searchState, diagnostics);
      if (itinerary) {
        diagnostics.acceptedItineraries += 1;
        itineraries.push(itinerary);
      } else {
        diagnostics.rejectedPaymentRules += 1;
      }
    }
    return {
      itineraries: itineraries.sort((left, right) => compareItineraries(left, right, searchState.rankingFocus)),
      diagnostics,
    };
  }

  for (const outbound of outboundSegments) {
    for (const inbound of returnSegments) {
      diagnostics.totalPairsChecked += 1;

      if (new Date(inbound.departure) <= new Date(outbound.departure)) {
        diagnostics.rejectedChronology += 1;
        continue;
      }

      const stayNights = getStayNights(outbound.departure, inbound.departure);
      if (stayNights < searchState.minStayNights || stayNights > searchState.maxStayNights) {
        diagnostics.rejectedStayLength += 1;
        continue;
      }

      const itinerary = buildItinerary(outbound, inbound, searchState, diagnostics);
      if (itinerary) {
        diagnostics.acceptedItineraries += 1;
        itineraries.push(itinerary);
      } else {
        diagnostics.rejectedPaymentRules += 1;
      }
    }
  }

  return {
    itineraries: itineraries.sort((left, right) => compareItineraries(left, right, searchState.rankingFocus)),
    diagnostics,
  };
}

function buildOneWayItinerary(outbound, searchState, diagnostics) {
  const options = buildSegmentPaymentOptions(outbound, searchState, "outbound", diagnostics)
    .filter((option) => fitsBalances(option.usage, searchState.balances));
  if (options.length === 0) return null;

  const bestPayment = options.sort((left, right) => comparePayments(left, right, searchState.rankingFocus))[0];
  const departurePenalty = searchState.timePreferenceMode === "soft"
    ? preferencePenalty(outbound.departure, searchState.departureTimePreference)
    : 0;
  const timePreferencePenalty = departurePenalty * getTimePreferencePenaltyDollars(searchState);
  const payment = {
    ...bestPayment,
    outboundOption: bestPayment,
    returnOption: null,
  };
  const airportAccess = buildItineraryAirportAccess(outbound, null, searchState);
  const valueBreakdown = buildValueBreakdown(payment, timePreferencePenalty, airportAccess.groundTravelCost);
  const ticketing = buildTicketingMetadata(outbound, null);

  const itinerary = {
    outbound,
    inbound: null,
    passengerCount: getPassengerCount(searchState),
    bookingType: ticketing.type,
    bookingLabel: ticketing.label,
    ticketing,
    totalDurationMinutes: outbound.durationMinutes,
    travelMetrics: buildItineraryTravelMetrics(outbound, null),
    airportAccess,
    riskFlags: buildItineraryRiskFlags(outbound, null, ticketing),
    qualityPenalty: null,
    stayNights: null,
    cashOutlay: bestPayment.cashOutlay,
    effectiveCost: valueBreakdown.effectiveCost,
    pointsUsed: bestPayment.pointsUsed,
    centsPerPoint: bestPayment.centsPerPoint,
    caveats: [...bestPayment.caveats, ...ticketing.caveats],
    usage: bestPayment.usage,
    balanceImpact: buildBalanceImpact(searchState.balances, bestPayment.usage),
    label: bestPayment.label,
    paymentBreakdown: [summarizePaymentOption(bestPayment)],
    valueBreakdown,
    explanation: buildExplanation(payment, departurePenalty, 0, searchState.timePreferenceMode),
  };
  itinerary.qualityPenalty = roundCurrency(qualityPenalty(itinerary));
  return itinerary;
}

export function buildSearchInsights(itineraries, rankingFocus = "cash-first") {
  const bestCash = selectBest(itineraries.filter((itinerary) => itinerary.pointsUsed === 0), compareByCash);
  const bestAward = selectBest(itineraries.filter((itinerary) => itinerary.pointsUsed > 0), compareByEffectiveCost);
  const bestEffectiveCost = selectBest(itineraries, compareByEffectiveCost);
  const bestFastest = selectBest(itineraries, compareByDuration);
  const bestSchedule = selectBest(itineraries, compareBySchedule);
  const bestOverall = selectBest(itineraries, compareByOverall);

  return {
    bestOverall,
    bestByCategory: {
      cheapest: selectBest(itineraries, compareByCash),
      bestEffectiveCost,
      bestPreference: bestEffectiveCost,
      bestSchedule,
      fastest: bestFastest,
      bestCash: bestCash ?? null,
      bestAward: bestAward ?? null,
    },
    bestByDepartureDate: summarizeBestBy(
      itineraries,
      (itinerary) => itinerary.outbound.departure.slice(0, 10),
      rankingFocus
    ),
    bestByReturnDate: summarizeBestBy(
      itineraries.filter((itinerary) => itinerary.inbound),
      (itinerary) => itinerary.inbound.departure.slice(0, 10),
      rankingFocus
    ),
    bestByStayLength: summarizeBestBy(
      itineraries.filter((itinerary) => itinerary.inbound),
      (itinerary) => String(itinerary.stayNights),
      rankingFocus
    ),
    dateMatrix: buildDateMatrix(itineraries, rankingFocus),
  };
}

const HIGHLIGHT_CATEGORY_DEFINITIONS = [
  ["bestOverall", "Best overall", (insights) => insights.bestOverall],
  ["cheapest", "Cheapest", (insights) => insights.bestByCategory?.cheapest],
  ["bestSchedule", "Best schedule", (insights) => insights.bestByCategory?.bestSchedule],
  ["fastest", "Fastest", (insights) => insights.bestByCategory?.fastest],
  ["bestCash", "Best cash", (insights) => insights.bestByCategory?.bestCash],
  ["bestAward", "Best award", (insights) => insights.bestByCategory?.bestAward],
];

/**
 * Connect category winners to the stable option IDs used by the ranked result.
 * Categories remain separate in this API shape even when one option wins more
 * than one category; presentation layers may consolidate those duplicates.
 */
export function buildHighlightedCandidates(itineraries, insights) {
  if (!Array.isArray(itineraries) || !insights) return [];

  return HIGHLIGHT_CATEGORY_DEFINITIONS.flatMap(([category, label, selectItinerary]) => {
    const itinerary = selectItinerary(insights);
    const optionIndex = itineraries.indexOf(itinerary);
    if (!itinerary || optionIndex < 0) return [];

    return [{
      category,
      label,
      optionId: `option_${optionIndex + 1}`,
      itinerary,
    }];
  });
}

export function summarizeDiagnostics(diagnostics) {
  return [
    `Airports: ${diagnostics.airportScope.origins.join(", ")} -> ${diagnostics.airportScope.destinations.join(", ")}`,
    `Segments considered: ${diagnostics.totalSegments} total, ${diagnostics.outboundCandidates} outbound, ${diagnostics.returnCandidates} return`,
    `Segment rejects outbound - airport: ${diagnostics.outboundRejectedAirport}, cabin: ${diagnostics.outboundRejectedCabin}, stops: ${diagnostics.outboundRejectedStops}, date: ${diagnostics.outboundRejectedDate}, time: ${diagnostics.outboundRejectedTime}`,
    `Segment rejects return - airport: ${diagnostics.returnRejectedAirport}, cabin: ${diagnostics.returnRejectedCabin}, stops: ${diagnostics.returnRejectedStops}, date: ${diagnostics.returnRejectedDate}, time: ${diagnostics.returnRejectedTime}`,
    `Award-capable segments: ${diagnostics.outboundAwardCandidates} outbound, ${diagnostics.returnAwardCandidates} return`,
    `Pairings checked: ${diagnostics.totalPairsChecked}, accepted: ${diagnostics.acceptedItineraries}`,
    `Rejected by chronology: ${diagnostics.rejectedChronology}, stay rules: ${diagnostics.rejectedStayLength}, payment rules: ${diagnostics.rejectedPaymentRules}`,
    `Pair balance rejects: ${diagnostics.rejectedPairBalance}, award options reviewed: ${diagnostics.awardOptionsEvaluated}`,
    `Award rejects - cpp: ${diagnostics.rejectedAirlineCpp}, airline balance: ${diagnostics.rejectedAirlineBalance}, transfer cpp: ${diagnostics.rejectedTransferCpp}, transfer balance: ${diagnostics.rejectedTransferBalance}`,
    `Award paths kept - airline: ${diagnostics.acceptedAirlineRedemptions}, transfers: ${diagnostics.acceptedTransferOptions}`,
    `Award rejection detail groups: ${Object.keys(diagnostics.awardRejectionSummary ?? {}).length}; representative details: ${(diagnostics.awardRejectionDetails ?? []).length}`,
  ];
}

export function buildSearchRecommendations(searchState, diagnostics, warnings = []) {
  const guidance = [];

  if (!diagnostics) {
    if (warnings.length > 0) {
      guidance.push(warnings[0]);
    }
    return guidance;
  }

  if (diagnostics.outboundCandidates === 0 || diagnostics.returnCandidates === 0) {
    if (diagnostics.outboundRejectedAirport > 0 || diagnostics.returnRejectedAirport > 0) {
      guidance.push("Try a different airport pair or keep nearby airports enabled.");
    }
    if (diagnostics.outboundRejectedDate > 0 || diagnostics.returnRejectedDate > 0) {
      guidance.push("Widen the departure or return date window.");
    }
    if (diagnostics.outboundRejectedStops > 0 || diagnostics.returnRejectedStops > 0) {
      guidance.push("Allow more stops to increase matching flights.");
    }
    if (diagnostics.outboundRejectedTime > 0 || diagnostics.returnRejectedTime > 0) {
      guidance.push("Change time-of-day preferences to soft mode or choose a broader window.");
    }
    if (diagnostics.outboundRejectedCabin > 0 || diagnostics.returnRejectedCabin > 0) {
      guidance.push("Broaden the cabin preference.");
    }
  }

  if (diagnostics.rejectedStayLength > 0) {
    guidance.push("Widen the minimum or maximum stay-night range.");
  }

  if (diagnostics.rejectedPaymentRules > 0 || diagnostics.rejectedPairBalance > 0) {
    if (diagnostics.rejectedAirlineCpp > 0 || diagnostics.rejectedTransferCpp > 0) {
      guidance.push("Lower hard cpp thresholds if you want more award options to qualify.");
    }
    if (
      diagnostics.rejectedAirlineBalance > 0 ||
      diagnostics.rejectedTransferBalance > 0 ||
      diagnostics.rejectedPairBalance > 0
    ) {
      guidance.push("Increase balances, reduce transfer usage, or allow more cash-heavy options.");
    }
  }

  const rejectionGuidance = buildAwardRejectionGuidance(diagnostics);
  guidance.push(...rejectionGuidance);

  if (warnings.length > 0 && !guidance.includes(warnings[0])) {
    guidance.push(warnings[0]);
  }

  if (guidance.length === 0 && searchState.awardDataMode === "cash-and-awards") {
    guidance.push("Try switching to cash-only mode to see whether award rules are blocking otherwise valid trips.");
  }

  return [...new Set(guidance)].slice(0, 5);
}

function buildAwardRejectionGuidance(diagnostics) {
  const guidance = [];
  for (const coverage of Object.values(diagnostics.awardProgramCoverage ?? {})) {
    if (coverage.options === 0) {
      guidance.push("No award space was returned for one or more selected programs in this search window.");
      break;
    }
  }

  const groups = Object.values(diagnostics.awardRejectionSummary ?? {});
  const balanceGroup = groups.find((group) => group.reason === "insufficient-transfer-balance" || group.reason === "insufficient-airline-balance");
  if (balanceGroup?.examples?.[0]) {
    const example = balanceGroup.examples[0];
    guidance.push(
      `${formatProgram(example.sourceCurrency ?? example.program)} award path requires ${formatPoints(example.requiredPoints)} points; ${formatPoints(example.availablePoints)} available (${formatPoints(example.shortfall)} short).`
    );
  }

  if (groups.some((group) => group.reason === "poor-cpp" || group.reason === "poor-transfer-cpp")) {
    guidance.push("Some award paths were rejected because their cents-per-point value was below your configured threshold.");
  }

  return guidance;
}

function formatPoints(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

function matchesSegment(segment, searchState, airportScope, direction, diagnostics) {
  const originPool = direction === "outbound" ? airportScope.origins : airportScope.destinations;
  const destinationPool = direction === "outbound" ? airportScope.destinations : airportScope.origins;
  const segmentDate = segment.departure.slice(0, 10);
  const earliestDate = direction === "outbound" ? searchState.earliestDeparture : searchState.earliestReturn;
  const latestDate = direction === "outbound" ? searchState.latestDeparture : searchState.latestReturn;

  if (!originPool.includes(segment.origin) || !destinationPool.includes(segment.destination)) {
    incrementSegmentReject(diagnostics, direction, "Airport");
    return false;
  }

  if (searchState.cabinPreference !== "any" && segment.cabin !== searchState.cabinPreference) {
    incrementSegmentReject(diagnostics, direction, "Cabin");
    return false;
  }

  if (segment.stops > searchState.maxStops) {
    incrementSegmentReject(diagnostics, direction, "Stops");
    return false;
  }

  if (segmentDate < earliestDate || segmentDate > latestDate) {
    incrementSegmentReject(diagnostics, direction, "Date");
    return false;
  }

  const timePreference =
    direction === "outbound" ? searchState.departureTimePreference : searchState.returnTimePreference;
  if (searchState.timePreferenceMode === "hard" && !matchesTimePreference(segment.departure, timePreference)) {
    incrementSegmentReject(diagnostics, direction, "Time");
    return false;
  }

  return true;
}

function buildItinerary(outbound, inbound, searchState, diagnostics) {
  const segmentPairs = [
    ...buildSegmentPaymentOptions(outbound, searchState, "outbound", diagnostics),
    ...buildSegmentPaymentOptions(inbound, searchState, "return", diagnostics),
  ];

  const outboundOptions = segmentPairs.filter((option) => option.direction === "outbound");
  const returnOptions = segmentPairs.filter((option) => option.direction === "return");
  const itineraryOptions = [];

  for (const outboundOption of outboundOptions) {
    for (const returnOption of returnOptions) {
      const combinedUsage = combineUsage(outboundOption, returnOption);
      if (!fitsBalances(combinedUsage, searchState.balances)) {
        if (diagnostics) {
          diagnostics.rejectedPairBalance += 1;
        }
        continue;
      }

      itineraryOptions.push({
        label: `${outboundOption.label} + ${returnOption.label}`,
        cashOutlay: roundCurrency(outboundOption.cashOutlay + returnOption.cashOutlay),
        effectiveCost: roundCurrency(outboundOption.effectiveCost + returnOption.effectiveCost),
        pointsUsed: outboundOption.pointsUsed + returnOption.pointsUsed,
        centsPerPoint: weightedCpp(outboundOption, returnOption),
        caveats: combineCaveats(outboundOption, returnOption),
        usage: combinedUsage,
        outboundOption,
        returnOption,
      });
    }
  }

  if (itineraryOptions.length === 0) {
    return null;
  }

  const bestPayment = itineraryOptions.sort((left, right) =>
    comparePayments(left, right, searchState.rankingFocus)
  )[0];
  const departurePenalty =
    searchState.timePreferenceMode === "soft"
      ? preferencePenalty(outbound.departure, searchState.departureTimePreference)
      : 0;
  const returnPenalty =
    searchState.timePreferenceMode === "soft"
      ? preferencePenalty(inbound.departure, searchState.returnTimePreference)
      : 0;
  const timePreferencePenalty = (departurePenalty + returnPenalty) * getTimePreferencePenaltyDollars(searchState);
  const airportAccess = buildItineraryAirportAccess(outbound, inbound, searchState);
  const valueBreakdown = buildValueBreakdown(bestPayment, timePreferencePenalty, airportAccess.groundTravelCost);
  const ticketing = buildTicketingMetadata(outbound, inbound);

  const itinerary = {
    outbound,
    inbound,
    passengerCount: getPassengerCount(searchState),
    bookingType: ticketing.type,
    bookingLabel: ticketing.label,
    ticketing,
    totalDurationMinutes: outbound.durationMinutes + inbound.durationMinutes,
    travelMetrics: buildItineraryTravelMetrics(outbound, inbound),
    airportAccess,
    riskFlags: buildItineraryRiskFlags(outbound, inbound, ticketing),
    qualityPenalty: null,
    stayNights: getStayNights(outbound.departure, inbound.departure),
    cashOutlay: bestPayment.cashOutlay,
    effectiveCost: valueBreakdown.effectiveCost,
    pointsUsed: bestPayment.pointsUsed,
    centsPerPoint: bestPayment.centsPerPoint,
    caveats: [...bestPayment.caveats, ...ticketing.caveats],
    usage: bestPayment.usage,
    balanceImpact: buildBalanceImpact(searchState.balances, bestPayment.usage),
    label: bestPayment.label,
    paymentBreakdown: [
      summarizePaymentOption(bestPayment.outboundOption),
      summarizePaymentOption(bestPayment.returnOption),
    ],
    valueBreakdown,
    explanation: buildExplanation(bestPayment, departurePenalty, returnPenalty, searchState.timePreferenceMode),
  };
  itinerary.qualityPenalty = roundCurrency(qualityPenalty(itinerary));
  return itinerary;
}

function buildBalanceImpact(balances, usage) {
  return ["amex", "chase", ...AIRLINE_PROGRAMS.map((program) => program.id)]
    .map((program) => {
      const startingBalance = balances[program] ?? 0;
      const used = usage[program] ?? 0;
      return {
        program,
        label: formatProgram(program),
        startingBalance,
        used,
        remaining: startingBalance - used,
      };
    })
    .filter((item) => item.startingBalance > 0 || item.used > 0);
}

function buildSegmentPaymentOptions(segment, searchState, direction, diagnostics) {
  const options = [];
  const passengerCount = getPassengerCount(searchState);
  const cashPrice = getReferenceCashPrice(segment, passengerCount);
  if (isCashBookable(segment) && cashPrice !== null) {
    options.push({
      direction,
      label: `${capitalize(direction)} cash`,
      program: "cash",
      referenceCashPrice: cashPrice,
      cashOutlay: cashPrice,
      pointOpportunityCost: 0,
      cashSavings: 0,
      effectiveCost: cashPrice,
      pointsUsed: 0,
      centsPerPoint: null,
      caveats: segment.providerCaveats ?? [],
      usage: {},
      awardMiles: 0,
    });
    options.push(...buildCardTravelRedemptionOptions({
      cashPrice,
      searchState,
      direction,
      caveats: segment.providerCaveats ?? [],
    }));
  }

  if (searchState.awardDataMode === "cash-only") {
    return options;
  }

  const allowedAwardPrograms = new Set(searchState.awardPrograms ?? []);
  for (const award of segment.awardOptions) {
    if (!allowedAwardPrograms.has(award.program)) {
      continue;
    }

    if (diagnostics) {
      diagnostics.awardOptionsEvaluated += 1;
    }

    const awardMiles = award.miles * passengerCount;
    const awardTaxes = roundCurrency(award.taxes * passengerCount);
    const airlineCpp = calculateValuePerPoint(cashPrice, awardTaxes, awardMiles);
      if (airlineCpp !== null && airlineCpp < searchState.thresholds.airline) {
      if (diagnostics) {
        diagnostics.rejectedAirlineCpp += 1;
        recordAwardRejection(diagnostics, {
          direction,
          program: award.program,
          reason: "poor-cpp",
          actualCpp: airlineCpp,
          thresholdCpp: searchState.thresholds.airline,
          requiredPoints: awardMiles,
          availablePoints: searchState.balances[award.program] ?? 0,
          dataStatus: getAwardDataStatus(segment),
        });
      }
      continue;
    }

    if ((searchState.balances[award.program] ?? 0) >= awardMiles) {
      if (diagnostics) {
        diagnostics.acceptedAirlineRedemptions += 1;
      }
      options.push({
        direction,
        label: `${capitalize(direction)} ${formatProgram(award.program)} balance`,
        program: award.program,
        referenceCashPrice: cashPrice,
        cashOutlay: awardTaxes,
        pointOpportunityCost: convertPointsToDollars(awardMiles, searchState.valuations.airline),
        cashSavings: calculateCashSavings(cashPrice, awardTaxes),
        effectiveCost: roundCurrency(
          awardTaxes + convertPointsToDollars(awardMiles, searchState.valuations.airline)
        ),
        pointsUsed: awardMiles,
        centsPerPoint: airlineCpp,
        caveats: [],
        usage: { [award.program]: awardMiles },
        awardMiles,
      });
    } else if (diagnostics) {
      diagnostics.rejectedAirlineBalance += 1;
      recordAwardRejection(diagnostics, {
        direction,
        program: award.program,
        reason: "insufficient-airline-balance",
        requiredPoints: awardMiles,
        availablePoints: searchState.balances[award.program] ?? 0,
        shortfall: awardMiles - (searchState.balances[award.program] ?? 0),
        dataStatus: getAwardDataStatus(segment),
      });
    }

    for (const [currency, partners] of Object.entries(PARTNER_MAP)) {
      if (!partners.includes(award.program)) {
        continue;
      }

      const transferRatio = getTransferRatio(searchState, currency, award.program);
      const requiredBankPoints = calculateRequiredTransferPoints(awardMiles, transferRatio);
      const bankCpp = calculateValuePerPoint(cashPrice, awardTaxes, requiredBankPoints);

      if (bankCpp !== null && bankCpp < searchState.thresholds[currency]) {
        if (diagnostics) {
          diagnostics.rejectedTransferCpp += 1;
          recordAwardRejection(diagnostics, {
            direction,
            program: award.program,
            sourceCurrency: currency,
            reason: "poor-transfer-cpp",
            actualCpp: bankCpp,
            thresholdCpp: searchState.thresholds[currency],
            requiredPoints: requiredBankPoints,
            availablePoints: searchState.balances[currency] ?? 0,
            dataStatus: getAwardDataStatus(segment),
          });
        }
        continue;
      }

      if ((searchState.balances[currency] ?? 0) < requiredBankPoints) {
        if (diagnostics) {
          diagnostics.rejectedTransferBalance += 1;
          recordAwardRejection(diagnostics, {
            direction,
            program: award.program,
            sourceCurrency: currency,
            reason: "insufficient-transfer-balance",
            requiredPoints: requiredBankPoints,
            availablePoints: searchState.balances[currency] ?? 0,
            shortfall: requiredBankPoints - (searchState.balances[currency] ?? 0),
            awardMiles,
            transferRatio,
            dataStatus: getAwardDataStatus(segment),
          });
        }
        continue;
      }

      if (diagnostics) {
        diagnostics.acceptedTransferOptions += 1;
      }
      options.push({
        direction,
        label: `${capitalize(direction)} transfer ${formatProgram(currency)} to ${formatProgram(
          award.program
        )}`,
        program: award.program,
        sourceCurrency: currency,
        transferRatio,
        referenceCashPrice: cashPrice,
        cashOutlay: awardTaxes,
        pointOpportunityCost: convertPointsToDollars(requiredBankPoints, searchState.valuations[currency]),
        cashSavings: calculateCashSavings(cashPrice, awardTaxes),
        effectiveCost: roundCurrency(
          awardTaxes + convertPointsToDollars(requiredBankPoints, searchState.valuations[currency])
        ),
        pointsUsed: requiredBankPoints,
        centsPerPoint: bankCpp,
        caveats: [TRANSFER_CONFIRMATION_CAVEAT],
        usage: { [currency]: requiredBankPoints },
        awardMiles,
      });
    }
  }

  return options;
}

function isCashBookable(segment) {
  return segment.cashAvailable !== false;
}

function buildCardTravelRedemptionOptions({ cashPrice, searchState, direction, caveats = [] }) {
  const options = [];
  for (const currency of ["amex", "chase"]) {
    const redemptionCpp = getCardTravelRedemptionCpp(searchState, currency);
    if (redemptionCpp <= 0) {
      continue;
    }

    const pointsNeeded = Math.ceil((cashPrice * 100) / redemptionCpp);
    const pointsUsed = Math.min(searchState.balances[currency] ?? 0, pointsNeeded);
    if (pointsUsed <= 0) {
      continue;
    }

    const coveredCash = (pointsUsed * redemptionCpp) / 100;
    const cashOutlay = roundCurrency(Math.max(cashPrice - coveredCash, 0));
    const pointOpportunityCost = convertPointsToDollars(pointsUsed, searchState.valuations[currency]);
    const effectiveCost = roundCurrency(cashOutlay + pointOpportunityCost);

    options.push({
      direction,
      label: `${capitalize(direction)} ${formatProgram(currency)} travel redemption`,
      program: currency,
      redemptionType: "card-travel",
      referenceCashPrice: cashPrice,
      cashOutlay,
      pointOpportunityCost,
      cashSavings: roundCurrency(cashPrice - cashOutlay),
      effectiveCost,
      pointsUsed,
      centsPerPoint: redemptionCpp,
      caveats,
      usage: { [currency]: pointsUsed },
      awardMiles: 0,
    });
  }

  return options;
}

function combineUsage(outboundOption, returnOption) {
  const combined = { ...outboundOption.usage };

  for (const [program, amount] of Object.entries(returnOption.usage)) {
    combined[program] = (combined[program] ?? 0) + amount;
  }

  return combined;
}

function combineCaveats(...options) {
  return [...new Set(options.flatMap((option) => option.caveats ?? []))];
}

function fitsBalances(usage, balances) {
  return Object.entries(usage).every(([program, amount]) => (balances[program] ?? 0) >= amount);
}

function buildItineraryAirportAccess(outbound, inbound, searchState) {
  const legs = [outbound, inbound].filter(Boolean).map((segment) => {
    const origin = getAirportAccess(segment.origin);
    const destination = getAirportAccess(segment.destination);
    return {
      direction: segment === outbound ? "outbound" : "return",
      origin,
      destination,
      groundTravelMinutes: origin.groundTravelMinutes + destination.groundTravelMinutes,
    };
  });
  const groundTravelMinutes = legs.reduce((sum, leg) => sum + leg.groundTravelMinutes, 0);
  const groundTravelCost = roundCurrency(
    (groundTravelMinutes / 60) * (searchState.nearbyAirportGroundCostPerHour ?? 20)
  );
  return { legs, groundTravelMinutes, groundTravelCost };
}

function buildValueBreakdown(payment, timePreferencePenalty, groundTravelCost = 0) {
  const paymentOptions = [payment.outboundOption, payment.returnOption].filter(Boolean);
  const referenceCashPrice = sumNullableCurrency(paymentOptions.map((option) => option.referenceCashPrice));
  const pointOpportunityCost = roundCurrency(
    paymentOptions.reduce((sum, option) => sum + option.pointOpportunityCost, 0)
  );
  const cashSavings = sumNullableCurrency(paymentOptions.map((option) => option.cashSavings));
  const paymentEffectiveCost = roundCurrency(payment.effectiveCost);

  return {
    referenceCashPrice,
    cashOutlay: payment.cashOutlay,
    pointOpportunityCost,
    cashSavings,
    paymentEffectiveCost,
    timePreferencePenalty: roundCurrency(timePreferencePenalty),
    groundTravelCost: roundCurrency(groundTravelCost),
    effectiveCost: roundCurrency(paymentEffectiveCost + timePreferencePenalty + groundTravelCost),
  };
}

function comparePayments(left, right, rankingFocus = "cash-first") {
  if (rankingFocus === "effective-cost") {
    return comparePaymentsByEffectiveCost(left, right);
  }

  if (left.cashOutlay !== right.cashOutlay) {
    return left.cashOutlay - right.cashOutlay;
  }

  if (left.effectiveCost !== right.effectiveCost) {
    return left.effectiveCost - right.effectiveCost;
  }

  return left.pointsUsed - right.pointsUsed;
}

function comparePaymentsByEffectiveCost(left, right) {
  if (left.effectiveCost !== right.effectiveCost) {
    return left.effectiveCost - right.effectiveCost;
  }

  if (left.cashOutlay !== right.cashOutlay) {
    return left.cashOutlay - right.cashOutlay;
  }

  return left.pointsUsed - right.pointsUsed;
}

function matchesTimePreference(isoDateTime, preference) {
  if (preference === "any") {
    return true;
  }

  const [startHour, endHour] = TIME_WINDOWS[preference];
  const hour = new Date(isoDateTime).getHours();
  return hour >= startHour && hour <= endHour;
}

function preferencePenalty(isoDateTime, preference) {
  return matchesTimePreference(isoDateTime, preference) ? 0 : 1;
}

function buildExplanation(payment, departurePenalty, returnPenalty, mode) {
  const preferenceNote =
    mode === "soft"
      ? departurePenalty || returnPenalty
        ? " Time preferences were treated as a soft penalty."
        : " Both flight times match your preferred windows."
      : " Time preferences were enforced as hard filters.";

  if (payment.pointsUsed === 0) {
    return `Cash wins on out-of-pocket ranking under your hard redemption rules.${preferenceNote}`;
  }

  if (payment.centsPerPoint === null) {
    return `This pairing stays inside your available balances; cpp is unavailable because no reference cash fare was provided.${preferenceNote}`;
  }

  return `This pairing stays inside your balances and minimum cpp thresholds while minimizing cash outlay.${preferenceNote}`;
}

function getStayNights(startIso, endIso) {
  const millisecondsPerNight = 1000 * 60 * 60 * 24;
  return Math.round((new Date(endIso) - new Date(startIso)) / millisecondsPerNight);
}

function weightedCpp(outboundOption, returnOption) {
  const options = [outboundOption, returnOption].filter((option) => option.centsPerPoint);
  if (options.length === 0) {
    return null;
  }

  const totalPoints = options.reduce((sum, option) => sum + option.pointsUsed, 0);
  const weightedValue = options.reduce((sum, option) => sum + option.centsPerPoint * option.pointsUsed, 0);
  return weightedValue / totalPoints;
}

function convertPointsToDollars(points, centsPerPoint) {
  return (points * centsPerPoint) / 100;
}

function calculateValuePerPoint(cashPrice, taxes, pointsUsed) {
  if (cashPrice === null || pointsUsed <= 0) {
    return null;
  }

  return ((cashPrice - taxes) / pointsUsed) * 100;
}

function getTransferRatio(searchState, currency, program) {
  return searchState.transferRatios?.[currency]?.[program] ?? 1;
}

function getCardTravelRedemptionCpp(searchState, currency) {
  return searchState.redemptionRates?.[`${currency}Travel`] ?? 0;
}

function calculateRequiredTransferPoints(airlineMilesNeeded, ratio) {
  return Math.ceil(airlineMilesNeeded / ratio);
}

function summarizePaymentOption(option) {
  return {
    direction: option.direction,
    label: option.label,
    program: option.program,
    sourceCurrency: option.sourceCurrency ?? null,
    redemptionType: option.redemptionType ?? null,
    cashOutlay: option.cashOutlay,
    referenceCashPrice: option.referenceCashPrice,
    pointOpportunityCost: roundCurrency(option.pointOpportunityCost ?? 0),
    cashSavings: option.cashSavings === null ? null : roundCurrency(option.cashSavings ?? 0),
    effectiveCost: option.effectiveCost,
    pointsUsed: option.pointsUsed,
    awardMiles: option.awardMiles ?? 0,
    centsPerPoint: option.centsPerPoint,
    transferRatio: option.transferRatio ?? null,
    caveats: option.caveats ?? [],
  };
}

function getTimePreferencePenaltyDollars(searchState) {
  return searchState.timePreferencePenaltyDollars ?? 18;
}

function getPassengerCount(searchState) {
  return searchState.passengers?.adults ?? 1;
}

function formatProgram(program) {
  return {
    amex: "Amex",
    chase: "Chase",
    cash: "Cash",
  }[program] ?? formatAirlineProgramName(program);
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function roundCurrency(amount) {
  return Math.round(amount * 100) / 100;
}

function getReferenceCashPrice(segment, passengerCount) {
  const price = Number(segment.cashPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  return roundCurrency(price * passengerCount);
}

function calculateCashSavings(cashPrice, awardTaxes) {
  if (cashPrice === null) {
    return null;
  }

  return roundCurrency(cashPrice - awardTaxes);
}

function sumNullableCurrency(values) {
  if (values.some((value) => value === null || value === undefined)) {
    return null;
  }

  return roundCurrency(values.reduce((sum, value) => sum + value, 0));
}

function incrementSegmentReject(diagnostics, direction, reason) {
  if (!diagnostics) {
    return;
  }

  diagnostics[`${direction}Rejected${reason}`] += 1;
}

function recordAwardCoverage(diagnostics, segments, programs) {
  for (const segment of segments) {
    for (const program of programs) {
      const coverage = diagnostics.awardProgramCoverage[program];
      if (!coverage) continue;
      const options = (segment.awardOptions ?? []).filter((award) => award.program === program);
      if (options.length === 0) continue;
      coverage.segments += 1;
      coverage.options += options.length;
      if (getAwardDataStatus(segment) === "cached") coverage.cachedSegments += 1;
    }
  }
}

function getAwardDataStatus(segment) {
  return segment.verification === "discovered_cached" || segment.awardOptions?.some((award) => award.verification === "discovered_cached")
    ? "cached"
    : "unknown-or-live";
}

function recordAwardRejection(diagnostics, record) {
  const key = [record.reason, record.sourceCurrency ?? "airline", record.program].join("|");
  const current = diagnostics.awardRejectionSummary[key] ?? {
    reason: record.reason,
    program: record.program,
    sourceCurrency: record.sourceCurrency ?? null,
    count: 0,
    examples: [],
  };
  current.count += 1;
  if (current.examples.length < 3) current.examples.push(record);
  diagnostics.awardRejectionSummary[key] = current;
  if (diagnostics.awardRejectionDetails.length < 50) {
    diagnostics.awardRejectionDetails.push(record);
  }
}

function buildItineraryTravelMetrics(outbound, inbound) {
  const legs = [outbound, inbound].filter(Boolean).map(buildSegmentTravelMetrics);
  const totalDurationMinutes = legs.reduce((sum, leg) => sum + (leg.durationMinutes ?? 0), 0);
  const knownAirMinutes = legs.every((leg) => leg.airMinutes !== null);
  const knownLayoverMinutes = legs.every((leg) => leg.layoverMinutes !== null);

  return {
    outbound: legs[0] ?? null,
    return: legs[1] ?? null,
    totalDurationMinutes,
    totalAirMinutes: knownAirMinutes ? legs.reduce((sum, leg) => sum + leg.airMinutes, 0) : null,
    totalLayoverMinutes: knownLayoverMinutes ? legs.reduce((sum, leg) => sum + leg.layoverMinutes, 0) : null,
    longestLayoverMinutes: knownLayoverMinutes
      ? Math.max(0, ...legs.flatMap((leg) => leg.layovers.map((layover) => layover.minutes)))
      : null,
    stops: legs.reduce((sum, leg) => sum + leg.stops, 0),
    overnight: legs.some((leg) => leg.overnight),
    arrivesNextDay: legs.some((leg) => leg.arrivesNextDay),
  };
}

function buildSegmentTravelMetrics(segment) {
  const flightSegments = Array.isArray(segment.flightSegments) ? segment.flightSegments : [];
  const durationMinutes = segment.durationMinutes ?? null;
  const stops = segment.stops ?? Math.max(flightSegments.length - 1, 0);

  if (flightSegments.length === 0) {
    return {
      durationMinutes,
      airMinutes: stops === 0 ? durationMinutes : null,
      layoverMinutes: stops === 0 ? 0 : null,
      longestLayoverMinutes: null,
      stops,
      layovers: [],
      overnight: datesCrossMidnight(segment.departure, segment.arrival),
      arrivesNextDay: datesCrossMidnight(segment.departure, segment.arrival),
    };
  }

  const airMinutes = sumFlightSegmentDurations(flightSegments);
  const layovers = [];
  for (let index = 1; index < flightSegments.length; index += 1) {
    const previous = flightSegments[index - 1];
    const current = flightSegments[index];
    const minutes = minutesBetween(previous.arrival, current.departure);
    if (minutes !== null) {
      layovers.push({
        minutes,
        overnight: datesCrossMidnight(previous.arrival, current.departure),
      });
    }
  }

  return {
    durationMinutes,
    airMinutes,
    layoverMinutes: layovers.reduce((sum, layover) => sum + layover.minutes, 0),
    longestLayoverMinutes: Math.max(0, ...layovers.map((layover) => layover.minutes)),
    stops,
    layovers,
    overnight: datesCrossMidnight(segment.departure, segment.arrival) || layovers.some((layover) => layover.overnight),
    arrivesNextDay: datesCrossMidnight(segment.departure, segment.arrival),
  };
}

function sumFlightSegmentDurations(flightSegments) {
  const durations = flightSegments.map((item) => minutesBetween(item.departure, item.arrival));
  return durations.every((duration) => duration !== null)
    ? durations.reduce((sum, duration) => sum + duration, 0)
    : null;
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  const minutes = Math.round((new Date(end) - new Date(start)) / (1000 * 60));
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function datesCrossMidnight(start, end) {
  if (!start || !end) return false;
  return new Date(end).toISOString().slice(0, 10) !== new Date(start).toISOString().slice(0, 10);
}

function buildTicketingMetadata(outbound, inbound) {
  if (!inbound) {
    return {
      type: "one-way-ticket",
      label: "One-way ticket",
      ticketCount: 1,
      reservationStatus: "unknown",
      connectionProtection: "not-applicable",
      baggageRules: "seller-dependent",
      changeRules: "seller-dependent",
      missedConnectionProtection: "not-applicable",
      caveats: [],
    };
  }

  if (outbound.airline === inbound.airline) {
    return {
      type: "same-airline-pairing",
      label: "Same-airline pairing; reservation unconfirmed",
      ticketCount: "unknown",
      reservationStatus: "unknown",
      connectionProtection: "unknown-until-booking",
      baggageRules: "may be shared if issued as one reservation",
      changeRules: "verify whether issued as one reservation",
      missedConnectionProtection: "unknown-until-booking",
      caveats: [
        "Same-airline pairing does not confirm a single reservation or protected connection; verify the seller issues one ticket.",
      ],
    };
  }

  return {
    type: "separate-one-way-tickets",
    label: "Separate one-way tickets likely",
    ticketCount: 2,
    reservationStatus: "likely-separate",
    connectionProtection: "not-protected-across-tickets",
    baggageRules: "may differ by ticket",
    changeRules: "may differ by ticket",
    missedConnectionProtection: "not-protected-across-tickets",
    caveats: [
      "Separate one-way tickets likely; baggage rules, change fees, and missed-connection protection may differ between tickets.",
    ],
  };
}

function buildItineraryRiskFlags(outbound, inbound, ticketing) {
  const metrics = buildItineraryTravelMetrics(outbound, inbound);
  const flags = [];
  if (metrics.longestLayoverMinutes !== null && metrics.longestLayoverMinutes >= 360) {
    flags.push("long-layover");
  }
  if (metrics.overnight) flags.push("overnight-travel");
  if (inbound && new Date(inbound.departure).getHours() < 7) flags.push("very-early-return");
  if (ticketing.type === "separate-one-way-tickets") {
    flags.push("separate-tickets-likely", "baggage-rules-may-differ", "change-rules-may-differ", "missed-connection-not-protected");
  }
  if (ticketing.type === "same-airline-pairing") flags.push("reservation-not-confirmed");
  return flags;
}

function qualityPenalty(itinerary) {
  const metrics = itinerary.travelMetrics ?? {};
  return (metrics.totalLayoverMinutes ?? 0) / 60 * 5
    + (metrics.overnight ? 25 : 0)
    + (itinerary.riskFlags?.includes("very-early-return") ? 15 : 0)
    + (itinerary.riskFlags?.includes("separate-tickets-likely") ? 25 : 0);
}

function buildDateMatrix(itineraries, rankingFocus) {
  const departureDates = [...new Set(itineraries.map((itinerary) => itinerary.outbound.departure.slice(0, 10)))].sort();
  const returnDates = [...new Set(itineraries.filter((itinerary) => itinerary.inbound).map((itinerary) => itinerary.inbound.departure.slice(0, 10)))].sort();
  const grouped = new Map();

  for (const itinerary of itineraries) {
    const departureDate = itinerary.outbound.departure.slice(0, 10);
    const returnDate = itinerary.inbound?.departure?.slice(0, 10) ?? null;
    const key = `${departureDate}|${returnDate}`;
    const current = grouped.get(key);
    if (!current || compareItineraries(itinerary, current, rankingFocus) < 0) {
      grouped.set(key, itinerary);
    }
  }

  const cells = [...grouped.entries()]
    .map(([key, itinerary]) => {
      const [departureDate, returnDate] = key.split("|");
      return {
        departureDate,
        returnDate,
        stayNights: itinerary.stayNights,
        cashOutlay: itinerary.cashOutlay,
        effectiveCost: itinerary.effectiveCost,
        totalDurationMinutes: itinerary.totalDurationMinutes,
        label: itinerary.label,
        bookingType: itinerary.bookingType,
        pointsUsed: itinerary.pointsUsed,
        cashSavings: itinerary.valueBreakdown?.cashSavings ?? 0,
        timePreferencePenalty: itinerary.valueBreakdown?.timePreferencePenalty ?? 0,
      };
    })
    .sort((left, right) => left.departureDate.localeCompare(right.departureDate) || String(left.returnDate ?? "").localeCompare(String(right.returnDate ?? "")));

  return {
    departureDates,
    returnDates,
    cells,
  };
}

function summarizeBestBy(itineraries, keySelector, rankingFocus) {
  const grouped = new Map();

  for (const itinerary of itineraries) {
    const key = keySelector(itinerary);
    const current = grouped.get(key);
    if (!current || compareItineraries(itinerary, current, rankingFocus) < 0) {
      grouped.set(key, itinerary);
    }
  }

  return [...grouped.entries()]
    .map(([key, itinerary]) => ({
      key,
      cashOutlay: itinerary.cashOutlay,
      effectiveCost: itinerary.effectiveCost,
      totalDurationMinutes: itinerary.totalDurationMinutes,
      label: itinerary.label,
      bookingType: itinerary.bookingType,
      pointsUsed: itinerary.pointsUsed,
      cashSavings: itinerary.valueBreakdown?.cashSavings ?? 0,
      timePreferencePenalty: itinerary.valueBreakdown?.timePreferencePenalty ?? 0,
    }))
    .sort((left, right) => compareItineraries(left, right, rankingFocus))
    .slice(0, 5);
}

function compareItineraries(left, right, rankingFocus = "cash-first") {
  if (rankingFocus === "effective-cost") {
    return compareByEffectiveCost(left, right);
  }

  if (rankingFocus === "fastest") {
    return compareByDuration(left, right);
  }

  return compareByCash(left, right);
}

function compareByCash(left, right) {
  if (left.cashOutlay !== right.cashOutlay) {
    return left.cashOutlay - right.cashOutlay;
  }

  if (left.effectiveCost !== right.effectiveCost) {
    return left.effectiveCost - right.effectiveCost;
  }

  return left.totalDurationMinutes - right.totalDurationMinutes;
}

function compareByEffectiveCost(left, right) {
  if (left.effectiveCost !== right.effectiveCost) {
    return left.effectiveCost - right.effectiveCost;
  }

  if (left.cashOutlay !== right.cashOutlay) {
    return left.cashOutlay - right.cashOutlay;
  }

  return left.totalDurationMinutes - right.totalDurationMinutes;
}

function compareByDuration(left, right) {
  if (left.totalDurationMinutes !== right.totalDurationMinutes) {
    return left.totalDurationMinutes - right.totalDurationMinutes;
  }

  if (left.cashOutlay !== right.cashOutlay) {
    return left.cashOutlay - right.cashOutlay;
  }

  return left.effectiveCost - right.effectiveCost;
}

function compareBySchedule(left, right) {
  const leftPenalty = qualityPenalty(left);
  const rightPenalty = qualityPenalty(right);
  if (leftPenalty !== rightPenalty) {
    return leftPenalty - rightPenalty;
  }

  if (left.totalDurationMinutes !== right.totalDurationMinutes) {
    return left.totalDurationMinutes - right.totalDurationMinutes;
  }

  return compareByEffectiveCost(left, right);
}

function compareByOverall(left, right) {
  const leftScore = left.effectiveCost + qualityPenalty(left);
  const rightScore = right.effectiveCost + qualityPenalty(right);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  return compareByEffectiveCost(left, right);
}

function selectBest(itineraries, comparator) {
  return itineraries.reduce((best, itinerary) => {
    if (!best || comparator(itinerary, best) < 0) return itinerary;
    return best;
  }, null);
}
