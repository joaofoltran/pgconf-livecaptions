// Prints the primary provider's median and p90 time to its first streamed token.
//   node dist/measure-first-token.js [samples]   sends sample captions with the configured primary
//   node dist/measure-first-token.js --from-logs  reads the app's "first token" log lines on stdin
import "dotenv/config";
import readline from "node:readline";
import { Agent, setGlobalDispatcher } from "undici";
import { loadConfig } from "./config.js";
import { primaryProvider, translateCaption } from "./translate.js";

const SAMPLES = [
  "so today we are going to talk about logical replication in postgres",
  "the first thing you need to understand is how the write ahead log works",
  "every change to the database is recorded there before it reaches the data files",
  "that is what makes crash recovery possible and it also enables streaming replication",
  "now logical replication decodes those records into a stream of row changes",
  "you can subscribe to that stream from another server or from your own tool",
  "the catch is that slots keep old segments around until the consumer confirms them",
  "so if a consumer goes away your disk fills up and the primary stops",
  "let me show you how to monitor that with a simple query",
  "and after that we will look at failover slots in the new release",
];

// A cut-off request is Infinity: it counts as slower than every answer.
// Percentiles interpolate between the two nearest samples (the spreadsheet
// PERCENTILE.INC rule), so an even count's median is the mean of the middle two.
function summary(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => {
    const rank = p * (sorted.length - 1);
    const lo = sorted[Math.floor(rank)];
    const hi = sorted[Math.ceil(rank)];
    const v = lo === hi ? lo : lo + (hi - lo) * (rank - Math.floor(rank));
    return Number.isFinite(v) ? `${Math.round(v)} ms` : "cut off";
  };
  const cut = sorted.filter((v) => !Number.isFinite(v)).length;
  return `n=${sorted.length} median=${at(0.5)} p90=${at(0.9)} cut off=${cut}`;
}

async function fromLogs(): Promise<void> {
  const byModel = new Map<string, number[]>();
  const line = /first token \S+ (?:draft|final) (\S+) (?:(\d+) ms|>\d+ ms \(cut off\))/;
  for await (const text of readline.createInterface({ input: process.stdin })) {
    const m = line.exec(text);
    if (!m) continue;
    const samples = byModel.get(m[1]) ?? [];
    samples.push(m[2] === undefined ? Infinity : Number(m[2]));
    byModel.set(m[1], samples);
  }
  if (!byModel.size) throw new Error('no "first token" lines on stdin');
  for (const [model, samples] of byModel) console.log(`${model}: ${summary(samples)}`);
}

async function live(count: number): Promise<void> {
  // Same keep-alive as the app, so samples after the first reuse the connection.
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000 }));
  const config = loadConfig();
  const provider = primaryProvider(config);
  const once = async (text: string): Promise<number> => {
    const startedAt = Date.now();
    let firstAt = 0;
    await translateCaption(config, text, "en-pt", {
      provider,
      signal: AbortSignal.timeout(10_000),
      onPartial: () => (firstAt ||= Date.now()),
    });
    return firstAt - startedAt;
  };
  await once(SAMPLES[0]); // warm-up: pays for DNS and TLS, like the app's first request
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const ms = await once(SAMPLES[i % SAMPLES.length]);
    samples.push(ms);
    console.log(`sample ${i + 1}/${count}: ${ms} ms`);
  }
  console.log(`${provider.model} at ${provider.baseUrl}: ${summary(samples)}`);
}

const arg = process.argv[2];
if (arg === "--from-logs") await fromLogs();
else {
  const count = Number(arg ?? 20);
  if (!Number.isInteger(count) || count < 1) throw new Error("usage: measure-first-token [samples] | --from-logs");
  await live(count);
}
