import {
  DEVICE_KEY_PREFIX,
  PayloadError,
  SEVERITY,
  buildDeviceRecord,
  constantTimeEqual,
  normalizePayload,
  positiveInt,
  summarize,
  withLiveness,
} from "./lib.js";

const MAX_BODY_BYTES = 32 * 1024;
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};

const DEFAULT_BOOTSTRAP_URL =
  "https://raw.githubusercontent.com/apichatpunkaew-mfec/StatusHealth/main/windows/bootstrap.ps1";

function applyHeaders(headers, extra = {}) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = applyHeaders(new Headers(), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function failure(status, error, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractToken(request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim();
  return (request.headers.get("X-Health-Token") ?? "").trim();
}

async function authorize(request, env) {
  const expected = env.HEALTH_TOKEN;
  if (!expected) return { valid: false, reason: "missing_secret" };
  const supplied = extractToken(request);
  if (!supplied) return { valid: false, reason: "missing_token" };
  const [suppliedHash, expectedHash] = await Promise.all([sha256Hex(supplied), sha256Hex(expected)]);
  return constantTimeEqual(suppliedHash, expectedHash)
    ? { valid: true }
    : { valid: false, reason: "invalid_token" };
}

function readConfig(env) {
  return {
    staleAfter: positiveInt(env.STALE_AFTER_SECONDS, 300, { min: 30, max: 86_400 }),
    historyLimit: positiveInt(env.HISTORY_LIMIT, 30, { min: 1, max: 200 }),
    deviceTtl: positiveInt(env.DEVICE_TTL_SECONDS, 2_592_000, { min: 60, max: 31_536_000 }),
  };
}

async function handleHealthPost(request, env, config) {
  const auth = await authorize(request, env);
  if (auth.reason === "missing_secret") {
    return failure(503, "SERVER_TOKEN_NOT_CONFIGURED", {
      detail: "Run: npx wrangler secret put HEALTH_TOKEN",
    });
  }
  if (!auth.valid) return failure(401, "UNAUTHORIZED");

  if (!env.HEALTH_KV) return failure(500, "KV_BINDING_MISSING");

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return failure(413, "PAYLOAD_TOO_LARGE");
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return failure(413, "PAYLOAD_TOO_LARGE");
  }

  let rawBody;
  try {
    rawBody = JSON.parse(bodyText);
  } catch {
    return failure(400, "INVALID_JSON");
  }

  let payload;
  try {
    payload = normalizePayload(rawBody, new Date());
  } catch (error) {
    if (error instanceof PayloadError) return failure(400, "INVALID_PAYLOAD", { detail: error.message });
    throw error;
  }

  const key = `${DEVICE_KEY_PREFIX}${payload.id}`;
  const stored = await env.HEALTH_KV.get(key, "json");
  const existing = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : null;
  const record = buildDeviceRecord(payload, existing, { historyLimit: config.historyLimit });

  await env.HEALTH_KV.put(key, JSON.stringify(record), {
    expirationTtl: config.deviceTtl,
    metadata: { hostname: record.hostname, status: record.status },
  });

  return json(
    { ok: true, id: record.id, status: record.status, receivedAt: record.receivedAt },
    201,
  );
}

async function listDevices(env, config) {
  const keys = [];
  let cursor = null;
  let pages = 0;

  do {
    const options = { prefix: DEVICE_KEY_PREFIX, limit: 100 };
    if (cursor) options.cursor = cursor;
    const page = await env.HEALTH_KV.list(options);
    keys.push(...page.keys.map((item) => item.name));
    pages += 1;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && pages < 10);

  if (keys.length === 0) return [];

  const values = await env.HEALTH_KV.get(keys, "json");
  const now = new Date();
  const devices = [];

  for (const [key, value] of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    devices.push(
      withLiveness(
        { ...value, id: value.id ?? key.slice(DEVICE_KEY_PREFIX.length) },
        now,
        config.staleAfter,
      ),
    );
  }

  devices.sort(
    (left, right) =>
      (SEVERITY[right.status] ?? 0) - (SEVERITY[left.status] ?? 0) ||
      Date.parse(right.lastSeen ?? 0) - Date.parse(left.lastSeen ?? 0),
  );

  return devices;
}

async function serveBootstrap(env, method) {
  const url = env.AGENT_BOOTSTRAP_URL || DEFAULT_BOOTSTRAP_URL;
  const upstream = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!upstream.ok) {
    return failure(502, "BOOTSTRAP_UNAVAILABLE", { detail: `upstream status ${upstream.status}` });
  }

  const headers = applyHeaders(new Headers(), {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": 'attachment; filename="bootstrap.ps1"',
    "Cache-Control": "public, max-age=300",
  });
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(upstream.body, { status: 200, headers });
}

function serveAsset(request, env) {
  if (!env.ASSETS) return failure(500, "ASSETS_BINDING_MISSING");
  return env.ASSETS.fetch(request).then((response) => {
    const headers = applyHeaders(new Headers(response.headers));
    const pathname = new URL(request.url).pathname;
    if (pathname === "/" || pathname === "/index.html") {
      headers.set("Cache-Control", "no-cache");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const config = readConfig(env);

    try {
      if (url.pathname === "/api/ping") {
        if (request.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
        return json({ ok: true, service: "pc-health-dashboard", time: new Date().toISOString() });
      }

      if (url.pathname === "/api/health") {
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: applyHeaders(new Headers(), { Allow: "POST, OPTIONS" }),
          });
        }
        if (request.method !== "POST") {
          return failure(405, "METHOD_NOT_ALLOWED", { Allow: "POST, OPTIONS" });
        }
        if (!env.HEALTH_KV) return failure(500, "KV_BINDING_MISSING");
        return await handleHealthPost(request, env, config);
      }

      if (url.pathname === "/api/devices") {
        if (request.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
        if (!env.HEALTH_KV) return failure(500, "KV_BINDING_MISSING");
        const devices = await listDevices(env, config);
        return json({
          ok: true,
          generatedAt: new Date().toISOString(),
          staleAfterSeconds: config.staleAfter,
          summary: summarize(devices),
          devices,
        });
      }

      if (url.pathname === "/agent/bootstrap.ps1") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return failure(405, "METHOD_NOT_ALLOWED", { Allow: "GET, HEAD" });
        }
        return await serveBootstrap(env, request.method);
      }

      if (url.pathname.startsWith("/api/")) return failure(404, "NOT_FOUND");

      return await serveAsset(request, env);
    } catch (error) {
      console.error("worker error", error);
      return failure(500, "INTERNAL_ERROR", { detail: error?.message ?? String(error) });
    }
  },
};
