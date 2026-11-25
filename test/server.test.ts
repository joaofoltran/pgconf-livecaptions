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

type Plan = { hang: true } | { ttftMs: number; doneMs?: number; text?: string };
type UpstreamRequest = { provider: "primary" | "fallback"; source: string; draft: boolean };

async function startUpstream(plan: (req: UpstreamRequest) => Plan) {
  const stats = { primary: 0, fallback: 0, open: 0, maxOpen: 0, requests: [] as UpstreamRequest[] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const info: UpstreamRequest = {
        provider: req.url?.startsWith("/primary") ? "primary" : "fallback",
        source: body.messages.at(-1)?.content ?? "",
        draft: body.messages[0].content.includes("mid-sentence"),
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
      const [head, ...rest] = (p.text ?? info.source).split(" ");
      const send = (content: string) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      timers.push(
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          send(head);
        }, p.ttftMs)
      );
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
  const captions: Array<{ seq: number; original: string; translated: string; final: boolean; at: number }> = [];
  overlay.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "caption") captions.push({ ...msg, at: Date.now() });
  });
  const send = (msg: Record<string, unknown>) => capture.send(JSON.stringify({ direction: "en-pt", ...msg }));
  const stop = () => {
    capture.close();
    overlay.close();
    child.kill();
  };
  return { captions, send, stop, log: () => log };
}

async function waitFor(what: string, check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a draft finishing during flush does not block the next sentence's draft", async () => {
  const sentenceA = "one two three four five six seven eight";
  const sentenceB = "hi there friend";
  const upstream = await startUpstream((req) =>
    req.draft && req.source === sentenceA ? { ttftMs: 0, doneMs: 300 } : { ttftMs: 0 }
  );
  const app = await startApp(upstream.base);
  try {
    app.send({ type: "interim", text: sentenceA });
    await waitFor("draft request for A", () => upstream.stats.primary === 1, 2000);
    app.send({ type: "caption", text: sentenceA, final: true, speechFinal: true });
    await waitFor("final for A", () => app.captions.some((c) => c.final), 3000);

    app.send({ type: "interim", text: sentenceB });
    await waitFor(
      "draft caption for B",
      () => app.captions.some((c) => !c.final && c.original === sentenceB),
      2000
    );
  } catch (err) {
    console.error(app.log());
    throw err;
  } finally {
    app.stop();
    upstream.close();
  }
});

test("at DRAFT_INTERVAL_MS=100 a stalled primary is hedged and trips the breaker", async () => {
  const upstream = await startUpstream((req) =>
    req.provider === "primary" ? { hang: true } : { ttftMs: 20, doneMs: 40 }
  );
  const app = await startApp(upstream.base, { DRAFT_INTERVAL_MS: "100", FIRST_TOKEN_MS: "600" });
  const spoken: string[] = ["w1", "w2"];
  const say = () => {
    spoken.push(`w${spoken.length + 1}`);
    app.send({ type: "interim", text: spoken.join(" ") });
  };
  const startedAt = Date.now();
  say();
  const speak = setInterval(say, 100);
  try {
    await waitFor("fallback-only drafts after the breaker opens", () => upstream.stats.fallback >= 4, 5000);
    const firstDraft = app.captions.find((c) => !c.final);
    assert.ok(firstDraft, "no draft reached the overlay");
    const firstDraftMs = firstDraft.at - startedAt;
    console.log(`DRAFT first caption after primary stall: ${firstDraftMs} ms`);
    assert.ok(firstDraftMs < 1500, `first draft took ${firstDraftMs} ms`);
    // Two hedged drafts reach the primary; after two failures the breaker routes
    // every draft to the fallback.
    assert.equal(upstream.stats.primary, 2);
    assert.ok(upstream.stats.maxOpen <= 4, `opened ${upstream.stats.maxOpen} concurrent streams`);
  } catch (err) {
    console.error(app.log());
    throw err;
  } finally {
    clearInterval(speak);
    app.stop();
    upstream.close();
  }
});
