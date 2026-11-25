import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { translateWithHedge } from "../src/translate.js";

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

function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true }
    );
  });
}

type Stream = { text: string; ttftMs: number; failAfterFirst?: boolean; status?: number };

function sseBody(stream: Stream, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        await waitOrAbort(stream.ttftMs, signal);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: stream.text } }] })}\n\n`)
        );
        if (stream.failAfterFirst) throw new Error("socket hang up");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

type Call = { provider: "primary" | "fallback"; system: string; body: Record<string, unknown>; aborted: boolean };

function mockProviders(opts: { primary: Stream | "hang"; fallback?: Stream }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const provider = String(input).startsWith("https://primary.test/") ? "primary" : "fallback";
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const call: Call = { provider, system: body.messages[0].content, body, aborted: false };
    calls.push(call);
    init?.signal?.addEventListener("abort", () => (call.aborted = true));

    const stream = provider === "primary" ? opts.primary : opts.fallback ?? { text: "fallback", ttftMs: 10 };
    if (stream === "hang") {
      await waitOrAbort(60_000, init?.signal);
      throw new Error("unreachable");
    }
    if (stream.status) return new Response("upstream error", { status: stream.status });
    return { ok: true, body: sseBody(stream, init?.signal) } as Response;
  }) as typeof fetch;
  const count = (provider: Call["provider"]) => calls.filter((c) => c.provider === provider).length;
  return { calls, count };
}

const hedge = (config: AppConfig, extra: Partial<Parameters<typeof translateWithHedge>[3]> = {}) =>
  translateWithHedge(config, "hello world", "en-pt", {
    firstTokenMs: 600,
    timeoutMs: 3000,
    fallbackTimeoutMs: 6000,
    fallback: config.fallback,
    ...extra,
  });

test("fast preferred provider never calls fallback", async () => {
  const config = testConfig();
  const mock = mockProviders({ primary: { text: "olá mundo", ttftMs: 5 } });
  let successes = 0;
  assert.equal(await hedge(config, { onPreferredSuccess: () => successes++ }), "olá mundo");
  assert.equal(mock.count("fallback"), 0);
  assert.equal(successes, 1);
});

test("preferred HTTP error fails over without waiting for the first-token window", async () => {
  const config = testConfig();
  mockProviders({
    primary: { text: "", ttftMs: 0, status: 500 },
    fallback: { text: "texto de reserva", ttftMs: 10 },
  });
  const failures: string[] = [];
  const started = Date.now();
  const out = await hedge(config, { onPreferredFailure: (why) => failures.push(why) });
  assert.equal(out, "texto de reserva");
  assert.ok(Date.now() - started < 400, `failover took ${Date.now() - started} ms`);
  assert.deepEqual(failures, ["error"]);
});

test("without a fallback, a slow first token is not a timeout", async () => {
  const config = testConfig();
  config.fallback = null;
  mockProviders({ primary: { text: "devagar", ttftMs: 250 } });
  const failures: string[] = [];
  const out = await hedge(config, { firstTokenMs: 50, onPreferredFailure: (why) => failures.push(why) });
  assert.equal(out, "devagar");
  assert.deepEqual(failures, []);
});

test("a preferred stream failing after its first token continues on the fallback", async () => {
  const config = testConfig();
  config.fallback = { ...config.fallback!, extraBody: { reasoning_effort: "low" } };
  const mock = mockProviders({
    primary: { text: "Olá", ttftMs: 5, failAfterFirst: true },
    fallback: { text: "Olá mundo", ttftMs: 10 },
  });
  const failures: string[] = [];
  const partials: string[] = [];
  const out = await hedge(config, {
    onPartial: (p) => partials.push(p),
    onPreferredFailure: (why) => failures.push(why),
  });
  assert.equal(out, "Olá mundo");
  assert.deepEqual(partials, ["Olá", "Olá mundo"]);
  assert.deepEqual(failures, ["error after first token"], "counted once toward the breaker");
  const retry = mock.calls.find((c) => c.provider === "fallback");
  assert.match(retry?.system ?? "", /beginning verbatim with "Olá"/);
  assert.equal(retry?.body.reasoning_effort, "low", "fallback extra body is merged into the request");
});

test("a preferred timeout is reported even if the caller aborts before the fallback answers", async () => {
  const config = testConfig();
  mockProviders({ primary: "hang", fallback: { text: "tarde", ttftMs: 5000 } });
  const abort = new AbortController();
  const failures: string[] = [];
  setTimeout(() => abort.abort(), 400);
  await assert.rejects(
    hedge(config, {
      firstTokenMs: 100,
      timeoutMs: 250,
      signal: abort.signal,
      onPreferredFailure: (why) => failures.push(why),
    })
  );
  assert.deepEqual(failures, ["error"]);
});

test("a caller abort is not reported as a preferred failure", async () => {
  const config = testConfig();
  mockProviders({ primary: "hang" });
  const abort = new AbortController();
  const failures: string[] = [];
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(hedge(config, { signal: abort.signal, onPreferredFailure: (why) => failures.push(why) }));
  assert.deepEqual(failures, []);
});