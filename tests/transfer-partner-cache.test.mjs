import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getTransferPartnerCache,
  parseOfficialTransferPage,
  refreshTransferPartnerCache,
  transferRatiosFromRecords,
} from "../transfer-partner-cache.mjs";

test("official transfer pages yield recognized ratios and normalized partner values", () => {
  const records = parseOfficialTransferPage(
    "chase",
    "<p>United MileagePlus 1 Ultimate Rewards point = 1 mile</p><p>Southwest 1:1</p>",
    "https://example.test/chase"
  );
  assert.deepEqual(records.map(({ destinationProgram, ratio }) => [destinationProgram, ratio]), [
    ["united", 1],
    ["southwest", 1],
  ]);
  assert.equal(transferRatiosFromRecords(records).chase.united, 1);
});

test("stale cache refreshes from official sources and persists the new timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flight-transfer-cache-"));
  const cachePath = join(directory, "transfer-partners.json");
  try {
    const result = await refreshTransferPartnerCache({
      cachePath,
      now: Date.parse("2026-09-15T00:00:00.000Z"),
      current: {
        schemaVersion: 1,
        fetchedAt: "2026-09-01T00:00:00.000Z",
        records: [],
      },
      fetchImpl: async (url) => ({
        ok: true,
        async text() {
          return url.includes("chase")
            ? "<p>United 1:1 Southwest 1:1 JetBlue 1:1</p>"
            : `name\\",\\"Delta SkyMiles\\",baseConversionRate\\",\\"1\\" name\\",\\"JetBlue Airways\\",baseConversionRate\\",\\"0.8\\"`;
        },
      }),
    });
    assert.equal(result.status, "refreshed");
    assert.equal(result.records.length, 5);
    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(persisted.fetchedAt, "2026-09-15T00:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed refresh preserves the old timestamp so the next search retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flight-transfer-cache-failed-"));
  const cachePath = join(directory, "transfer-partners.json");
  try {
    const result = await refreshTransferPartnerCache({
      cachePath,
      now: Date.parse("2026-09-15T00:00:00.000Z"),
      current: { schemaVersion: 1, fetchedAt: "2026-09-01T00:00:00.000Z", records: [] },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.equal(result.status, "stale-fallback");
    assert.equal(result.fetchedAt, "2026-09-01T00:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fresh cache avoids a network refresh", async () => {
  let calls = 0;
  const result = await getTransferPartnerCache({
    cachePath: join(process.cwd(), "data", "transfer-partners.json"),
    now: Date.parse("2026-09-16T00:00:00.000Z"),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("network should not be called for fresh data");
    },
  });
  assert.equal(result.status, "fresh");
  assert.equal(calls, 0);
});
