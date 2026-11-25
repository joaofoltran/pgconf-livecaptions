import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";

// Runs the real server against a local OpenAI-compatible mock so draft, flush,
// hedge, and breaker behavior is exercised end to end.

const TOKEN = "room-token-at-least-16";

type Plan =
  | { hang: true }
  | { status: number }
  // freeze: stream the first word, then never finish.
  | { ttftMs: number; doneMs?: number; text?: string; freeze?: boolean };
type Provider = "primary" | "fallback" | "final";
type UpstreamRequest = { provider: Provider; source: string; system: string; draft: boolean };

async function startUpstream(plan: (req: UpstreamRequest) => Plan) {
  const stats = { primary: 0, fallback: 0, final: 0, open: 0, maxOpen: 0, requests: [] as UpstreamRequest[] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const system = body.messages[0].content;
      const info: UpstreamRequest = {
        provider: (req.url?.split("/")[1] ?? "primary") as Provider,
        source: body.messages.at(-1)?.content ?? "",
        system,
        draft: system.includes("mid-sentence"),
      };
      stats.requests.push(info);
      stats[info.provider]++;
      stats.open++;
      stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      const timers: NodeJS.Timeout[] = [];
      res.on("close", () => {
        stats.open--;
        timers.forEach(clearTimeout);
      });

      const p = plan(info);
      if ("hang" in p) return;
      if ("status" in p) {
        res.writeHead(p.status).end("upstream error");
        return;
      }
      // Each provider tags its output so tests can tell who produced a caption.
      const [head, ...rest] = (p.text ?? `${info.provider} ${info.source}`).split(" ");
      const send = (content: string) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      timers.push(
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          send(head);
        }, p.ttftMs)
      );
      if (p.freeze) return;
      timers.push(
        setTimeout(() => {
          if (rest.length) send(` ${rest.join(" ")}`);
          res.end("data: [DONE]\n\n");
        }, p.doneMs ?? p.ttftMs)
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, stats, close: () => server.close() };
}

async function freePort(): Promise<number> {
  const server = http.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  return port;
}

type Caption = { seq: number; original: string; translated: string; final: boolean; at: number };

async function startApp(upstream: string, env: Record<string, string> = {}) {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      PORT: String(port),
      ADMIN_PASSWORD: "admin-password-at-least-16",
      SESSION_SECRET: "session-secret-at-least-32-characters-long",
      DEEPGRAM_API_KEY: "deepgram-test-key",
      OPENAI_API_KEY: "primary-key",
      OPENAI_BASE_URL: `${upstream}/primary`,
      OPENAI_MODEL: "primary-model",
      FALLBACK_API_KEY: "fallback-key",
      FALLBACK_BASE_URL: `${upstream}/fallback`,
      FALLBACK_MODEL: "fallback-model",
      ROOMS: "room-1",
      TOKEN_ROOM_1: TOKEN,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", (d) => (log += d));
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      log += d;
      if (String(d).includes("listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`server exited ${code}\n${log}`)));
  });

  const connect = async (role: "capture" | "overlay") => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=room-1&k=${TOKEN}&role=${role}`);
    await once(ws, "open");
    return ws;
  };
  const capture = await connect("capture");
  const overlay = await connect("overlay");
  const captions: Caption[] = [];
  overlay.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "caption") captions.push({ ...msg, at: Date.now() });
  });
  const send = (msg: Record<string, unknown>) => capture.send(JSON.stringify({ direction: "en-pt", ...msg }));
  const sayFinal = (text: string) => send({ type: "caption", text, final: true, speechFinal: true });
  const stop = () => {
    capture.close();
    overlay.close();
    child.kill();
  };
  return { captions, send, sayFinal, stop, log: () => log };
}

async function waitFor(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const producer = (c: Caption) => c.translated.split(" ")[0].toLowerCase();

async function scenario(
  plan: (req: UpstreamRequest) => Plan,
  env: Record<string, string> | ((upstream: string) => Record<string, string>),
  body: (app: Awaited<ReturnType<typeof startApp>>, upstream: Awaited<ReturnType<typeof startUpstream>>) => Promise<void>
) {
  const upstream = await startUpstream(plan);
  const app = await startApp(upstream.base, typeof env === "function" ? env(upstream.base) : env);
  try {
    await body(app, upstream);
  } catch (err) {
    console.error(app.log());
    throw err;
  } finally {
    app.stop();
    upstream.close();
  }
}

test("a draft finishing during flush does not block the next sentence's draft", async () => {
  const sentenceA = "one two three four five six seven eight";
  const sentenceB = "hi there friend";
  await scenario(
    (req) => (req.draft && req.source === sentenceA ? { ttftMs: 0, doneMs: 300 } : { ttftMs: 0 }),
    {},
    async (app, upstream) => {
      app.send({ type: "interim", text: sentenceA });
      await waitFor("draft request for A", () => upstream.stats.primary === 1, 2000);
      app.sayFinal(sentenceA);
      await waitFor("final for A", () => app.captions.some((c) => c.final), 3000);

      app.send({ type: "interim", text: sentenceB });
      await waitFor("draft caption for B", () => app.captions.some((c) => !c.final && c.original === sentenceB), 2000);
    }
  );
});

test("at DRAFT_INTERVAL_MS=100 a stalled primary is hedged and trips the breaker", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { hang: true } : { ttftMs: 20, doneMs: 40 }),
    { DRAFT_INTERVAL_MS: "100", FIRST_TOKEN_MS: "600" },
    async (app, upstream) => {
      const spoken: string[] = ["w1", "w2"];
      const say = () => {
        spoken.push(`w${spoken.length + 1}`);
        app.send({ type: "interim", text: spoken.join(" ") });
      };
      const startedAt = Date.now();
      say();
      const speak = setInterval(say, 100);
      try {
        await waitFor("breaker to open", () => app.log().includes("degraded"), 5000);
        const firstDraft = app.captions.find((c) => !c.final);
        assert.ok(firstDraft, "no draft reached the overlay");
        const firstDraftMs = firstDraft.at - startedAt;
        console.log(`DRAFT first caption after primary stall: ${firstDraftMs} ms`);
        assert.ok(firstDraftMs < 1500, `first draft took ${firstDraftMs} ms`);
        // Drafts kept their slots until their hedge fired: none was evicted early.
        const primaryAtOpen = upstream.stats.primary;
        const fallbackAtOpen = upstream.stats.fallback;
        await waitFor("fallback-only drafts", () => upstream.stats.fallback >= fallbackAtOpen + 4, 3000);
        assert.equal(upstream.stats.primary, primaryAtOpen, "breaker open: no new primary requests");
        assert.ok(upstream.stats.maxOpen <= 8, `opened ${upstream.stats.maxOpen} concurrent streams`);
      } finally {
        clearInterval(speak);
      }
    }
  );
});

test("a primary that freezes after its first token fails over with the shown prefix", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 0, freeze: true } : { ttftMs: 20 }),
    { LIVE_DRAFTS: "false" },
    async (app, upstream) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 6000);
      const final = app.captions.find((c) => c.final)!;
      assert.equal(producer(final), "fallback", `final was "${final.translated}"`);
      const retry = upstream.stats.requests.find((r) => r.provider === "fallback");
      assert.match(retry?.system ?? "", /beginning verbatim with "primary"/);
      assert.match(app.log(), /primary-model error after first token/, "counted toward the breaker");
    }
  );
});

test("a slow primary that still wins the hedge race is not counted as a failure", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 700, doneMs: 720 } : { ttftMs: 400, doneMs: 420 }),
    {},
    async (app, upstream) => {
      for (const text of ["alpha beta gamma", "alpha beta gamma delta", "alpha beta gamma delta epsilon"]) {
        app.send({ type: "interim", text });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      app.sayFinal("alpha beta gamma delta epsilon zeta");
      await waitFor("final", () => app.captions.some((c) => c.final), 4000);
      assert.ok(upstream.stats.fallback > 0, "hedges fired");
      assert.deepEqual(new Set(app.captions.map(producer)), new Set(["primary"]));
      assert.doesNotMatch(app.log(), /no first token|degraded/);
    }
  );
});

test("a final over a visible draft replaces it in one step instead of streaming", async () => {
  await scenario(
    (req) => (req.draft ? { ttftMs: 0 } : { ttftMs: 0, doneMs: 300 }),
    {},
    async (app) => {
      app.send({ type: "interim", text: "one two three four five six seven eightx" });
      await waitFor("draft", () => app.captions.some((c) => !c.final), 2000);
      app.sayFinal("one two three four five six seven eight.");
      await waitFor("final", () => app.captions.some((c) => c.final), 3000);
      const final = app.captions.find((c) => c.final)!;
      const partials = app.captions.filter((c) => !c.final && c.seq === final.seq);
      assert.deepEqual(partials, [], "a one-word partial would replace the eight-word draft");
    }
  );
});

test("without a fallback, a slow single provider still translates the final", async () => {
  await scenario(
    () => ({ ttftMs: 900, doneMs: 950 }),
    { FALLBACK_API_KEY: "", LIVE_DRAFTS: "false" },
    async (app) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 4000);
      assert.equal(producer(app.captions.find((c) => c.final)!), "primary");
    }
  );
});

test("a slower FINAL_* provider is not hedged after FIRST_TOKEN_MS", async () => {
  await scenario(
    (req) => (req.provider === "final" ? { ttftMs: 900, doneMs: 950 } : { ttftMs: 20 }),
    (base) => ({
      FINAL_API_KEY: "final-key",
      FINAL_BASE_URL: `${base}/final`,
      FINAL_MODEL: "final-model",
      LIVE_DRAFTS: "false",
    }),
    async (app, upstream) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 4000);
      assert.equal(producer(app.captions.find((c) => c.final)!), "final");
      assert.equal(upstream.stats.fallback, 0);
    }
  );
});

test("a final gets one more fallback attempt when every attempt failed", async () => {
  let fallbackFinals = 0;
  await scenario(
    (req) =>
      req.provider === "primary" ? { hang: true } : ++fallbackFinals === 1 ? { status: 500 } : { ttftMs: 20 },
    { LIVE_DRAFTS: "false", FIRST_TOKEN_MS: "200" },
    async (app) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 6000);
      assert.equal(producer(app.captions.find((c) => c.final)!), "fallback");
    }
  );
});

// Headline latency on the real server: rerun with `npx tsx --test test/server.test.ts`
// and read the LATENCY line. Before the hedge, a stalled primary cost the whole
// 3.5 s final timeout plus the fallback's own first token.
test("primary stall: the final arrives after FIRST_TOKEN_MS plus the fallback's first token", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { hang: true } : { ttftMs: 900, doneMs: 950 }),
    { LIVE_DRAFTS: "false" },
    async (app, upstream) => {
      const startedAt = Date.now();
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 6000);
      const finalMs = app.captions.find((c) => c.final)!.at - startedAt;
      console.log(`LATENCY final after primary stall, fallback first token 900 ms: ${finalMs} ms`);
      assert.ok(finalMs >= 1400 && finalMs < 2500, `final took ${finalMs} ms`);
      await waitFor("losing primary stream cancelled", () => upstream.stats.open === 0, 1000);
    }
  );
});
