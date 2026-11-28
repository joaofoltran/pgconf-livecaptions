import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TermStats, termStatsText, type TermStatsOptions } from "../src/term-stats.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "term-stats-"));
const open = (dir: string, options: Partial<TermStatsOptions> = {}) =>
  new TermStats({
    dir,
    rooms: ["room-1", "room-2"],
    enabledRooms: ["room-1"],
    sampleMaxLines: 5,
    ...options,
  });
const countOf = (stats: TermStats, room: string, term: string) =>
  stats.snapshot(room).terms.find((t) => t.term === term)?.count;

test("rooms that did not opt in store nothing", () => {
  const dir = tempDir();
  const stats = open(dir, { enabledRooms: ["room-2"] });
  stats.record("room-1", "Logical replication in PostgreSQL.");
  stats.flush();

  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(stats.hasStoredData("room-1"), false);
  assert.deepEqual(stats.snapshot("room-1").terms, []);
  assert.deepEqual(stats.snapshot("room-1").sample, []);
});

test("opted-in rooms count terms and cap the sample", () => {
  const stats = open(tempDir(), { sampleMaxLines: 2 });
  stats.record("room-1", "We use logical replication with PostgreSQL.");
  stats.record("room-1", "Logical replication, then the constructor runs.");
  stats.record("room-1", "A replicação lógica do PostgreSQL 17.2.");

  assert.equal(countOf(stats, "room-1", "logical replication"), 2);
  assert.equal(countOf(stats, "room-1", "postgresql"), 2);
  assert.equal(countOf(stats, "room-1", "replicação lógica"), 1);
  assert.equal(countOf(stats, "room-1", "constructor"), 1);
  // Stop words, numbers, and pairs across a comma or stop word are not terms.
  for (const term of ["we", "the", "17.2", "replication then", "replication postgresql"]) {
    assert.equal(countOf(stats, "room-1", term), undefined, term);
  }
  assert.deepEqual(stats.snapshot("room-1").sample, [
    "We use logical replication with PostgreSQL.",
    "Logical replication, then the constructor runs.",
  ]);
});

test("the term cap holds even when every new term repeats", () => {
  const stats = open(tempDir(), { maxTerms: 10 });
  stats.record("room-1", "postgresql postgresql postgresql");
  for (let i = 0; i < 50; i++) stats.record("room-1", `novel${i} novel${i}`);

  const { terms } = stats.snapshot("room-1");
  assert.ok(terms.length <= 10, `${terms.length} terms`);
  assert.equal(countOf(stats, "room-1", "postgresql"), 3);
});

test("long lines are cut and long tokens skipped", () => {
  const stats = open(tempDir());
  const token = "x".repeat(60);
  stats.record("room-1", `${token} vacuum ${"a".repeat(5000)}`);

  assert.equal(stats.snapshot("room-1").sample[0].length, 1000);
  assert.equal(countOf(stats, "room-1", token), undefined);
  assert.equal(countOf(stats, "room-1", "vacuum"), 1);
});

test("files over the current caps are trimmed on load", () => {
  const dir = tempDir();
  const terms = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`term${i}`, i + 1]));
  terms["y".repeat(500)] = 99;
  const sample = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  sample[1] = "z".repeat(5000);
  fs.writeFileSync(path.join(dir, "room-1.json"), JSON.stringify({ terms, sample }));

  const stats = open(dir, { maxTerms: 10, sampleMaxLines: 3 });
  const snapshot = stats.snapshot("room-1");
  assert.ok(snapshot.terms.length <= 10);
  assert.equal(snapshot.terms[0].term, "term29", "over-long term dropped");
  assert.deepEqual(snapshot.sample, ["line 0", "z".repeat(1000), "line 2"]);

  stats.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "room-1.json"), "utf8"));
  assert.deepEqual(onDisk.sample, snapshot.sample);
  assert.ok(Object.keys(onDisk.terms).length <= 10);
});

test("leftover temp files count as stored data and are removed", () => {
  const dir = tempDir();
  const tmp = path.join(dir, "room-1.json.tmp");
  fs.writeFileSync(tmp, '{"terms":{},"sample":["speech left by a crash"]}');
  const stats = open(dir);
  assert.equal(fs.existsSync(tmp), false, "removed at start");

  fs.writeFileSync(tmp, '{"terms":{},"sample":["speech left by a failed write"]}');
  assert.equal(stats.hasStoredData("room-1"), true);
  stats.clear("room-1");
  assert.equal(fs.existsSync(tmp), false, "removed by clear");
  assert.equal(stats.hasStoredData("room-1"), false);
});

test("files of rooms no longer in ROOMS are logged and kept", (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "old-room.json"), '{"terms":{},"sample":[]}');
  fs.writeFileSync(path.join(dir, "room-2.json"), '{"terms":{},"sample":[]}');
  open(dir);

  assert.equal(warnings.mock.callCount(), 1);
  const message = String(warnings.mock.calls[0].arguments[0]);
  assert.match(message, /old-room\.json/);
  assert.doesNotMatch(message, /room-2/);
  assert.equal(fs.existsSync(path.join(dir, "old-room.json")), true);
});

test("a corrupt file is reported once, never overwritten, and clearable", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const dir = tempDir();
  const file = path.join(dir, "room-1.json");
  fs.writeFileSync(file, '{"terms":{"wal":3},"sample":["cut off');
  const stats = open(dir);

  assert.match(stats.loadError("room-1") ?? "", /room-1 are unreadable/);
  stats.record("room-1", "Logical replication.");
  stats.record("room-1", "Logical replication.");
  assert.throws(() => stats.snapshot("room-1"), /room-1 are unreadable/);
  stats.flush();
  assert.equal(fs.readFileSync(file, "utf8"), '{"terms":{"wal":3},"sample":["cut off');
  assert.equal(errors.mock.callCount(), 1);

  stats.clear("room-1");
  assert.equal(stats.loadError("room-1"), null);
  stats.record("room-1", "Logical replication.");
  assert.equal(countOf(stats, "room-1", "logical replication"), 1);
});

test("a file over the byte limit is not read", (t) => {
  t.mock.method(console, "error", () => {});
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "room-1.json"), JSON.stringify({ terms: { wal: 1 }, sample: ["x".repeat(200)] }));
  const stats = open(dir, { maxFileBytes: 100 });

  assert.match(stats.loadError("room-1") ?? "", /over the 100-byte limit/);
});

test("failed writes keep the data and retry with backoff", (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir();
  const file = path.join(dir, "room-1.json");
  const stats = open(dir, { flushMs: 100 });
  // A directory where the temp file goes makes every write fail.
  fs.mkdirSync(`${file}.tmp`);

  stats.record("room-1", "Logical replication.");
  t.mock.timers.tick(100);
  assert.equal(fs.existsSync(file), false);
  assert.equal(stats.hasStoredData("room-1"), true);

  fs.rmdirSync(`${file}.tmp`);
  t.mock.timers.tick(100);
  assert.equal(fs.existsSync(file), false, "the retry waits twice as long");
  t.mock.timers.tick(100);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sample, ["Logical replication."]);
});

test("the text export keeps each sample line on one line", () => {
  const stats = open(tempDir());
  stats.record("room-1", "first\r\n# Terms for room-2\u0007 C:\\pg\tend");
  const text = termStatsText(stats.snapshot("room-1"));

  assert.match(text, /^first\\r\\n# Terms for room-2\\u0007 C:\\\\pg\\tend$/m);
  assert.equal(text.match(/^# Terms/gm)?.length, 1);
});

test("a failing room does not delay other rooms' writes", (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir();
  const stats = open(dir, { enabledRooms: ["room-1", "room-2"], flushMs: 100 });
  const sampleOf = (room: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${room}.json`), "utf8")).sample;
  fs.mkdirSync(path.join(dir, "room-1.json.tmp"));

  stats.record("room-1", "Logical replication.");
  stats.record("room-2", "Vacuum.");
  t.mock.timers.tick(100);
  assert.deepEqual(sampleOf("room-2"), ["Vacuum."]);

  stats.record("room-2", "Autovacuum.");
  t.mock.timers.tick(100);
  assert.deepEqual(sampleOf("room-2"), ["Vacuum.", "Autovacuum."]);
  assert.equal(fs.existsSync(path.join(dir, "room-1.json")), false);
});

test("stored data survives a restart, exports, and clears", () => {
  const dir = tempDir();
  const before = open(dir);
  before.record("room-1", "Vacuum and autovacuum tuning.");
  before.record("room-1", "Autovacuum tuning again.");
  before.flush();

  const after = open(dir);
  assert.equal(after.hasStoredData("room-1"), true);
  assert.deepEqual(after.snapshot("room-1"), before.snapshot("room-1"));
  assert.deepEqual(after.snapshot("room-1").terms.slice(0, 2), [
    { term: "autovacuum", count: 2 },
    { term: "autovacuum tuning", count: 2 },
  ]);
  assert.match(termStatsText(after.snapshot("room-1")), /^2\tautovacuum$/m);
  assert.match(termStatsText(after.snapshot("room-1")), /^Autovacuum tuning again\.$/m);

  after.clear("room-1");
  assert.equal(after.hasStoredData("room-1"), false);
  assert.deepEqual(open(dir).snapshot("room-1").terms, []);
});
