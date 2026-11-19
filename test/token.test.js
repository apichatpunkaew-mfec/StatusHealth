import test from "node:test";
import assert from "node:assert/strict";

import { createHealthToken } from "../public/token.js";

test("createHealthToken produces a url-safe token with the expected length", () => {
  const token = createHealthToken();
  assert.match(token, /^ph_[A-Za-z0-9_-]{43}$/);
});

test("createHealthToken generates a different value each time", () => {
  assert.notEqual(createHealthToken(), createHealthToken());
});

test("createHealthToken clamps invalid lengths", () => {
  assert.match(createHealthToken(0), /^ph_[A-Za-z0-9_-]{43}$/);
  assert.match(createHealthToken(999), /^ph_[A-Za-z0-9_-]{171}$/);
});
