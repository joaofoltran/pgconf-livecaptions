import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TermStats, termStatsText, type TermStatsOptions } from "../src/term-stats.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "term-stats-"));
const open = (dir: string, options: Partial<TermStatsOptions> = {}) =>
  new TermStats({ dir, enabledRooms: ["room-1"], sampleMaxLines: 5, ...options });
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
  const sample = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(dir, "room-1.json"), JSON.stringify({ terms, sample }));

  const stats = open(dir, { maxTerms: 10, sampleMaxLines: 3 });
  const snapshot = stats.snapshot("room-1");
  assert.ok(snapshot.terms.length <= 10);
  assert.equal(snapshot.terms[0].term, "term29");
  assert.deepEqual(snapshot.sample, ["line 0", "line 1", "line 2"]);

  stats.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "room-1.json"), "utf8"));
  assert.deepEqual(onDisk.sample, snapshot.sample);
  assert.ok(Object.keys(onDisk.terms).length <= 10);
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
