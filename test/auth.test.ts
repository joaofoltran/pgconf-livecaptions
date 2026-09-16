import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import {
  isAdmin,
  LoginRateLimiter,
  loginAdmin,
  logoutAdmin,
  parseCookies,
  requireSameOrigin,
} from "../src/auth.js";
import type { AppConfig } from "../src/config.js";

const config = {
  adminPassword: "admin-password-at-least-16",
  sessionSecret: "session-secret-at-least-32-characters-long",
} as AppConfig;

function responseRecorder(): {
  response: Response;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as Response;
  return { response, headers };
}

test("admin cookies authenticate and reject tampering", () => {
  const { response, headers } = responseRecorder();
  loginAdmin(response, config, true);

  const setCookie = headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);

  const cookie = setCookie.split(";", 1)[0];
  const request = { headers: { cookie } } as Request;
  assert.equal(isAdmin(request, config), true);
  assert.equal(
    isAdmin(request, config, Date.now() + 25 * 60 * 60 * 1000),
    false
  );

  const last = cookie.at(-1);
  const tampered = `${cookie.slice(0, -1)}${last === "0" ? "1" : "0"}`;
  const tamperedRequest = { headers: { cookie: tampered } } as Request;
  assert.equal(isAdmin(tamperedRequest, config), false);
});

test("development and logout cookies omit Secure when requested", () => {
  const login = responseRecorder();
  loginAdmin(login.response, config, false);
  assert.doesNotMatch(login.headers.get("set-cookie") ?? "", /Secure/);

  const logout = responseRecorder();
  logoutAdmin(logout.response, false);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.doesNotMatch(logout.headers.get("set-cookie") ?? "", /Secure/);
});

test("malformed cookie encoding is ignored", () => {
  assert.deepEqual(parseCookies("valid=value; broken=%E0%A4%A"), {
    valid: "value",
  });
});

test("login limiter blocks excess attempts and can be reset", () => {
  const limiter = new LoginRateLimiter(2, 1_000);
  assert.equal(limiter.consume("client", 10_000).allowed, true);
  assert.equal(limiter.consume("client", 10_100).allowed, true);

  const blocked = limiter.consume("client", 10_200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);

  limiter.reset("client");
  assert.equal(limiter.consume("client", 10_300).allowed, true);

  assert.equal(limiter.consume("other", 20_000).allowed, true);
  assert.equal(limiter.consume("other", 21_000).allowed, true);
});

test("same-origin guard rejects missing and sibling origins", () => {
  const run = (origin: string | undefined) => {
    let statusCode = 200;
    let nextCalled = false;
    const request = {
      protocol: "https",
      get(name: string) {
        if (name === "origin") return origin;
        if (name === "host") return "captions.example.test";
        return undefined;
      },
    } as unknown as Request;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;
    requireSameOrigin(request, response, () => {
      nextCalled = true;
    });
    return { nextCalled, statusCode };
  };

  assert.deepEqual(run("https://captions.example.test"), {
    nextCalled: true,
    statusCode: 200,
  });
  assert.deepEqual(run("https://admin.example.test"), {
    nextCalled: false,
    statusCode: 403,
  });
  assert.deepEqual(run(undefined), {
    nextCalled: false,
    statusCode: 403,
  });
});
