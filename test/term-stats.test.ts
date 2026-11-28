import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TermStats, termStatsText } from "../src/term-stats.js";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "term-stats-"));
const countOf = (stats: TermStats, room: string, term: string) =>
  stats.snapshot(room).terms.find((t) => t.term === term)?.count;

test("rooms that did not opt in store nothing", () => {
  const dir = tempDir();
  const stats = new TermStats(dir, new Set(["room-2"]), 5);
  stats.record("room-1", "Logical replication in PostgreSQL.");
  stats.flush();

  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(stats.hasStoredData("room-1"), false);
  assert.deepEqual(stats.snapshot("room-1").terms, []);
  assert.deepEqual(stats.snapshot("room-1").sample, []);
});

test("opted-in rooms count terms and cap the sample", () => {
  const stats = new TermStats(tempDir(), new Set(["room-1"]), 2);
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

test("stored data survives a restart, exports, and clears", () => {
  const dir = tempDir();
  const before = new TermStats(dir, new Set(["room-1"]), 5);
  before.record("room-1", "Vacuum and autovacuum tuning.");
  before.record("room-1", "Autovacuum tuning again.");
  before.flush();

  const after = new TermStats(dir, new Set(["room-1"]), 5);
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
  assert.deepEqual(new TermStats(dir, new Set(["room-1"]), 5).snapshot("room-1").terms, []);
});
