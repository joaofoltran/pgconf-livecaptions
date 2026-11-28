import fs from "node:fs";
import path from "node:path";

// Function words and speech fillers in English and Portuguese. They dominate
// any count and say nothing about the talk's vocabulary.
const STOP_WORDS = new Set(
  `
  a about above after again against all also am an and any are aren't as at be
  because been before being below between both but by can can't cannot could
  couldn't did didn't do does doesn't doing don't down during each even few for
  from further get gets getting go goes going gonna got had hadn't has hasn't
  have haven't having he he's her here here's hers herself him himself his how
  how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's
  like me more most much must mustn't my myself no nor not now of off on once
  one only or other ought our ours ourselves out over own really right same
  shan't she she'd she'll she's should shouldn't so some such than that that's
  the their theirs them themselves then there there's these they they'd they'll
  they're they've thing things this those through to too under until up us very
  want was wasn't way we we'd we'll we're we've well were weren't what what's
  when when's where where's which while who who's whom why why's will with
  won't would wouldn't yeah yes you you'd you'll you're you've your yours
  yourself yourselves uh um uhm hmm okay ok oh actually basically kind sort
  lot lots know mean think see say said
  à às ao aos aquela aquelas aquele aqueles aquilo as até com como da das de
  dela delas dele deles depois do dos e é ela elas ele eles em entre era eram
  essa essas esse esses esta está estamos estão estas estava este estes eu
  foi fomos for foram há isso isto já la lhe lhes lo mais mas me mesmo meu
  meus minha minhas muito na não nas nem no nos nós nossa nossas nosso nossos
  num numa o os ou para pela pelas pelo pelos por qual quando que quem são se
  seja ser será seu seus só sua suas também te tem têm tenho ter teu tu tua um
  uma umas uns vai vamos você vocês vou né tá aí então assim aqui ali lá coisa
  coisas gente porque pra pro bom bem sim ah eh hum tipo fazer faz
  `
    .split(/\s+/)
    .filter(Boolean)
);

// Words with internal hyphens, underscores, dots or apostrophes stay whole:
// "write-ahead", "pg_stat_statements", "node.js", "don't".
const TOKEN = /[\p{L}\p{N}]+(?:[-_.'][\p{L}\p{N}]+)*/gu;
const NUMBER_LIKE = /^[\p{N}._'-]+$/u;
// Longer "words" are pasted URLs, hashes or noise, not vocabulary.
const MAX_TOKEN_CHARS = 48;
// A caption line is a sentence or two; anything longer is cut before counting.
const MAX_LINE_CHARS = 1000;

// shortcut: a fixed per-room cap; make it a setting if a long event keeps
// hitting it.
const MAX_TERMS = 20_000;

// Lowercased single words, plus two-word terms ("logical replication") made of
// adjacent kept words in the same clause.
export function extractTerms(text: string): string[] {
  const terms: string[] = [];
  const clauses = text.toLowerCase().replace(/’/g, "'").split(/[.,;:!?…]+(?=\s|$)/u);
  for (const clause of clauses) {
    let previous = "";
    for (const word of clause.match(TOKEN) ?? []) {
      if (
        word.length < 2 ||
        word.length > MAX_TOKEN_CHARS ||
        STOP_WORDS.has(word) ||
        NUMBER_LIKE.test(word)
      ) {
        previous = "";
        continue;
      }
      terms.push(word);
      if (previous) terms.push(`${previous} ${word}`);
      previous = word;
    }
  }
  return terms;
}

type RoomStats = { terms: Map<string, number>; sample: string[] };

export type TermStatsSnapshot = {
  room: string;
  enabled: boolean;
  sampleMaxLines: number;
  terms: Array<{ term: string; count: number }>;
  sample: string[];
};

export type TermStatsOptions = {
  dir: string;
  enabledRooms: readonly string[];
  sampleMaxLines: number;
  maxTerms?: number;
  flushMs?: number;
};

// One JSON file per opted-in room under `dir`. Writes are batched and atomic
// (temporary file + rename) so a crash leaves the previous file intact.
export class TermStats {
  private readonly cache = new Map<string, RoomStats>();
  private readonly dirty = new Set<string>();
  // Rooms whose file could not be read, with the reason. Collection pauses
  // for them until the room is cleared or the app restarts.
  private readonly unreadable = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly dir: string;
  private readonly enabledRooms: ReadonlySet<string>;
  private readonly sampleMaxLines: number;
  private readonly maxTerms: number;
  private readonly flushMs: number;

  constructor(options: TermStatsOptions) {
    this.dir = options.dir;
    this.enabledRooms = new Set(options.enabledRooms);
    this.sampleMaxLines = options.sampleMaxLines;
    this.maxTerms = options.maxTerms ?? MAX_TERMS;
    this.flushMs = options.flushMs ?? 5000;
    // A crash mid-write can leave a temp file holding speech text.
    for (const name of this.listDir()) {
      if (name.endsWith(".json.tmp")) this.remove(path.join(this.dir, name));
    }
    // Load now so an unreadable file shows in the admin status at startup.
    for (const room of this.enabledRooms) {
      try {
        this.load(room);
      } catch {
        // Kept in `unreadable` and reported by loadError().
      }
    }
  }

  isEnabled(room: string): boolean {
    return this.enabledRooms.has(room);
  }

  loadError(room: string): string | null {
    return this.unreadable.get(room) ?? null;
  }

  hasStoredData(room: string): boolean {
    const file = this.file(room);
    return this.dirty.has(room) || fs.existsSync(file) || fs.existsSync(`${file}.tmp`);
  }

  record(room: string, text: string): void {
    if (!this.enabledRooms.has(room) || this.unreadable.has(room)) return;
    const stats = this.load(room);
    const line = text.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/, "");
    for (const term of extractTerms(line)) {
      stats.terms.set(term, (stats.terms.get(term) ?? 0) + 1);
    }
    this.enforceCap(stats.terms);
    if (stats.sample.length < this.sampleMaxLines) stats.sample.push(line);
    this.markDirty(room);
  }

  snapshot(room: string): TermStatsSnapshot {
    const stats = this.load(room);
    return {
      room,
      enabled: this.isEnabled(room),
      sampleMaxLines: this.sampleMaxLines,
      terms: [...stats.terms]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([term, count]) => ({ term, count })),
      sample: [...stats.sample],
    };
  }

  clear(room: string): void {
    this.cache.delete(room);
    this.dirty.delete(room);
    this.unreadable.delete(room);
    const file = this.file(room);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.tmp`, { force: true });
    this.syncDir();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const room of this.dirty) {
      const stats = this.cache.get(room);
      if (!stats) continue;
      const file = this.file(room);
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const body = { terms: Object.fromEntries(stats.terms), sample: stats.sample };
        // flush: fsync before the rename, so a crash cannot leave a renamed
        // but empty or cut-off file.
        fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flush: true });
        fs.renameSync(tmp, file);
        this.syncDir();
        this.dirty.delete(room);
      } catch (err) {
        console.error(`term stats write failed ${room}`, err);
        this.remove(tmp);
      }
    }
  }

  private file(room: string): string {
    return path.join(this.dir, `${room}.json`);
  }

  private listDir(): string[] {
    try {
      return fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`term stats cannot read ${this.dir}`, err);
      }
      return [];
    }
  }

  private remove(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.error(`term stats cannot remove ${file}`, err);
    }
  }

  // Makes a rename or delete durable: without it a crash can undo either.
  private syncDir(): void {
    let fd: number;
    try {
      fd = fs.openSync(this.dir, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private markDirty(room: string): void {
    this.dirty.add(room);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  // Drops the lowest counts (oldest first among ties) to 90% of the cap, so
  // the sort runs once per batch of new terms rather than on every caption.
  // At the cap, a brand-new term is usually the one dropped.
  private enforceCap(terms: Map<string, number>): boolean {
    if (terms.size <= this.maxTerms) return false;
    const keep = Math.floor(this.maxTerms * 0.9);
    const lowest = [...terms].sort((a, b) => a[1] - b[1]);
    for (const [term] of lowest.slice(0, terms.size - keep)) terms.delete(term);
    return true;
  }

  // A corrupt file throws instead of being replaced, so a bad read never
  // overwrites the counts already on disk. The failure is remembered and
  // logged once. A file over the current limits (written before a cap was
  // lowered) is trimmed and rewritten.
  private load(room: string): RoomStats {
    let stats = this.cache.get(room);
    if (stats) return stats;
    const failure = this.unreadable.get(room);
    if (failure) throw new Error(failure);
    const file = this.file(room);
    try {
      stats = parseStats(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const reason = err instanceof Error ? err.message : String(err);
        const message =
          `Stored term stats for ${room} are unreadable (${file}: ${reason}). ` +
          "Nothing is collected for this room until it is cleared.";
        this.unreadable.set(room, message);
        console.error(message);
        throw new Error(message);
      }
      stats = { terms: new Map(), sample: [] };
    }
    const cappedTerms = this.enforceCap(stats.terms);
    const cappedSample = stats.sample.splice(this.sampleMaxLines).length > 0;
    this.cache.set(room, stats);
    if (cappedTerms || cappedSample) this.markDirty(room);
    return stats;
  }
}

function parseStats(json: string): RoomStats {
  const raw = JSON.parse(json) as { terms?: unknown; sample?: unknown } | null;
  const terms = raw?.terms;
  const sample = raw?.sample;
  if (
    !terms ||
    typeof terms !== "object" ||
    Array.isArray(terms) ||
    !Object.values(terms).every((n) => Number.isSafeInteger(n) && n > 0) ||
    !Array.isArray(sample) ||
    !sample.every((line) => typeof line === "string")
  ) {
    throw new Error("not a term stats file");
  }
  return { terms: new Map(Object.entries(terms as Record<string, number>)), sample };
}

export function termStatsText(snapshot: TermStatsSnapshot): string {
  return [
    `# Terms for ${snapshot.room}, most frequent first (count<TAB>term)`,
    ...snapshot.terms.map(({ term, count }) => `${count}\t${term}`),
    "",
    `# Sample: first ${snapshot.sampleMaxLines} lines of source speech`,
    ...snapshot.sample,
    "",
  ].join("\n");
}
