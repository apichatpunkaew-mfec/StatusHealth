import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentCommands, createHealthToken } from "../public/token.js";

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

test("buildAgentCommands embeds the token in install and reinstall commands", () => {
  const commands = buildAgentCommands("ph_test-token", "https://example.com/agent/bootstrap.ps1");
  assert.equal(
    commands.install,
    '$bootstrap = irm https://example.com/agent/bootstrap.ps1; & ([scriptblock]::Create($bootstrap)) -Token ph_test-token',
  );
  assert.equal(
    commands.reinstall,
    '$bootstrap = irm https://example.com/agent/bootstrap.ps1; & ([scriptblock]::Create($bootstrap)) -Force -Token ph_test-token',
  );
});
