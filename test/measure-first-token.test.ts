import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("--from-logs reads the app's first-token lines and counts cut-offs as slowest", () => {
  const logs = [
    "app-1  | first token room-1 draft gpt-oss-120b 200 ms",
    "app-1  | first token room-2 final gpt-oss-120b 300 ms",
    "app-1  | draft room-1: gpt-oss-120b no first token; using openai/gpt-oss-120b",
    "app-1  | first token room-1 draft gpt-oss-120b >500 ms (cut off)",
    "app-1  | first token room-1 draft gpt-oss-120b 250 ms",
    "app-1  | first token room-1 draft gpt-oss-120b 260 ms",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/measure-first-token.ts", "--from-logs"], {
    input: logs,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "gpt-oss-120b: n=5 median=260 ms p90=cut off cut off=1");
});
