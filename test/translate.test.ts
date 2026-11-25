import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { translateCaption, translateWithHedge } from "../src/translate.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function testConfig(): AppConfig {
  return {
    openaiApiKey: "primary-key",
    openaiBaseUrl: "https://primary.test/v1",
    openaiModel: "primary-model",
    openaiExtraBody: {},
    openaiServiceTier: "",
    keyterms: [],
    glossary: [],
    fallback: {
      baseUrl: "https://fallback.test/v1",
      apiKey: "fallback-key",
      model: "fallback-model",
      extraBody: {},
    },
    firstTokenMs: 600,
  } as AppConfig;
}

function abortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function sseBody(text: string, ttftMs: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        if (ttftMs) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ttftMs);
            const onAbort = () => {
              clearTimeout(timer);
              reject(abortError());
            };
            if (signal?.aborted) {
              clearTimeout(timer);
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

function hangUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(abortError());
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type MockOpts = {
  primary?: "hang" | { text: string; ttftMs: number; status?: number };
  fallback?: { text: string; ttftMs: number };
};

function mockProviders(opts: MockOpts) {
  const calls: { url: string; aborted: boolean }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const rec = { url, aborted: false };
    calls.push(rec);
    init?.signal?.addEventListener("abort", () => {
      rec.aborted = true;
    });

    if (url.startsWith("https://primary.test/")) {
      const primary = opts.primary ?? "hang";
      if (primary === "hang") {
        await hangUntilAbort(init?.signal);
        throw new Error("unreachable");
      }
      if (primary.status && primary.status >= 400) {
        return new Response("upstream error", { status: primary.status });
      }
      return {
        ok: true,
        body: sseBody(primary.text, primary.ttftMs, init?.signal),
      } as Response;
    }

    if (url.startsWith("https://fallback.test/")) {
      const fallback = opts.fallback ?? { text: "fallback text", ttftMs: 10 };
      return {
        ok: true,
        body: sseBody(fallback.text, fallback.ttftMs, init?.signal),
      } as Response;
    }

    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

async function sequentialFailover(
  config: AppConfig,
  timeoutMs: number,
  onPartial: (text: string) => void
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await translateCaption(config, "hello world", "en-pt", {
      signal: abort.signal,
      onPartial,
    });
  } catch {
    clearTimeout(timer);
    return translateCaption(config, "hello world", "en-pt", {
      provider: config.fallback ?? undefined,
      onPartial,
    });
  } finally {
    clearTimeout(timer);
  }
}

test("fast preferred provider never calls fallback", async () => {
  const config = testConfig();
  const calls = mockProviders({
    primary: { text: "olá mundo", ttftMs: 5 },
    fallback: { text: "fallback", ttftMs: 5 },
  });
  const out = await translateWithHedge(config, "hello world", "en-pt", {
    firstTokenMs: 200,
    timeoutMs: 1000,
    fallback: config.fallback,
  });
  assert.equal(out, "olá mundo");
  assert.equal(calls.filter((c) => c.url.startsWith("https://fallback.test/")).length, 0);
});

test("preferred HTTP error fails over without waiting for first-token timeout", async () => {
  const config = testConfig();
  mockProviders({
    primary: { text: "ignored", ttftMs: 0, status: 500 },
    fallback: { text: "texto de reserva", ttftMs: 10 },
  });
  const started = Date.now();
  const out = await translateWithHedge(config, "hello world", "en-pt", {
    firstTokenMs: 400,
    timeoutMs: 1000,
    fallbackTimeoutMs: 1000,
    fallback: config.fallback,
  });
  const took = Date.now() - started;
  assert.equal(out, "texto de reserva");
  assert.ok(took < 250, `failover after error took ${took} ms`);
});

test("skipPreferred uses only fallback", async () => {
  const config = testConfig();
  const calls = mockProviders({
    primary: { text: "primary", ttftMs: 5 },
    fallback: { text: "fallback only", ttftMs: 5 },
  });
  const out = await translateWithHedge(config, "hello world", "en-pt", {
    firstTokenMs: 200,
    timeoutMs: 1000,
    fallback: config.fallback,
    skipPreferred: true,
  });
  assert.equal(out, "fallback only");
  assert.equal(calls.filter((c) => c.url.startsWith("https://primary.test/")).length, 0);
});

test("without fallback, a silent preferred provider aborts at firstTokenMs", async () => {
  const config = testConfig();
  config.fallback = null;
  mockProviders({ primary: "hang" });
  const started = Date.now();
  await assert.rejects(
    () =>
      translateWithHedge(config, "hello world", "en-pt", {
        firstTokenMs: 80,
        timeoutMs: 1000,
      }),
    /No first translation token/
  );
  const took = Date.now() - started;
  assert.ok(took < 250, `abort took ${took} ms`);
  assert.ok(took >= 70, `abort too fast: ${took} ms`);
});

test("primary stall: hedged first token vs sequential whole-request timeout", async () => {
  const config = testConfig();
  const fallback = { text: "texto de reserva", ttftMs: 20 };

  mockProviders({ primary: "hang", fallback });
  let sequentialPartialAt = 0;
  const sequentialStarted = Date.now();
  const sequentialText = await sequentialFailover(config, 3500, () => {
    if (!sequentialPartialAt) sequentialPartialAt = Date.now();
  });
  const sequentialMs = sequentialPartialAt - sequentialStarted;

  const hedgeCalls = mockProviders({ primary: "hang", fallback });
  let hedgedPartialAt = 0;
  const hedgeStarted = Date.now();
  const stalls: string[] = [];
  const hedgedText = await translateWithHedge(config, "hello world", "en-pt", {
    firstTokenMs: 600,
    timeoutMs: 3000,
    fallbackTimeoutMs: 6000,
    fallback: config.fallback,
    onPartial: () => {
      if (!hedgedPartialAt) hedgedPartialAt = Date.now();
    },
    onPreferredStall: (why) => stalls.push(why),
  });
  const hedgedMs = hedgedPartialAt - hedgeStarted;

  console.log(
    `LATENCY before=${sequentialMs}ms after=${hedgedMs}ms ` +
      `(sequential whole-request timeout 3500ms vs first-token hedge 600ms)`
  );

  assert.equal(sequentialText, "texto de reserva");
  assert.equal(hedgedText, "texto de reserva");
  assert.deepEqual(stalls, ["no first token"]);
  assert.ok(sequentialMs >= 3450, `sequential first token at ${sequentialMs} ms`);
  assert.ok(sequentialMs < 4200, `sequential too slow: ${sequentialMs} ms`);
  assert.ok(hedgedMs >= 550, `hedge too fast: ${hedgedMs} ms`);
  assert.ok(hedgedMs < 900, `hedge too slow: ${hedgedMs} ms`);
  assert.equal(hedgeCalls.filter((c) => c.url.startsWith("https://primary.test/")).length, 1);
  assert.equal(hedgeCalls.filter((c) => c.url.startsWith("https://fallback.test/")).length, 1);
  assert.equal(hedgeCalls.find((c) => c.url.startsWith("https://primary.test/"))?.aborted, true);
});
