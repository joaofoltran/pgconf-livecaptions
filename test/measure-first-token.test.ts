import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function fromLogs(input: string): string {
  const run = spawnSync(process.execPath, ["--import", "tsx", "src/measure-first-token.ts", "--from-logs"], {
    input,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("--from-logs reads the app's first-token lines per role and model, and counts cut-offs as slowest", () => {
  const logs = [
    "app-1  | first token room-1 draft primary gpt-oss-120b 200 ms",
    "app-1  | first token room-2 final primary gpt-oss-120b 300 ms",
    "app-1  | first token room-2 final final gpt-oss-120b 2400 ms",
    "app-1  | draft room-1: gpt-oss-120b no first token; using openai/gpt-oss-120b",
    "app-1  | first token room-1 draft primary gpt-oss-120b >500 ms (cut off)",
    "app-1  | first token room-1 draft primary gpt-oss-120b 250 ms",
    "app-1  | first token room-1 draft primary gpt-oss-120b 260 ms",
  ].join("\n");
  assert.equal(
    fromLogs(logs),
    [
      "primary gpt-oss-120b: n=5 median=260 ms p90=cut off cut off=1",
      "final gpt-oss-120b: n=1 median=2400 ms p90=2400 ms cut off=0",
    ].join("\n")
  );
});

test("--from-logs averages the middle two samples for an even count, and p90 is not the maximum", () => {
  const lines = (values: number[]) => values.map((ms) => `first token room-1 draft primary gpt-oss-120b ${ms} ms`).join("\n");
  assert.equal(fromLogs(lines([400, 100, 300, 200])), "primary gpt-oss-120b: n=4 median=250 ms p90=370 ms cut off=0");
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  assert.equal(fromLogs(lines(ten)), "primary gpt-oss-120b: n=10 median=550 ms p90=910 ms cut off=0");
});
