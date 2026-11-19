import test from "node:test";
import assert from "node:assert/strict";

import {
  PayloadError,
  addDeviceKey,
  appendHistory,
  buildDeviceRecord,
  constantTimeEqual,
  deriveStatusFromMetrics,
  inferHeartbeatIntervalSeconds,
  normalizePayload,
  summarize,
  withLiveness,
} from "../src/lib.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

test("normalizePayload cleans ids and keeps valid metrics", () => {
  const payload = normalizePayload(
    {
      hostname: "PC-01",
      id: "{ABC-123}",
      os: "Windows 11 Pro",
      metrics: {
        cpuPct: 42.36,
        memUsedPct: 70,
        uptimeHours: 12.5,
        disks: [{ name: "C:", usedPct: 72, freeGb: 56, totalGb: 200 }],
      },
      timestamp: "2026-01-01T00:00:00Z",
    },
    NOW,
  );

  assert.equal(payload.id, "abc-123");
  assert.equal(payload.hostname, "PC-01");
  assert.equal(payload.status, "ok");
  assert.equal(payload.metrics.cpuPct, 42.4);
  assert.equal(payload.metrics.disks[0].name, "C:");
  assert.equal(payload.timestamp, NOW.toISOString());
});

test("deriveStatusFromMetrics uses warning and critical thresholds", () => {
  assert.equal(deriveStatusFromMetrics({ cpuPct: 89, memUsedPct: 80, disks: [] }), "ok");
  assert.equal(deriveStatusFromMetrics({ cpuPct: 91, memUsedPct: 80, disks: [] }), "warning");
  assert.equal(deriveStatusFromMetrics({ memUsedPct: 97, disks: [] }), "critical");
  assert.equal(
    deriveStatusFromMetrics({ disks: [{ name: "D:", usedPct: 96 }] }),
    "critical",
  );
});

test("reported status cannot hide unhealthy metrics", () => {
  const payload = normalizePayload(
    {
      hostname: "PC-02",
      status: "ok",
      metrics: { cpuPct: 99, memUsedPct: 50 },
    },
    NOW,
  );
  assert.equal(payload.status, "critical");
  assert.match(payload.message, /CPU/);
});

test("normalizePayload rejects invalid hostname and arrays", () => {
  assert.throws(() => normalizePayload({ hostname: "bad host!" }, NOW), PayloadError);
  assert.throws(() => normalizePayload([], NOW), PayloadError);
});

test("buildDeviceRecord uses server receive time for freshness", () => {
  const first = normalizePayload(
    { hostname: "PC-03", metrics: { cpuPct: 10 }, timestamp: "2020-01-01T00:00:00.000Z" },
    NOW,
  );
  const existing = buildDeviceRecord(first, null, { now: NOW, historyLimit: 2 });

  assert.equal(existing.lastSeen, NOW.toISOString());
  assert.equal(existing.receivedAt, NOW.toISOString());
  assert.equal(existing.history[0].at, first.timestamp);
  assert.equal(existing.history[0].receivedAt, NOW.toISOString());
  const second = normalizePayload(
    { hostname: "PC-03", metrics: { cpuPct: 20 } },
    new Date("2026-01-01T00:05:00.000Z"),
  );
  const updated = buildDeviceRecord(second, existing, {
    now: new Date("2026-01-01T00:05:00.000Z"),
    historyLimit: 2,
  });

  assert.equal(updated.history.length, 2);
  assert.deepEqual(
    updated.history.map((item) => item.cpuPct),
    [10, 20],
  );
  assert.equal(appendHistory(updated.history, { status: "ok" }, 1).length, 1);
});

test("inferHeartbeatIntervalSeconds uses the median observed gap", () => {
  assert.equal(inferHeartbeatIntervalSeconds(null), 10);
  assert.equal(
    inferHeartbeatIntervalSeconds([
      { at: "2026-01-01T00:00:00.000Z" },
      { at: "2026-01-01T00:00:10.000Z" },
      { at: "2026-01-01T00:00:21.000Z" },
      { at: "2026-01-01T02:00:00.000Z" },
    ]),
    10,
  );
});

test("withLiveness marks devices offline after three missed heartbeats", () => {
  const history = [
    { receivedAt: "2026-01-01T00:00:00.000Z" },
    { receivedAt: "2026-01-01T00:00:10.000Z" },
    { receivedAt: "2026-01-01T00:00:20.000Z" },
  ];
  const device = {
    status: "warning",
    message: "CPU 91% (เกณฑ์ 90%)",
    reasons: ["CPU 91% (เกณฑ์ 90%)"],
    lastSeen: "2026-01-01T00:00:20.000Z",
    history,
  };
  const fresh = withLiveness(device, new Date("2026-01-01T00:00:40.000Z"), 300);
  const stale = withLiveness(device, new Date("2026-01-01T00:01:00.000Z"), 300);

  assert.equal(fresh.status, "warning");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.offlineAfterSeconds, 30);
  assert.equal(fresh.message, device.message);

  assert.equal(stale.status, "offline");
  assert.equal(stale.stale, true);
  assert.equal(stale.ageSeconds, 40);
  assert.deepEqual(stale.reasons, []);
  assert.match(stale.message, /ไม่ได้รับข้อมูลจาก agent นาน 40 วินาที/);
});

test("withLiveness respects a slow agent cadence up to the configured cap", () => {
  const history = [
    { receivedAt: "2026-01-01T00:00:00.000Z" },
    { receivedAt: "2026-01-01T00:02:00.000Z" },
  ];
  const device = { status: "ok", lastSeen: "2026-01-01T00:02:00.000Z", history };

  assert.equal(withLiveness(device, new Date("2026-01-01T00:04:00.000Z"), 300).stale, false);
  assert.equal(withLiveness(device, new Date("2026-01-01T00:07:01.000Z"), 300).status, "offline");
  assert.equal(withLiveness(device, new Date("2026-01-01T00:07:01.000Z"), 300).offlineAfterSeconds, 300);
});

test("summarize counts each status", () => {
  assert.deepEqual(
    summarize([{ status: "ok" }, { status: "ok" }, { status: "warning" }, { status: "offline" }]),
    { total: 4, ok: 2, warning: 1, critical: 0, offline: 1 },
  );
});

test("constantTimeEqual compares values", () => {
  assert.equal(constantTimeEqual("token", "token"), true);
  assert.equal(constantTimeEqual("token", "toker"), false);
  assert.equal(constantTimeEqual("token", "token-longer"), false);
  assert.equal(constantTimeEqual(null, "token"), false);
});

test("addDeviceKey keeps a unique, valid device index", () => {
  assert.deepEqual(addDeviceKey(null, "device:PC-1"), ["device:PC-1"]);
  assert.deepEqual(
    addDeviceKey(["device:PC-1", "", null, "device:PC-2"], "device:PC-1"),
    ["device:PC-1", "device:PC-2"],
  );
  assert.deepEqual(addDeviceKey(["device:PC-1"], "device:PC-2"), [
    "device:PC-1",
    "device:PC-2",
  ]);
});
