import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// Runs the real server in a temp working directory, so its data/ is isolated.
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TOKEN = "room-token-at-least-16";
const PASSWORD = "admin-password-at-least-16";

type Server = {
  base: string;
  port: number;
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
};

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(cwd: string, env: Record<string, string> = {}): Promise<Server> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      PORT: String(port),
      ADMIN_PASSWORD: PASSWORD,
      SESSION_SECRET: "session-secret-at-least-32-characters-long",
      DEEPGRAM_API_KEY: "test-deepgram-key",
      OPENAI_API_KEY: "test-openai-key",
      // Nothing listens here: translation fails fast and the caption keeps its source text.
      OPENAI_BASE_URL: "http://127.0.0.1:9",
      LIVE_DRAFTS: "false",
      ROOMS: "room-1",
      TOKEN_ROOM_1: TOKEN,
      TERM_STATS_ROOMS: "room-1",
      ...env,
    },
  });
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", () => output.includes("listening") && resolve());
    void exited.then((code) => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  return { base: `http://127.0.0.1:${port}`, port, child, exited, output: () => output };
}

async function connect(server: Server, role: "capture" | "overlay"): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/ws?room=room-1&k=${TOKEN}&role=${role}`
  );
  await once(ws, "open");
  return ws;
}

// The overlay receives a final only after the server has recorded it.
function nextFinal(overlay: WebSocket): Promise<{ original: string }> {
  return new Promise((resolve, reject) => {
    overlay.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "caption" && msg.final) resolve(msg);
    });
    overlay.on("close", () => reject(new Error("overlay closed: the server went away")));
  });
}

const say = (capture: WebSocket, text: string) =>
  capture.send(JSON.stringify({ type: "caption", text, final: true, speechFinal: true }));

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));

// Working directory whose data/term-stats is prepared by `setup`.
function workDir(setup: (statsDir: string) => void = () => {}): string {
  const cwd = tempDir();
  const statsDir = path.join(cwd, "data/term-stats");
  fs.mkdirSync(statsDir, { recursive: true });
  setup(statsDir);
  return cwd;
}

async function login(server: Server): Promise<string> {
  const res = await fetch(`${server.base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.base },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function sayAndWait(server: Server, text: string): Promise<void> {
  const overlay = await connect(server, "overlay");
  const capture = await connect(server, "capture");
  const final = nextFinal(overlay);
  say(capture, text);
  await final;
  overlay.close();
  capture.close();
}

test("term routes need an admin session and clear needs the same origin", { timeout: 15_000 }, async (t) => {
  const cwd = workDir((dir) => fs.writeFileSync(path.join(dir, "room-2.json"), "{broken"));
  const server = await startServer(cwd, {
    ROOMS: "room-1,room-2",
    TOKEN_ROOM_2: "room-token-2-at-least-16",
    TERM_STATS_ROOMS: "room-1,room-2",
  });
  t.after(() => server.child.kill("SIGKILL"));
  const terms = `${server.base}/admin/api/terms/room-1`;

  assert.equal((await fetch(terms)).status, 401);
  assert.equal((await fetch(`${terms}?format=txt`)).status, 401);
  const anonymousClear = await fetch(`${terms}/clear`, {
    method: "POST",
    headers: { Origin: server.base },
  });
  assert.equal(anonymousClear.status, 401);

  const cookie = await login(server);
  assert.equal((await (await fetch(terms, { headers: { cookie } })).json()).room, "room-1");
  const crossSite = await fetch(`${terms}/clear`, {
    method: "POST",
    headers: { cookie, Origin: "https://evil.example" },
  });
  assert.equal(crossSite.status, 403);
  const clear = await fetch(`${terms}/clear`, {
    method: "POST",
    headers: { cookie, Origin: server.base },
  });
  assert.equal(clear.status, 200);

  const status = await (await fetch(`${server.base}/admin/api/status`, { headers: { cookie } })).json();
  const room2 = status.rooms.find((r: { id: string }) => r.id === "room-2");
  assert.match(room2.termStatsError, /room-2 are unreadable/);
  const broken = await fetch(`${server.base}/admin/api/terms/room-2`, { headers: { cookie } });
  assert.equal(broken.status, 500);
  assert.match((await broken.json()).error, /room-2 are unreadable/);
});

test("SIGTERM writes batched counts before exiting", { timeout: 15_000 }, async (t) => {
  const cwd = workDir();
  const server = await startServer(cwd);
  t.after(() => server.child.kill("SIGKILL"));
  const file = path.join(cwd, "data/term-stats/room-1.json");

  await sayAndWait(server, "Logical replication slots.");
  assert.equal(fs.existsSync(file), false, "still batched");
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.terms["logical replication"], 1);
});

test("a failed final write on SIGTERM is logged and exits 1", { timeout: 15_000 }, async (t) => {
  // A directory where the temp file goes makes every write fail.
  const cwd = workDir((dir) => fs.mkdirSync(path.join(dir, "room-1.json.tmp")));
  const server = await startServer(cwd);
  t.after(() => server.child.kill("SIGKILL"));

  await sayAndWait(server, "Logical replication slots.");
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 1);
  assert.match(server.output(), /final write failed on shutdown/);
});

test("capture input is bounded and malformed messages are ignored", { timeout: 15_000 }, async (t) => {
  const server = await startServer(tempDir());
  t.after(() => server.child.kill("SIGKILL"));
  const overlay = await connect(server, "overlay");
  const capture = await connect(server, "capture");

  const first = nextFinal(overlay);
  capture.send("null");
  say(capture, "too long ".repeat(300));
  say(capture, "Logical replication.");
  assert.equal((await first).original, "Logical replication.");

  const closed = once(capture, "close");
  capture.send("x".repeat(100 * 1024));
  assert.equal((await closed)[0], 1009);
});
