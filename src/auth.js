import { constantTimeEqual } from "./lib.js";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export const USER_KEY_PREFIX = "auth:user:";
export const SESSION_KEY_PREFIX = "auth:session:";
export const USER_INDEX_KEY = "auth:users";
export const SESSION_COOKIE = "ph_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
// Cloudflare Workers WebCrypto supports at most 100,000 PBKDF2 iterations.
export const PBKDF2_ITERATIONS = 100_000;
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();
const ROLES = new Set(["admin", "viewer"]);

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new AuthError("username ต้องเป็น a-z 0-9 . _ - ยาว 3-32 ตัวอักษร และขึ้นต้นด้วยตัวเลขหรือตัวอักษร");
  }
  return username;
}

export function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw new AuthError("รหัสผ่านต้องยาว 8-128 ตัวอักษร");
  }
  return password;
}

export function normalizeDisplayName(value, fallback = "") {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > 64) throw new AuthError("ชื่อที่แสดงยาวเกิน 64 ตัวอักษร");
  return cleaned || fallback;
}

export function normalizeRole(value) {
  const role = String(value ?? "viewer").toLowerCase();
  if (!ROLES.has(role)) throw new AuthError("role ต้องเป็น admin หรือ viewer");
  return role;
}

export function isAdmin(user) {
  return user?.role === "admin";
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  };
}
export async function hashPassword(password) {
  const salt = randomBase64Url(16);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: base64UrlToBytes(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return {
    algorithm: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    salt,
    hash: bytesToBase64Url(new Uint8Array(bits)),
  };
}

export async function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const iterations = Number(user.iterations) || PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new AuthError("รูปแบบรหัสผ่านของผู้ใช้นี้ไม่รองรับ กรุณาสร้างผู้ใช้ใหม่");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: base64UrlToBytes(user.salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return constantTimeEqual(bytesToBase64Url(new Uint8Array(bits)), user.hash);
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function serializeSessionCookie(token, { secure = true, maxAge = SESSION_TTL_SECONDS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie({ secure = true } = {}) {
  return serializeSessionCookie("", { secure, maxAge: 0 });
}

export async function getUserIndex(kv) {
  const value = await kv.get(USER_INDEX_KEY, "json");
  return Array.isArray(value) ? value : [];
}

export async function putUserIndex(kv, users) {
  await kv.put(USER_INDEX_KEY, JSON.stringify(users));
}

export async function getUser(kv, id) {
  if (!id) return null;
  const user = await kv.get(`${USER_KEY_PREFIX}${id}`, "json");
  return user && typeof user === "object" && !Array.isArray(user) ? user : null;
}

export async function putUser(kv, user) {
  await kv.put(`${USER_KEY_PREFIX}${user.id}`, JSON.stringify(user));
}

export async function deleteUser(kv, id) {
  await kv.delete(`${USER_KEY_PREFIX}${id}`);
}

export async function findUserByUsername(kv, username) {
  const index = await getUserIndex(kv);
  const entry = index.find((item) => item?.username === username);
  return entry?.id ? getUser(kv, entry.id) : null;
}

export async function createSession(kv, user) {
  const token = randomBase64Url(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await kv.put(
    `${SESSION_KEY_PREFIX}${token}`,
    JSON.stringify({
      token,
      userId: user.id,
      username: user.username,
      role: user.role,
      user: publicUser(user),
      createdAt: now.toISOString(),
      expiresAt,
    }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
  return { token, expiresAt };
}

export async function getSession(kv, token) {
  if (!token || typeof token !== "string") return null;
  const session = await kv.get(`${SESSION_KEY_PREFIX}${token}`, "json");
  if (!session || typeof session !== "object") return null;
  if (!session.expiresAt || Date.parse(session.expiresAt) <= Date.now()) {
    await deleteSession(kv, token);
    return null;
  }
  return session;
}

export async function deleteSession(kv, token) {
  if (token) await kv.delete(`${SESSION_KEY_PREFIX}${token}`);
}

export async function deleteSessionsForUser(kv, userId) {
  if (!userId) return;
  let cursor = null;
  do {
    const options = { prefix: SESSION_KEY_PREFIX, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await kv.list(options);
    for (const key of page.keys) {
      const session = await kv.get(key.name, "json");
      if (session?.userId === userId) await kv.delete(key.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

