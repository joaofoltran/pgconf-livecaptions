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

// shortcut: a hard per-room cap that drops single-occurrence terms when hit;
// make it a setting if a long event keeps hitting it.
const MAX_TERMS = 20_000;

// Lowercased single words, plus two-word terms ("logical replication") made of
// adjacent kept words in the same clause.
export function extractTerms(text: string): string[] {
  const terms: string[] = [];
  const clauses = text.toLowerCase().replace(/’/g, "'").split(/[.,;:!?…]+(?=\s|$)/u);
  for (const clause of clauses) {
    let previous = "";
    for (const word of clause.match(TOKEN) ?? []) {
      if (word.length < 2 || STOP_WORDS.has(word) || NUMBER_LIKE.test(word)) {
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

// One JSON file per opted-in room under `dir`. Writes are batched and atomic
// (temporary file + rename) so a crash leaves the previous file intact.
export class TermStats {
  private readonly cache = new Map<string, RoomStats>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly enabledRooms: ReadonlySet<string>,
    private readonly sampleMaxLines: number,
    private readonly flushMs = 5000
  ) {}

  isEnabled(room: string): boolean {
    return this.enabledRooms.has(room);
  }

  hasStoredData(room: string): boolean {
    return this.dirty.has(room) || fs.existsSync(this.file(room));
  }

  record(room: string, text: string): void {
    if (!this.enabledRooms.has(room)) return;
    const stats = this.load(room);
    for (const term of extractTerms(text)) {
      stats.terms.set(term, (stats.terms.get(term) ?? 0) + 1);
    }
    if (stats.terms.size > MAX_TERMS) {
      for (const [term, count] of stats.terms) if (count === 1) stats.terms.delete(term);
    }
    if (stats.sample.length < this.sampleMaxLines) stats.sample.push(text);
    this.dirty.add(room);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
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
    fs.rmSync(this.file(room), { force: true });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const room of this.dirty) {
      const stats = this.cache.get(room);
      if (!stats) continue;
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = this.file(room);
        const tmp = `${file}.tmp`;
        const body = { terms: Object.fromEntries(stats.terms), sample: stats.sample };
        fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
        fs.renameSync(tmp, file);
        this.dirty.delete(room);
      } catch (err) {
        console.error(`term stats write failed ${room}`, err);
      }
    }
  }

  private file(room: string): string {
    return path.join(this.dir, `${room}.json`);
  }

  // A corrupt file throws instead of being replaced, so a bad read never
  // overwrites the counts already on disk.
  private load(room: string): RoomStats {
    let stats = this.cache.get(room);
    if (stats) return stats;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(room), "utf8")) as {
        terms?: Record<string, number>;
        sample?: string[];
      };
      stats = { terms: new Map(Object.entries(raw.terms ?? {})), sample: raw.sample ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      stats = { terms: new Map(), sample: [] };
    }
    this.cache.set(room, stats);
    return stats;
  }
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
