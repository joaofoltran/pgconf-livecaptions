import assert from "node:assert/strict";
import { test } from "node:test";
import { CircuitBreaker } from "../src/breaker.js";

test("breaker opens after two failures, then lets a single probe through", () => {
  const breaker = new CircuitBreaker(2, 15_000, 45_000);

  assert.equal(breaker.fail(0), false);
  assert.equal(breaker.fail(20_000), false, "failures outside the window do not add up");
  assert.equal(breaker.route(20_001), "preferred");
  assert.equal(breaker.fail(21_000), true);
  assert.equal(breaker.route(30_000), "fallback");

  assert.equal(breaker.route(66_000), "probe");
  assert.equal(breaker.route(66_001), "fallback", "only one probe at a time");
  breaker.release();
  assert.equal(breaker.route(66_002), "probe", "an aborted probe frees the slot");

  assert.equal(breaker.fail(66_500), true, "a failed probe reopens");
  assert.equal(breaker.route(70_000), "fallback");

  assert.equal(breaker.route(111_500), "probe");
  breaker.succeed(111_800);
  assert.equal(breaker.route(111_900), "preferred");
  assert.equal(breaker.fail(112_000), false, "closing resets the failure count");
});
