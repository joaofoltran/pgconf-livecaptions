#!/usr/bin/env node
// Mostra, sem tocar em nada, quais salas estão capturando agora e quantos overlays
// (OBS) estão conectados. Útil antes de um deploy: só reinicie com todas offline.
//
//   node scripts/rooms-status.mjs "https://host/r/room-1?k=T1" "https://host/r/room-2?k=T2" ...
//
// Ou LC_ROOM_URLS=url1,url2,... no .env.test.

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

loadEnvFile(path.resolve(process.cwd(), ".env.test"));
const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (process.env.LC_ROOM_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (!urls.length) {
  console.error("Passe as URLs de captura como argumentos ou defina LC_ROOM_URLS no .env.test");
  process.exit(1);
}

const rows = await Promise.all(urls.map(statusOf));
for (const row of rows) console.log(row);

async function statusOf(captureUrl) {
  const u = new URL(captureUrl);
  const room = u.pathname.split("/").filter(Boolean)[1];
  const k = u.searchParams.get("k") ?? "";
  const ws = `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/ws?room=${room}&k=${encodeURIComponent(k)}&role=overlay`;
  return new Promise((resolve) => {
    const sock = new WebSocket(ws);
    const timer = setTimeout(() => {
      sock.terminate();
      resolve(`${room.padEnd(8)} sem resposta`);
    }, 6000);
    sock.on("message", (raw) => {
      const s = JSON.parse(raw.toString());
      if (s.type !== "status") return;
      clearTimeout(timer);
      sock.close();
      const cap = s.captureOnline ? "CAPTURANDO" : "offline   ";
      const last = s.lastCaption?.translated ? ` · última: "${s.lastCaption.translated.slice(0, 50)}"` : "";
      const stt = s.captureOnline && s.stt ? `  stt=${s.stt}` : "";
      const overlays = Math.max(0, Number(s.overlays ?? 0) - 1);
      resolve(`${room.padEnd(8)} ${cap}  overlays=${overlays}  ${s.direction}${stt}${last}`);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      resolve(`${room.padEnd(8)} erro: ${err.message}`);
    });
  });
}

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
