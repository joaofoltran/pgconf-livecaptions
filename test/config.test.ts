import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { loadConfig, tokenEnvName } from "../src/config.js";

const managedVariables = [
  "ADMIN_PASSWORD",
  "DEEPGRAM_API_KEY",
  "DOMAIN",
  "DRAFT_INTERVAL_MS",
  "DRAFTS_PER_SECOND",
  "FALLBACK_API_KEY",
  "FALLBACK_BASE_URL",
  "FALLBACK_EXTRA_BODY",
  "FALLBACK_MODEL",
  "FIRST_TOKEN_MS",
  "FINAL_API_KEY",
  "LIVE_DRAFTS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_EXTRA_BODY",
  "PORT",
  "ROOMS",
  "SESSION_SECRET",
  "STT_PROXY",
  "TOKEN_ROOM_1",
];

const originalEnvironment = new Map(
  managedVariables.map((name) => [name, process.env[name]])
);

beforeEach(() => {
  for (const name of managedVariables) delete process.env[name];
  Object.assign(process.env, {
    ADMIN_PASSWORD: "admin-password-at-least-16",
    DEEPGRAM_API_KEY: "deepgram-test-key",
    DOMAIN: "captions.example.test",
    OPENAI_API_KEY: "openai-test-key",
    ROOMS: "room-1",
    SESSION_SECRET: "session-secret-at-least-32-characters-long",
    TOKEN_ROOM_1: "room-token-at-least-16",
  });
});

after(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("tokenEnvName maps room slugs to environment variables", () => {
  assert.equal(tokenEnvName("main-stage"), "TOKEN_MAIN_STAGE");
  assert.equal(tokenEnvName("room-2026"), "TOKEN_ROOM_2026");
});

test("loadConfig accepts a valid minimal environment", () => {
  const config = loadConfig();
  assert.deepEqual(config.rooms, ["room-1"]);
  assert.equal(config.tokens["room-1"], "room-token-at-least-16");
  assert.equal(config.port, 3000);
  assert.equal(config.sttProxy, true);
  assert.equal(config.liveDrafts, true);
  assert.equal(config.firstTokenMs, 600);
});

test("loadConfig accepts FIRST_TOKEN_MS", () => {
  process.env.FIRST_TOKEN_MS = "650";
  assert.equal(loadConfig().firstTokenMs, 650);

  process.env.FIRST_TOKEN_MS = "10";
  assert.throws(() => loadConfig(), /FIRST_TOKEN_MS must be an integer/);
});

test("a fallback key without its base URL and model fails at startup", () => {
  process.env.FALLBACK_API_KEY = "fallback-test-key";
  assert.throws(() => loadConfig(), /FALLBACK_API_KEY is set but FALLBACK_BASE_URL and FALLBACK_MODEL are not/);

  process.env.FALLBACK_BASE_URL = "https://api.groq.com/openai/v1";
  assert.throws(() => loadConfig(), /FALLBACK_API_KEY is set but FALLBACK_MODEL is not/);

  process.env.FALLBACK_MODEL = "openai/gpt-oss-120b";
  assert.deepEqual(loadConfig().fallback, {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "fallback-test-key",
    model: "openai/gpt-oss-120b",
    extraBody: {},
  });
});

test("loadConfig rejects duplicate and malformed room slugs", () => {
  process.env.ROOMS = "room-1,room-1";
  assert.throws(() => loadConfig(), /Duplicate room slug/);

  process.env.ROOMS = "Room One";
  assert.throws(() => loadConfig(), /Invalid room slug/);

  process.env.ROOMS = "room-a,room--a";
  assert.throws(() => loadConfig(), /Invalid room slug/);
});

test("loadConfig rejects short secrets", () => {
  process.env.TOKEN_ROOM_1 = "short";
  assert.throws(() => loadConfig(), /TOKEN_ROOM_1 must be at least 16 characters/);

  process.env.TOKEN_ROOM_1 = "room-token-at-least-16";
  process.env.ADMIN_PASSWORD = "short";
  assert.throws(() => loadConfig(), /ADMIN_PASSWORD must be at least 16 characters/);
});

test("loadConfig rejects invalid numeric, boolean, and JSON settings", () => {
  process.env.PORT = "not-a-port";
  assert.throws(() => loadConfig(), /PORT must be an integer/);

  delete process.env.PORT;
  process.env.STT_PROXY = "yes";
  assert.throws(() => loadConfig(), /STT_PROXY must be true or false/);

  delete process.env.STT_PROXY;
  process.env.OPENAI_EXTRA_BODY = "[]";
  assert.throws(() => loadConfig(), /OPENAI_EXTRA_BODY must be a JSON object/);
});

test("loadConfig validates provider URLs and trims trailing slashes", () => {
  process.env.OPENAI_BASE_URL = "https://provider.example.test/v1///";
  assert.equal(loadConfig().openaiBaseUrl, "https://provider.example.test/v1");

  process.env.OPENAI_BASE_URL = "file:///tmp/provider";
  assert.throws(() => loadConfig(), /OPENAI_BASE_URL must use http or https/);
});
