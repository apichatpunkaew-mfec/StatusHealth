import test from "node:test";
import assert from "node:assert/strict";

import {
  AuthError,
  SESSION_KEY_PREFIX,
  clearSessionCookie,
  createSession,
  deleteSessionsForUser,
  hashPassword,
  normalizeRole,
  normalizeUsername,
  parseCookies,
  publicUser,
  serializeSessionCookie,
  validatePassword,
  verifyPassword,
} from "../src/auth.js";

test("normalizeUsername lowercases and validates username", () => {
  assert.equal(normalizeUsername("  Admin.01 "), "admin.01");
  assert.throws(() => normalizeUsername("ab"), AuthError);
  assert.throws(() => normalizeUsername("bad name"), AuthError);
});

test("validatePassword enforces length", () => {
  assert.equal(validatePassword("password123"), "password123");
  assert.throws(() => validatePassword("short"), AuthError);
});

test("normalizeRole accepts admin and viewer", () => {
  assert.equal(normalizeRole("ADMIN"), "admin");
  assert.equal(normalizeRole(undefined), "viewer");
  assert.throws(() => normalizeRole("root"), AuthError);
});

test("hashPassword and verifyPassword round-trip", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(stored.algorithm, "pbkdf2-sha256");
  assert.equal(stored.hash.length, 43);
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
});

test("publicUser removes password material", () => {
  const safe = publicUser({
    id: "user-1",
    username: "admin",
    displayName: "Admin",
    role: "admin",
    salt: "salt",
    hash: "hash",
    iterations: 180000,
  });
  assert.equal(safe.id, "user-1");
  assert.equal(safe.role, "admin");
  assert.equal("salt" in safe, false);
  assert.equal("hash" in safe, false);
});

test("session cookie is HttpOnly, Secure and parseable", () => {
  const cookie = serializeSessionCookie("token-abc", { secure: true, maxAge: 60 });
  assert.match(cookie, /^ph_session=token-abc;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=60/);
  assert.equal(parseCookies(`other=1; ${cookie}`).ph_session, "token-abc");
  assert.match(clearSessionCookie({ secure: true }), /Max-Age=0/);
});
test("deleteSessionsForUser revokes only that user's sessions", async () => {
  const store = new Map();
  const kv = {
    put: async (key, value) => store.set(key, value),
    get: async (key, format) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return format === "json" ? JSON.parse(value) : value;
    },
    delete: async (key) => store.delete(key),
    list: async ({ prefix = "" } = {}) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  };

  await createSession(kv, { id: "u1", username: "admin01", displayName: "Admin", role: "admin" });
  await createSession(kv, { id: "u2", username: "viewer01", displayName: "Viewer", role: "viewer" });
  await deleteSessionsForUser(kv, "u1");

  const remaining = [...store.keys()].filter((key) => key.startsWith(SESSION_KEY_PREFIX));
  assert.equal(remaining.length, 1);
  const session = JSON.parse(store.get(remaining[0]));
  assert.equal(session.userId, "u2");
  assert.equal(session.user.username, "viewer01");
});

