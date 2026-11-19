export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadError";
  }
}

export const DEVICE_KEY_PREFIX = "device:";
export const DEVICE_INDEX_KEY = "devices:index";
export const STATUSES = ["ok", "warning", "critical", "offline"];

export function addDeviceKey(index, key) {
  const keys = Array.isArray(index)
    ? index.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  return keys.includes(key) ? keys : [...keys, key];
}
export const SEVERITY = { ok: 0, offline: 1, warning: 2, critical: 3 };

export const THRESHOLDS = {
  cpu: { warning: 90, critical: 98 },
  mem: { warning: 90, critical: 97 },
  disk: { warning: 85, critical: 95 },
};

const STATUS_ALIASES = {
  ok: "ok",
  healthy: "ok",
  up: "ok",
  warning: "warning",
  degraded: "warning",
  warn: "warning",
  critical: "critical",
  down: "critical",
  error: "critical",
};

const round1 = (value) =>
  value === null || value === undefined ? null : Math.round(value * 10) / 10;

export function positiveInt(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeText(value, maxLength = 128, field = "field") {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new PayloadError(`${field} ต้องเป็นข้อความ`);
  }
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > maxLength) {
    throw new PayloadError(`${field} ยาวเกิน ${maxLength} ตัวอักษร`);
  }
  return cleaned;
}

export function normalizeHostname(value) {
  const hostname = normalizeText(value, 128, "hostname");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostname)) {
    throw new PayloadError("hostname มีอักขระที่ไม่อนุญาต");
  }
  return hostname;
}

export function normalizeId(value) {
  const cleaned = normalizeText(value, 128, "id")
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned || null;
}

export function finiteNumber(value, { min = 0, max = 100, field = "value" } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new PayloadError(`${field} ต้องเป็นตัวเลข`);
  }
  return round1(Math.min(max, Math.max(min, number)));
}

export function parseIso(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function normalizeDisks(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new PayloadError("metrics.disks ต้องเป็น array");

  return input.slice(0, 12).map((disk, index) => {
    if (!disk || typeof disk !== "object" || Array.isArray(disk)) {
      throw new PayloadError(`disks[${index}] ต้องเป็น object`);
    }
    const name = normalizeText(disk.name ?? disk.letter ?? `DISK${index + 1}`, 32, `disks[${index}].name`);
    let usedPct = finiteNumber(disk.usedPct, { field: `disks[${index}].usedPct` });
    if (usedPct === null && disk.freePct !== undefined) {
      const freePct = finiteNumber(disk.freePct, { field: `disks[${index}].freePct` });
      if (freePct !== null) usedPct = round1(Math.max(0, 100 - freePct));
    }
    return {
      name,
      usedPct,
      freeGb: finiteNumber(disk.freeGb, { min: 0, max: 1e7, field: `disks[${index}].freeGb` }),
      totalGb: finiteNumber(disk.totalGb, { min: 0, max: 1e7, field: `disks[${index}].totalGb` }),
    };
  });
}

export function evaluateMetrics(metrics = {}) {
  let status = "ok";
  const reasons = [];

  const consider = (value, group, label) => {
    if (value === null || value === undefined) return;
    const thresholds = THRESHOLDS[group];
    const level =
      value >= thresholds.critical ? "critical" : value >= thresholds.warning ? "warning" : "ok";
    if (SEVERITY[level] > SEVERITY[status]) status = level;
    if (level !== "ok") reasons.push(`${label} ${value}% (เกณฑ์ ${thresholds[level]}%)`);
  };

  consider(metrics.cpuPct, "cpu", "CPU");
  consider(metrics.memUsedPct, "mem", "Memory");
  for (const disk of Array.isArray(metrics.disks) ? metrics.disks : []) {
    consider(disk?.usedPct, "disk", `Disk ${disk?.name ?? "-"}`);
  }

  return { status, reasons: reasons.slice(0, 5) };
}

export function deriveStatusFromMetrics(metrics = {}) {
  return evaluateMetrics(metrics).status;
}

export function worstStatus(...statuses) {
  return statuses.reduce(
    (worst, status) =>
      SEVERITY[status] !== undefined && SEVERITY[status] > SEVERITY[worst] ? status : worst,
    "ok",
  );
}

export function normalizePayload(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PayloadError("Body ต้องเป็น JSON object");
  }

  const hostname = normalizeHostname(raw.hostname);
  const id = normalizeId(raw.id ?? raw.machineId) ?? normalizeId(hostname);
  const metricsInput =
    raw.metrics && typeof raw.metrics === "object" && !Array.isArray(raw.metrics) ? raw.metrics : {};

  const metrics = {
    cpuPct: finiteNumber(metricsInput.cpuPct, { field: "metrics.cpuPct" }),
    memUsedPct: finiteNumber(metricsInput.memUsedPct, { field: "metrics.memUsedPct" }),
    uptimeHours: finiteNumber(metricsInput.uptimeHours, {
      min: 0,
      max: 1_000_000,
      field: "metrics.uptimeHours",
    }),
    disks: normalizeDisks(metricsInput.disks),
  };

  const reportedRaw = normalizeText(raw.status, 16, "status").toLowerCase();
  const reported = STATUS_ALIASES[reportedRaw] ?? "ok";
  const evaluated = evaluateMetrics(metrics);
  const status = worstStatus(reported, evaluated.status);
  const reasonText = normalizeText(raw.message, 240, "message");
  const reasons = evaluated.reasons.length ? evaluated.reasons : reasonText ? [reasonText] : [];

  return {
    id,
    hostname,
    displayName: normalizeText(raw.displayName, 128, "displayName") || hostname,
    os: normalizeText(raw.os, 128, "os"),
    user: normalizeText(raw.user, 128, "user"),
    ip: normalizeText(raw.ip, 64, "ip"),
    status,
    message: reasons.join("; "),
    metrics,
    reasons,
    timestamp: parseIso(raw.timestamp, now.toISOString()),
  };
}

export function appendHistory(history, sample, limit = 30) {
  const max = Math.min(200, Math.max(1, Number(limit) || 30));
  const previous = Array.isArray(history)
    ? history.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
  return [...previous, sample].slice(-max);
}

export function buildDeviceRecord(payload, existing = null, { now = new Date(), historyLimit = 30 } = {}) {
  const sample = {
    at: payload.timestamp,
    status: payload.status,
    cpuPct: payload.metrics.cpuPct,
    memUsedPct: payload.metrics.memUsedPct,
  };

  return {
    id: payload.id,
    hostname: payload.hostname,
    displayName: payload.displayName || payload.hostname,
    os: payload.os || existing?.os || "",
    user: payload.user || existing?.user || "",
    ip: payload.ip || existing?.ip || "",
    status: payload.status,
    message: payload.message || "",
    reasons: payload.reasons || [],
    metrics: payload.metrics,
    lastSeen: payload.timestamp,
    receivedAt: now.toISOString(),
    history: appendHistory(existing?.history, sample, historyLimit),
  };
}

export function withLiveness(device, now = new Date(), staleAfterSeconds = 300) {
  const seenAt = Date.parse(device?.lastSeen ?? "");
  const ageSeconds = Number.isFinite(seenAt)
    ? Math.max(0, Math.floor((now.getTime() - seenAt) / 1000))
    : null;
  const stale = ageSeconds === null || ageSeconds > staleAfterSeconds;
  return {
    ...device,
    status: stale ? "offline" : device?.status,
    stale,
    ageSeconds,
  };
}

export function summarize(devices) {
  const summary = { total: devices.length, ok: 0, warning: 0, critical: 0, offline: 0 };
  for (const device of devices) {
    if (summary[device.status] !== undefined) summary[device.status] += 1;
  }
  return summary;
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = index < a.length ? a.charCodeAt(index) : 0;
    const right = index < b.length ? b.charCodeAt(index) : 0;
    mismatch |= left ^ right;
  }
  return mismatch === 0;
}
