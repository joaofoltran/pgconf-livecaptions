import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";

async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0);
  await once(srv, "listening");
  const { port } = srv.address() as net.AddressInfo;
  srv.close();
  return port;
}

test("unauthorized socket sending an invalid frame does not crash the server", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      ROOMS: "test-room",
      TOKEN_TEST_ROOM: "test-token-at-least-16",
      ADMIN_PASSWORD: "admin-password-at-least-16",
      SESSION_SECRET: "session-secret-at-least-32-characters-long",
      DEEPGRAM_API_KEY: "dummy",
      OPENAI_API_KEY: "dummy",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("listening") && resolve());
    child.once("exit", () => reject(new Error(`server exited early: ${stderr}`)));
  });

  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  sock.write(
    "GET /ws?room=test-room&k=wrong HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
  );
  const [head] = await once(sock, "data");
  assert.match(String(head), /^HTTP\/1.1 101/);
  // FIN + reserved opcode 0x3, masked, empty payload.
  sock.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
  sock.resume();
  await once(sock, "close");

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.equal(child.exitCode, null, stderr);
});
