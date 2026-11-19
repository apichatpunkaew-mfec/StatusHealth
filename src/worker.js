import {
  DEVICE_INDEX_KEY,
  DEVICE_KEY_PREFIX,
  PayloadError,
  SEVERITY,
  addDeviceKey,
  buildDeviceRecord,
  constantTimeEqual,
  normalizePayload,
  positiveInt,
  summarize,
  withLiveness,
} from "./lib.js";
import {
  AuthError,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  deleteUser,
  findUserByUsername,
  getSession,
  getUser,
  getUserIndex,
  hashPassword,
  isAdmin,
  normalizeDisplayName,
  normalizeRole,
  normalizeUsername,
  parseCookies,
  publicUser,
  putUser,
  putUserIndex,
  serializeSessionCookie,
  validatePassword,
  verifyPassword,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./auth.js";

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
      detail: "Set HEALTH_TOKEN in Cloudflare Dashboard: Workers & Pages > pc-health-dashboard > Settings > Variables",
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

  const storedIndex = await env.HEALTH_KV.get(DEVICE_INDEX_KEY, "json");
  const currentIndex = Array.isArray(storedIndex) ? storedIndex : [];
  const nextIndex = addDeviceKey(currentIndex, key);
  if (nextIndex.length !== currentIndex.length) {
    await env.HEALTH_KV.put(DEVICE_INDEX_KEY, JSON.stringify(nextIndex));
  }

  return json(
    { ok: true, id: record.id, status: record.status, receivedAt: record.receivedAt },
    201,
  );
}

async function listDevices(env, config) {
  const storedIndex = await env.HEALTH_KV.get(DEVICE_INDEX_KEY, "json");
  const keys = Array.isArray(storedIndex)
    ? storedIndex.filter(
        (key) => typeof key === "string" && key.startsWith(DEVICE_KEY_PREFIX),
      )
    : [];
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

async function authContext(request, env) {
  if (!env.HEALTH_KV) return { user: null, token: null, session: null };
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  const session = await getSession(env.HEALTH_KV, token);
  if (!session) return { user: null, token: null, session: null };
  const user = session.user && typeof session.user === "object"
    ? session.user
    : await getUser(env.HEALTH_KV, session.userId);
  if (!user || user.disabled) return { user: null, token, session: null };
  return { user, token, session };
}

async function requireAuth(request, env, { admin = false } = {}) {
  const context = await authContext(request, env);
  if (!context.user) return { ...context, response: failure(401, "LOGIN_REQUIRED") };
  if (admin && !isAdmin(context.user)) return { ...context, response: failure(403, "FORBIDDEN") };
  return { ...context, response: null };
}

function redirectTo(pathname, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: applyHeaders(new Headers(), { Location: pathname, ...headers }),
  });
}

function attachSession(response, session, url) {
  response.headers.append(
    "Set-Cookie",
    serializeSessionCookie(session.token, { secure: url.protocol === "https:" }),
  );
  return response;
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new AuthError("ข้อมูลใหญ่เกินไป");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new AuthError("ข้อมูลใหญ่เกินไป");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AuthError("JSON ไม่ถูกต้อง");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError("body ต้องเป็น object");
  }
  return value;
}

async function buildUserRecord(body, { role = "viewer", actor = null } = {}) {
  const username = normalizeUsername(body.username);
  const password = validatePassword(body.password);
  const record = {
    id: crypto.randomUUID(),
    username,
    displayName: normalizeDisplayName(body.displayName, username),
    role: normalizeRole(role),
    disabled: false,
    createdAt: new Date().toISOString(),
    createdBy: actor?.id ?? "setup",
    ...(await hashPassword(password)),
  };
  return record;
}

async function saveNewUser(kv, record) {
  const index = await getUserIndex(kv);
  if (index.some((item) => item?.username === record.username)) {
    throw new AuthError("username นี้มีอยู่แล้ว");
  }
  await putUser(kv, record);
  await putUserIndex(kv, [...index, publicUser(record)]);
}

function serveAsset(request, env) {
  if (!env.ASSETS) return failure(500, "ASSETS_BINDING_MISSING");
  return env.ASSETS.fetch(request).then((response) => {
    const headers = applyHeaders(new Headers(response.headers));
    const pathname = new URL(request.url).pathname;
    if (["/", "/index.html", "/login", "/login.html"].includes(pathname)) {
      headers.set("Cache-Control", "no-cache");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

async function handleAuthRoute(url, request, env) {
  if (!env.HEALTH_KV) return failure(500, "KV_BINDING_MISSING");
  const kv = env.HEALTH_KV;
  const path = url.pathname;

  try {
    if (path === "/api/auth/status" && request.method === "GET") {
      const index = await getUserIndex(kv);
      const context = await authContext(request, env);
      return json({
        ok: true,
        hasUsers: index.length > 0,
        authenticated: Boolean(context.user),
        user: publicUser(context.user),
      });
    }

    if (path === "/api/auth/setup" && request.method === "POST") {
      const index = await getUserIndex(kv);
      if (index.length > 0) return failure(409, "SETUP_CLOSED");
      const body = await readJsonBody(request);
      const record = await buildUserRecord(body, { role: "admin" });
      await saveNewUser(kv, record);
      const session = await createSession(kv, record);
      return attachSession(json({ ok: true, user: publicUser(record) }, 201), session, url);
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      const body = await readJsonBody(request);
      const username = normalizeUsername(body.username);
      const user = await findUserByUsername(kv, username);
      if (!user || user.disabled || !(await verifyPassword(body.password, user))) {
        return failure(401, "INVALID_CREDENTIALS");
      }
      const session = await createSession(kv, user);
      return attachSession(json({ ok: true, user: publicUser(user) }), session, url);
    }

    if (path === "/api/auth/logout" && request.method === "POST") {
      const context = await authContext(request, env);
      if (context.token) await deleteSession(kv, context.token);
      const response = json({ ok: true });
      response.headers.append("Set-Cookie", clearSessionCookie({ secure: url.protocol === "https:" }));
      return response;
    }

    if (path === "/api/auth/me" && request.method === "GET") {
      const context = await authContext(request, env);
      if (!context.user) return failure(401, "LOGIN_REQUIRED");
      return json({ ok: true, user: publicUser(context.user) });
    }

    if (path === "/api/auth/users") {
      const auth = await requireAuth(request, env, { admin: true });
      if (auth.response) return auth.response;

      if (request.method === "GET") {
        const index = await getUserIndex(kv);
        return json({ ok: true, users: index.map((item) => publicUser(item)) });
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const record = await buildUserRecord(body, { role: body.role ?? "viewer", actor: auth.user });
        await saveNewUser(kv, record);
        return json({ ok: true, user: publicUser(record) }, 201);
      }

      return failure(405, "METHOD_NOT_ALLOWED", { Allow: "GET, POST" });
    }

    const userMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(path);
    if (userMatch) {
      const auth = await requireAuth(request, env, { admin: true });
      if (auth.response) return auth.response;

      const userId = decodeURIComponent(userMatch[1]);
      const target = await getUser(kv, userId);
      if (!target) return failure(404, "USER_NOT_FOUND");
      const index = await getUserIndex(kv);

      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (typeof body.disabled !== "boolean") throw new AuthError("disabled ต้องเป็น true หรือ false");
        const activeAdmins = index.filter((item) => item?.role === "admin" && !item.disabled).length;
        if (body.disabled && target.id === auth.user.id) throw new AuthError("ไม่สามารถปิดการใช้งานตัวเองได้");
        if (body.disabled && target.role === "admin" && activeAdmins <= 1) {
          throw new AuthError("ต้องมี admin ที่เปิดใช้งานอย่างน้อย 1 คน");
        }

        const updated = { ...target, disabled: body.disabled, updatedAt: new Date().toISOString() };
        await putUser(kv, updated);
        await putUserIndex(kv, index.map((item) => (item?.id === updated.id ? publicUser(updated) : item)));
        if (body.disabled) await deleteSessionsForUser(kv, updated.id);
        return json({ ok: true, user: publicUser(updated) });
      }

      if (request.method === "DELETE") {
        const activeAdmins = index.filter((item) => item?.role === "admin" && !item.disabled).length;
        if (target.id === auth.user.id) throw new AuthError("ไม่สามารถลบตัวเองได้");
        if (target.role === "admin" && activeAdmins <= 1) {
          throw new AuthError("ต้องมี admin ที่เปิดใช้งานอย่างน้อย 1 คน");
        }

        await deleteUser(kv, target.id);
        await putUserIndex(kv, index.filter((item) => item?.id !== target.id));
        await deleteSessionsForUser(kv, target.id);
        return json({ ok: true });
      }

      return failure(405, "METHOD_NOT_ALLOWED", { Allow: "PATCH, DELETE" });
    }

    return failure(404, "NOT_FOUND");
  } catch (error) {
    if (error instanceof AuthError) return failure(400, "INVALID_INPUT", { detail: error.message });
    throw error;
  }
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

      if (url.pathname.startsWith("/api/auth/")) {
        return await handleAuthRoute(url, request, env);
      }

      if (url.pathname === "/api/devices") {
        if (request.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
        if (!env.HEALTH_KV) return failure(500, "KV_BINDING_MISSING");
        const auth = await requireAuth(request, env);
        if (auth.response) return auth.response;
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

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const auth = await authContext(request, env);
        if (!auth.user) {
          return redirectTo(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
        }
      }

      if (url.pathname === "/login" || url.pathname === "/login.html") {
        const auth = await authContext(request, env);
        if (auth.user) return redirectTo("/");
        if (url.pathname === "/login") {
          const assetRequest = new Request(new URL("/login.html", request.url), {
            method: "GET",
            headers: request.headers,
          });
          return await serveAsset(assetRequest, env);
        }
      }

      return await serveAsset(request, env);
    } catch (error) {
      console.error("worker error", error);
      return failure(500, "INTERNAL_ERROR", { detail: error?.message ?? String(error) });
    }
  },
};
