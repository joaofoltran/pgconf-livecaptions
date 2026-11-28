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
