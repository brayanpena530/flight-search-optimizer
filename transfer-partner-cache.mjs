import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSFER_PARTNERS } from "./search-config.mjs";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
export const TRANSFER_CACHE_PATH = join(ROOT_DIR, "data", "transfer-partners.json");
export const TRANSFER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const OFFICIAL_TRANSFER_SOURCES = {
  amex: {
    url: "https://global.americanexpress.com/rewards/transfer",
    sourceType: "official-public-transfer-portal",
  },
  chase: {
    url: "https://www.chase.com/sapphire-cards/personal/preferred",
    sourceType: "official-public-card-page",
    cardProduct: "Chase Sapphire Preferred",
  },
};

let memoryCache = null;
let refreshPromise = null;

export async function getTransferPartnerCache(options = {}) {
  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? TRANSFER_CACHE_PATH;
  const current = memoryCache?.cachePath === cachePath
    ? memoryCache.value
    : await readCache(cachePath);

  if (current && isFresh(current, now) && !options.force) {
    memoryCache = { cachePath, value: current };
    return { ...current, status: "fresh", warnings: [] };
  }

  if (refreshPromise && memoryCache?.cachePath === cachePath) {
    return refreshPromise;
  }

  refreshPromise = refreshTransferPartnerCache({ ...options, cachePath, current, now });
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function refreshTransferPartnerCache({
  cachePath = TRANSFER_CACHE_PATH,
  current = null,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const cached = current ?? await readCache(cachePath);
  const warnings = [];
  const fetched = [];

  if (typeof fetchImpl !== "function") {
    warnings.push("Official transfer-partner refresh is unavailable because fetch is not configured.");
  } else {
    const results = await Promise.all(Object.entries(OFFICIAL_TRANSFER_SOURCES).map(async ([currency, source]) => {
      try {
        const response = await fetchImpl(source.url, {
          headers: { accept: "text/html,application/xhtml+xml" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        const records = parseOfficialTransferPage(currency, html, source);
        if (!records.length) throw new Error("no confidently recognized transfer ratios");
        return records;
      } catch (error) {
        warnings.push(`${currency.toUpperCase()} transfer data refresh failed: ${error.message}`);
        return [];
      }
    }));
    fetched.push(...results.flat());
  }

  const records = mergeRecords(cached?.records ?? [], fetched);
  const value = {
    schemaVersion: 1,
    // A failed refresh must remain stale so the next search retries it.
    fetchedAt: fetched.length ? new Date(now).toISOString() : (cached?.fetchedAt ?? new Date(now).toISOString()),
    records,
  };
  try {
    await writeFile(cachePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    warnings.push(`Transfer-partner cache could not be written: ${error.message}`);
  }
  memoryCache = { cachePath, value };
  return {
    ...value,
    status: fetched.length ? "refreshed" : "stale-fallback",
    warnings: fetched.length ? warnings : [...warnings, "Using the last known transfer ratios; official sources did not yield usable data."],
  };
}

export function transferRatiosFromRecords(records = []) {
  return Object.fromEntries(Object.entries(TRANSFER_PARTNERS).map(([currency, partners]) => [
    currency,
    Object.fromEntries(partners.map((program) => [
      program,
      Number(records.find((record) => record.sourceCurrency === currency && record.destinationProgram === program)?.ratio ?? 1),
    ])),
  ]));
}

export function parseOfficialTransferPage(currency, html, source) {
  if (currency === "amex") return parseAmexTransferPortal(html, source);
  const text = String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const records = [];
  const chaseUsesOneToOneDefault = currency === "chase" && /most travel partners[\s\S]{0,120}1:1/i.test(text);
  for (const program of TRANSFER_PARTNERS[currency] ?? []) {
    const aliases = program === "jetblue" ? ["JetBlue", "TrueBlue"] : [program[0].toUpperCase() + program.slice(1)];
    if (chaseUsesOneToOneDefault && aliases.some((alias) => text.toLowerCase().includes(alias.toLowerCase()))) {
      records.push({ sourceCurrency: currency, destinationProgram: program, ratio: 1, sourceUrl: source.url, sourceType: source.sourceType, cardProduct: source.cardProduct });
      continue;
    }
    const match = aliases.map((alias) => {
      const index = text.toLowerCase().indexOf(alias.toLowerCase());
      return index < 0 ? null : text.slice(Math.max(0, index - 300), index + 500);
    }).find(Boolean);
    const ratio = match && extractRatio(match);
    if (ratio) records.push({ sourceCurrency: currency, destinationProgram: program, ratio, sourceUrl: source.url, sourceType: source.sourceType, cardProduct: source.cardProduct });
  }
  return records;
}

function parseAmexTransferPortal(html, source) {
  const raw = String(html ?? "");
  const records = [];
  const aliases = {
    delta: ["Delta SkyMiles"],
    jetblue: ["JetBlue Airways", "JetBlue TrueBlue"],
  };
  for (const [program, names] of Object.entries(aliases)) {
    const index = names.map((name) => raw.toLowerCase().indexOf(name.toLowerCase())).find((value) => value >= 0);
    if (index < 0) continue;
    const window = raw.slice(index, index + 16_000);
    const match = window.match(/baseConversionRate\\",\\"(\d+(?:\.\d+)?)\\"/i);
    if (!match) continue;
    records.push({
      sourceCurrency: "amex",
      destinationProgram: program,
      ratio: Number(match[1]),
      sourceUrl: source.url,
      sourceType: source.sourceType,
    });
  }
  return records;
}

function extractRatio(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:points?|membership rewards|ultimate rewards)?\s*(?:to|=|:)\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const ratio = Number(match[2]) / Number(match[1]);
  return ratio > 0 && ratio <= 10 ? ratio : null;
}

function mergeRecords(existing, fresh) {
  const merged = new Map(existing.map((record) => [`${record.sourceCurrency}:${record.destinationProgram}`, record]));
  for (const record of fresh) merged.set(`${record.sourceCurrency}:${record.destinationProgram}`, record);
  return [...merged.values()];
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function isFresh(cache, now) {
  const fetchedAt = Date.parse(cache?.fetchedAt ?? "");
  return Number.isFinite(fetchedAt) && now - fetchedAt < TRANSFER_CACHE_TTL_MS;
}
