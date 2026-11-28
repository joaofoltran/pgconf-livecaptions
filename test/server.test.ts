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
type UpstreamRequest = {
  provider: Provider;
  source: string;
  system: string;
  draft: boolean;
  context?: string;
  completed?: boolean;
};

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
        context: body.messages.length > 2 ? body.messages[1].content : undefined,
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
          info.completed = true;
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
  const admin = async (path: string, method = "GET") => {
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ password: "admin-password-at-least-16" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    return fetch(`${base}/admin/api/${path}`, { method, headers: { cookie, Origin: base } });
  };
  const transcript = async (): Promise<Array<{ original: string }>> => {
    const res = await admin("transcript/room-1");
    return ((await res.json()) as { transcript: Array<{ original: string }> }).transcript;
  };
  const reset = async () => assert.equal((await admin("reset/room-1", "POST")).status, 200);
  return {
    captions,
    send,
    sayFinal,
    stop,
    transcript,
    reset,
    dropCapture: () => capture.close(),
    replaceCapture: () => connect("capture"),
    log: () => log,
  };
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

test("a short remark right after a sentence does not drop that sentence's final", async () => {
  const sentence = "one two three four five six";
  await scenario(
    // Only a retranslation of the sentence is extra slow: reusing its draft is the fix.
    (req) => (req.source === sentence && !req.draft ? { ttftMs: 700, doneMs: 1100 } : { ttftMs: 700, doneMs: 800 }),
    { FALLBACK_START_MS: "1000", PRIMARY_CUTOFF_MS: "2000" },
    async (app) => {
      app.send({ type: "interim", text: sentence });
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.sayFinal(`${sentence}.`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      app.sayFinal("Okay.");
      await waitFor("remark final", () => app.captions.some((c) => c.final && c.original === "Okay."), 3000);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const finals = app.captions.filter((c) => c.final).map((c) => c.original);
      assert.deepEqual(finals, [`${sentence}.`, "Okay."]);
    }
  );
});

test("a remark that finishes with the slower sentence before it is shown 1.5 s later, without holding up drafts", async () => {
  const sentence = "one two three four.";
  await scenario(
    // The sentence waits for the silent primary's cutoff even though the fallback has finished.
    (req) => (req.source === sentence ? (req.provider === "primary" ? { hang: true } : { ttftMs: 20, doneMs: 40 }) : { ttftMs: 20 }),
    {},
    async (app, upstream) => {
      app.sayFinal(sentence);
      await new Promise((resolve) => setTimeout(resolve, 300));
      app.sayFinal("Okay.");
      await waitFor("the slow sentence", () => app.captions.some((c) => c.final), 3000);
      // Both finals are ready now; the next sentence's drafts must not wait for the remark.
      app.send({ type: "interim", text: "five six seven" });
      await waitFor("both finals", () => app.captions.filter((c) => c.final).length === 2, 3000);
      const finals = app.captions.filter((c) => c.final);
      assert.deepEqual(finals.map((c) => c.original), [sentence, "Okay."]);
      assert.equal(producer(finals[0]), "fallback");
      const shownFor = finals[1].at - finals[0].at;
      assert.ok(shownFor >= 1450, `the slow sentence was on screen for ${shownFor} ms`);
      const draft = app.captions.find((c) => !c.final && c.original === "five six seven");
      assert.ok(draft && draft.at < finals[1].at, "a draft of the next sentence was shown during the wait");

      app.sayFinal("five six seven eight.");
      await waitFor("third final", () => app.captions.filter((c) => c.final).length === 3, 4000);
      const next = upstream.stats.requests.filter((r) => r.source.startsWith("five six"));
      assert.deepEqual([...new Set(next.map((r) => r.context))], ["Okay."], "context is the sentence spoken just before");
      const transcript = (await app.transcript()).map((l) => l.original);
      assert.deepEqual(transcript, [sentence, "Okay.", "five six seven eight."]);
    }
  );
});

test("a final held on screen is not shown after a reset, a capture disconnect or a capture replacement, and only a reset drops it from the transcript", async () => {
  const sentence = "one two three four.";
  for (const event of ["reset", "disconnect", "replace"] as const) {
    await scenario(
      (req) => (req.source === sentence ? (req.provider === "primary" ? { hang: true } : { ttftMs: 20 }) : { ttftMs: 20 }),
      { LIVE_DRAFTS: "false" },
      async (app) => {
        app.sayFinal(sentence);
        await new Promise((resolve) => setTimeout(resolve, 300));
        app.sayFinal("Okay.");
        await waitFor("the slow sentence", () => app.captions.some((c) => c.final), 3000);
        if (event === "reset") await app.reset();
        else if (event === "disconnect") app.dropCapture();
        else await app.replaceCapture();
        await new Promise((resolve) => setTimeout(resolve, 1800));
        assert.deepEqual(app.captions.filter((c) => c.final).map((c) => c.original), [sentence], event);
        const transcript = (await app.transcript()).map((l) => l.original);
        assert.deepEqual(transcript, event === "reset" ? [] : [sentence, "Okay."], event);
      }
    );
  }
});

test("a final still translating when the room is reset never reaches the new session", async () => {
  const sentence = "one two three four.";
  await scenario(
    // The first sentence's primary hangs; the fallback starts streaming after the reset
    // (at about 1.4 s) and finishes at about 3 s.
    (req) => (req.source === sentence ? (req.provider === "primary" ? { hang: true } : { ttftMs: 900, doneMs: 2500 }) : { ttftMs: 20 }),
    { LIVE_DRAFTS: "false" },
    async (app, upstream) => {
      app.sayFinal(sentence);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await app.reset();
      const resetAt = Date.now();
      // Past the old sentence's first fallback words, which must not flash on the cleared overlay.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const saidAt = Date.now();
      app.sayFinal("five six seven.");
      await waitFor("the first final after the reset", () => app.captions.some((c) => c.final), 3000);
      const firstAfter = app.captions.find((c) => c.final)!.at - saidAt;
      assert.ok(firstAfter < 400, `the first final after the reset waited ${firstAfter} ms for the old one`);
      await waitFor("the old sentence to settle", () => upstream.stats.requests.some((r) => r.source === sentence && r.completed), 4000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      app.sayFinal("eight nine ten.");
      await waitFor("the second final after the reset", () => app.captions.filter((c) => c.final).length === 2, 3000);
      const after = ["five six seven.", "eight nine ten."];
      assert.deepEqual(app.captions.filter((c) => c.final).map((c) => c.original), after);
      const shownAfterReset = app.captions.filter((c) => c.at >= resetAt).map((c) => c.original);
      assert.deepEqual([...new Set(shownAfterReset)], after, "no words from before the reset");
      assert.deepEqual((await app.transcript()).map((l) => l.original), after);
      const context = upstream.stats.requests.find((r) => r.source === "eight nine ten.")?.context;
      assert.equal(context, "five six seven.", "the context is the last sentence of the new session");
    }
  );
});

test("four finals released together are shown within about 3 s, so the top line never falls far behind", async () => {
  const sentence = "one two three four.";
  const remarks = ["Okay.", "Right.", "Yes."];
  await scenario(
    (req) => (req.source === sentence ? (req.provider === "primary" ? { hang: true } : { ttftMs: 20 }) : { ttftMs: 20 }),
    { LIVE_DRAFTS: "false" },
    async (app) => {
      app.sayFinal(sentence);
      for (const remark of remarks) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        app.sayFinal(remark);
      }
      await waitFor("all finals", () => app.captions.filter((c) => c.final).length === 4, 6000);
      const finals = app.captions.filter((c) => c.final);
      assert.deepEqual(finals.map((c) => c.original), [sentence, ...remarks]);
      const spread = finals[3].at - finals[0].at;
      assert.ok(spread >= 2900 && spread < 3500, `the last of four was shown ${spread} ms after the first`);
    }
  );
});

test("a final spoken during a 3 s or 4 s outage of both providers is shown before the next one", async () => {
  for (const outageMs of [3000, 4000]) {
    const outageEnd = Date.now() + outageMs;
    await scenario(
      () => (Date.now() < outageEnd ? { hang: true } : { ttftMs: 20 }),
      { LIVE_DRAFTS: "false" },
      async (app) => {
        app.sayFinal("one two three four.");
        await new Promise((resolve) => setTimeout(resolve, outageEnd + 300 - Date.now()));
        app.sayFinal("five six seven eight.");
        await waitFor("both finals", () => app.captions.filter((c) => c.final).length === 2, 8000);
        const finals = app.captions.filter((c) => c.final);
        assert.deepEqual(finals.map((c) => c.original), ["one two three four.", "five six seven eight."]);
        assert.notEqual(finals[0].translated, finals[0].original, `translated after the ${outageMs} ms outage`);
      }
    );
  }
});

test("a cutoff counts as a breaker failure", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { hang: true } : { ttftMs: 20 }),
    { LIVE_DRAFTS: "false", BREAKER_FAILURE_THRESHOLD: "1" },
    async (app) => {
      app.sayFinal("one two three four.");
      await waitFor("final", () => app.captions.some((c) => c.final), 3000);
      assert.match(app.log(), /no first token/);
      assert.match(app.log(), /primary-model degraded/);
    }
  );
});

test("at DRAFT_INTERVAL_MS=100 a silent primary opens the breaker, and later drafts skip the fallback wait", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { hang: true } : { ttftMs: 20, doneMs: 40 }),
    { DRAFT_INTERVAL_MS: "100" },
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
        await waitFor("breaker to open", () => app.log().includes("degraded"), 6000);
        const firstDraft = app.captions.find((c) => !c.final);
        assert.ok(firstDraft, "no draft reached the overlay");
        const firstDraftMs = firstDraft.at - startedAt;
        console.log(`DRAFT first caption after primary stall: ${firstDraftMs} ms`);
        assert.ok(firstDraftMs < 1200, `first draft took ${firstDraftMs} ms, waiting for the cutoff`);
        const primaryAtOpen = upstream.stats.primary;
        const fallbackAtOpen = upstream.stats.fallback;
        await waitFor("fallback-only drafts", () => upstream.stats.fallback >= fallbackAtOpen + 4, 3000);
        assert.equal(upstream.stats.primary, primaryAtOpen, "breaker open: no new primary requests");
        clearInterval(speak);
        const before = app.captions.length;
        const at = Date.now();
        say();
        await waitFor("next draft", () => app.captions.length > before, 2000);
        const tookMs = app.captions.at(-1)!.at - at;
        assert.ok(tookMs < 450, `draft took ${tookMs} ms; it should not wait FALLBACK_START_MS`);
        assert.ok(upstream.stats.maxOpen <= 8, `opened ${upstream.stats.maxOpen} concurrent streams`);
      } finally {
        clearInterval(speak);
      }
    }
  );
});

test("after the breaker's open time, one retry goes back to a recovered primary", async () => {
  let recovered = false;
  await scenario(
    (req) => (req.provider === "primary" && !recovered ? { hang: true } : { ttftMs: 20 }),
    // 7000 is the shortest open time allowed.
    { LIVE_DRAFTS: "false", BREAKER_FAILURE_THRESHOLD: "1", BREAKER_OPEN_MS: "7000" },
    async (app, upstream) => {
      app.sayFinal("one two three four.");
      await waitFor("breaker to open", () => app.log().includes("degraded"), 3000);
      const openedAt = Date.now();
      recovered = true;
      app.sayFinal("five six seven.");
      await waitFor("second final", () => app.captions.filter((c) => c.final).length === 2, 3000);
      assert.equal(producer(app.captions.filter((c) => c.final)[1]), "fallback", "still open: straight to the fallback");
      await waitFor("open time to end", () => Date.now() >= openedAt + 7000, 8000);
      for (const text of ["eight nine ten.", "eleven twelve."]) {
        app.sayFinal(text);
        await waitFor(text, () => app.captions.some((c) => c.final && c.original === text), 3000);
      }
      const finals = app.captions.filter((c) => c.final).map(producer);
      assert.deepEqual(finals.slice(2), ["primary", "primary"], "the retry succeeded and the breaker closed");
      assert.ok(upstream.stats.primary >= 3);
    }
  );
});

test("a primary that returns errors opens the breaker, and later drafts and finals skip it", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { status: 500 } : { ttftMs: 20, doneMs: 40 }),
    { BREAKER_FAILURE_THRESHOLD: "2" },
    async (app, upstream) => {
      for (const text of ["alpha beta gamma", "alpha beta gamma delta"]) {
        app.send({ type: "interim", text });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await waitFor("breaker to open", () => app.log().includes("degraded"), 3000);
      const primaryAtOpen = upstream.stats.primary;
      app.send({ type: "interim", text: "alpha beta gamma delta epsilon" });
      app.sayFinal("alpha beta gamma delta epsilon zeta");
      await waitFor("final", () => app.captions.some((c) => c.final), 3000);
      assert.equal(producer(app.captions.find((c) => c.final)!), "fallback");
      assert.equal(upstream.stats.primary, primaryAtOpen, "breaker open: no new primary requests");
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

test("a primary slower than the fallback start but before the cutoff serves drafts and finals", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 800, doneMs: 820 } : { ttftMs: 20, doneMs: 40 }),
    {},
    async (app, upstream) => {
      for (const text of ["alpha beta gamma", "alpha beta gamma delta", "alpha beta gamma delta epsilon"]) {
        app.send({ type: "interim", text });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      app.sayFinal("alpha beta gamma delta epsilon zeta");
      await waitFor("final", () => app.captions.some((c) => c.final), 4000);
      assert.ok(upstream.stats.fallback > 0, "the fallback started");
      assert.equal(producer(app.captions.find((c) => c.final)!), "primary");
      assert.doesNotMatch(app.log(), /no first token|degraded/);
      assert.match(app.log(), /first token room-1 draft primary primary-model \d+ ms/);
    }
  );
});

test("a draft shows the fallback's text, then the primary's if it starts before the cutoff", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 800, doneMs: 820 } : { ttftMs: 20, doneMs: 40 }),
    {},
    async (app) => {
      const startedAt = Date.now();
      app.send({ type: "interim", text: "alpha beta gamma" });
      await waitFor("swap", () => app.captions.some((c) => producer(c) === "primary"), 3000);
      assert.deepEqual(app.captions.map(producer), ["fallback", "primary"]);
      assert.equal(app.captions[0].seq, app.captions[1].seq);
      assert.ok(app.captions[0].at - startedAt < 800, "the fallback's draft showed before the primary started");
    }
  );
});

test("a final on an empty line shows the fallback, then swaps to the primary", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 800, doneMs: 850 } : { ttftMs: 20, doneMs: 600 }),
    { LIVE_DRAFTS: "false" },
    async (app) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 3000);
      const seqs = new Set(app.captions.map((c) => c.seq));
      assert.equal(seqs.size, 1, "the swap rewrites the same caption");
      assert.deepEqual(
        app.captions.map((c) => `${producer(c)}${c.final ? " final" : ""}`),
        ["fallback", "primary", "primary", "primary final"]
      );
    }
  );
});

test("a primary past the cutoff is cancelled for drafts and finals, and the fallback's text stays", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { ttftMs: 1700, doneMs: 1720 } : { ttftMs: 20, doneMs: 40 }),
    {},
    async (app, upstream) => {
      for (const text of ["alpha beta gamma", "alpha beta gamma delta"]) {
        app.send({ type: "interim", text });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      app.sayFinal("alpha beta gamma delta epsilon");
      await waitFor("final", () => app.captions.some((c) => c.final), 4000);
      assert.deepEqual(new Set(app.captions.map(producer)), new Set(["fallback"]));
      assert.ok(upstream.stats.requests.every((r) => r.provider !== "primary" || !r.completed), "primary cut off");
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

test("a slower FINAL_* provider is not hedged at FALLBACK_START_MS", async () => {
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
      assert.match(app.log(), /first token room-1 final final final-model \d+ ms/, "logged under the final role");
    }
  );
});

test("a final gets one more fallback attempt when every attempt failed", async () => {
  let fallbackFinals = 0;
  await scenario(
    (req) =>
      req.provider === "primary" ? { hang: true } : ++fallbackFinals === 1 ? { status: 500 } : { ttftMs: 20 },
    { LIVE_DRAFTS: "false" },
    async (app) => {
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 6000);
      assert.equal(producer(app.captions.find((c) => c.final)!), "fallback");
    }
  );
});

test("in a full outage the final retry does not hold the source text back", async () => {
  let fallbackFinals = 0;
  await scenario(
    (req) => (req.provider === "primary" || ++fallbackFinals === 1 ? { status: 500 } : { hang: true }),
    { LIVE_DRAFTS: "false" },
    async (app) => {
      const startedAt = Date.now();
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 3000);
      const final = app.captions.find((c) => c.final)!;
      assert.equal(final.translated, final.original, "source text as the last resort");
      const finalMs = final.at - startedAt;
      assert.ok(finalMs >= 1400 && finalMs < 2500, `final took ${finalMs} ms`);
    }
  );
});

// Headline latency on the real server: rerun with `npx tsx --test test/server.test.ts`
// and read the LATENCY line. Before any hedge, a stalled primary cost the whole
// 3.5 s final timeout plus the fallback's own first token.
test("primary stall: the final arrives at the primary cutoff when the fallback is faster", async () => {
  await scenario(
    (req) => (req.provider === "primary" ? { hang: true } : { ttftMs: 900, doneMs: 950 }),
    { LIVE_DRAFTS: "false" },
    async (app, upstream) => {
      const startedAt = Date.now();
      app.sayFinal("one two three four");
      await waitFor("final", () => app.captions.some((c) => c.final), 6000);
      const finalMs = app.captions.find((c) => c.final)!.at - startedAt;
      console.log(`LATENCY final after primary stall, fallback first token 900 ms: ${finalMs} ms`);
      assert.ok(finalMs >= 1400 && finalMs < 2200, `final took ${finalMs} ms`);
      await waitFor("losing primary stream cancelled", () => upstream.stats.open === 0, 1000);
    }
  );
});
