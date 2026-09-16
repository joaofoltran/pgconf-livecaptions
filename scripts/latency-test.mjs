#!/usr/bin/env node
// Mede a latência ponta a ponta simulando a página de captura: transmite um WAV em
// tempo real pelo WebSocket da sala (modo STT no servidor) e cronometra o que
// chega ao overlay. Requer STT_PROXY=true no servidor.
//
//   node scripts/latency-test.mjs --capture-url "https://host/r/teste?k=TOKEN" \
//        --file test-audio/en.wav --direction en-pt [--runs 5] [--quiet] [--label SP]
//
// Também lê LC_CAPTURE_URL de um arquivo .env.test na raiz do projeto.
// Com --runs N, imprime medianas agregadas: é o que permite comparar dois
// servidores apesar da oscilação de 500–900 ms do primeiro token da OpenAI.

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const args = parseArgs(process.argv.slice(2));
loadEnvFile(path.resolve(process.cwd(), ".env.test"));

const captureUrl = args["capture-url"] ?? process.env.LC_CAPTURE_URL;
const file = args.file ?? "test-audio/en.wav";
const direction = args.direction ?? (path.basename(file).startsWith("pt") ? "pt-en" : "en-pt");
const runs = Number(args.runs ?? 1);
const quiet = Boolean(args.quiet) || runs > 1;
const label = args.label ?? "";

if (!captureUrl) {
  fail("Passe --capture-url https://host/r/SALA?k=TOKEN (ou LC_CAPTURE_URL no .env.test)");
}

const target = new URL(captureUrl);
const room = target.pathname.split("/").filter(Boolean)[1];
const token = target.searchParams.get("k") ?? "";
const httpBase = `${target.protocol}//${target.host}`;
const wsBase = `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}`;
if (!room || !token) fail("URL de captura sem sala ou token");

const pcm = readWav16k(file);
const audioMs = Math.round((pcm.length / 2 / 16000) * 1000);
const CHUNK_MS = 50;
const CHUNK_BYTES = (16000 * 2 * CHUNK_MS) / 1000;
const TAIL_SILENCE_MS = 3000;

const session = await fetch(`${httpBase}/api/session/${room}?k=${encodeURIComponent(token)}`).then(
  (r) => (r.ok ? r.json() : Promise.reject(new Error(`session ${r.status}`)))
);
if (!session.sttProxy) {
  fail("O servidor está com STT_PROXY=false; este teste exige STT no servidor.");
}

console.log(
  `${label ? `[${label}] ` : ""}${target.host} · sala ${room} · ${direction} · ${path.basename(file)} (${audioMs} ms de fala) · ${runs} rodada(s)\n`
);

const results = [];
for (let i = 0; i < runs; i++) {
  const m = await runOnce();
  results.push(m);
  if (runs > 1) {
    console.log(
      `rodada ${String(i + 1).padStart(2)}: fim→final ${fmt(m.endToFinal)}  transcrição→draft ${fmt(m.transcriptToDraft)}  ` +
        `1º draft ${fmt(m.firstDraft)}  ws-rtt ${fmt(m.wsRtt)}  dg-conn ${fmt(m.dgConnect)}  drafts/finais ${m.drafts}/${m.finals}`
    );
    await sleep(1500);
  } else {
    printSingle(m);
  }
}
if (runs > 1) printAggregate(results);
process.exit(0);

// ---------------------------------------------------------------------------

async function runOnce() {
  const events = [];
  let t0 = 0;
  const mark = (kind, detail = "") => {
    const t = Date.now();
    events.push({ t, kind, detail });
    if (!quiet && t0) console.log(`${String(t - t0).padStart(6)} ms  ${kind.padEnd(11)} ${detail}`);
  };

  const overlay = await openWs(`${wsBase}/ws?room=${room}&k=${encodeURIComponent(token)}&role=overlay`);
  overlay.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "ping") overlay.send(JSON.stringify({ type: "pong" }));
    // Antes do áudio começar, o servidor só reenvia a última legenda antiga da sala.
    if (msg.type === "caption" && t0) mark(msg.final ? "FINAL" : "draft", `"${msg.translated}"`);
  });

  const capture = await openWs(`${wsBase}/ws?room=${room}&k=${encodeURIComponent(token)}&role=capture`);
  let dgOnline = null;
  let pingSentAt = 0;
  let wsRtt = null;
  capture.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "ping") capture.send(JSON.stringify({ type: "pong" }));
    if (msg.type === "pong") wsRtt = Date.now() - pingSentAt;
    if (msg.type === "dg") {
      mark("deepgram", msg.status);
      if (msg.status === "online" && dgOnline) dgOnline();
    }
    if (msg.type === "transcript") mark("transcript", `"${msg.text}"`);
  });

  pingSentAt = Date.now();
  capture.send(JSON.stringify({ type: "ping" }));

  const dgStart = Date.now();
  const dgReady = new Promise((resolve, reject) => {
    dgOnline = resolve;
    setTimeout(() => reject(new Error("Deepgram não ficou online em 10 s")), 10000);
  });
  capture.send(JSON.stringify({ type: "start", direction, stt: "server" }));
  await dgReady;
  const dgConnect = Date.now() - dgStart;

  // Transmite no ritmo real, sem drift: envia tudo que já "deveria" ter sido falado.
  t0 = Date.now();
  mark("audio", "início");
  let offset = 0;
  const total = pcm.length;
  const silence = Buffer.alloc(CHUNK_BYTES);
  const tailBytes = (TAIL_SILENCE_MS / CHUNK_MS) * CHUNK_BYTES;
  let silenceSent = 0;
  let speechEnd = 0;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const due = Math.floor((Date.now() - t0) / CHUNK_MS) * CHUNK_BYTES;
      while (offset < Math.min(due, total)) {
        capture.send(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, total)));
        offset += CHUNK_BYTES;
      }
      if (offset >= total) {
        if (!speechEnd) {
          speechEnd = Date.now();
          mark("audio", "fim da fala");
        }
        while (silenceSent < Math.min(due - total, tailBytes)) {
          capture.send(silence);
          silenceSent += CHUNK_BYTES;
        }
        if (silenceSent >= tailBytes) {
          clearInterval(timer);
          resolve();
        }
      }
    }, 10);
  });

  // Espera as últimas legendas: para quando ficar 4 s sem novidade (ou 12 s no total).
  await new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const last = events[events.length - 1]?.t ?? start;
      if (Date.now() - last > 4000 || Date.now() - start > 12000) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });

  capture.close();
  overlay.close();
  return metrics(events, t0, speechEnd, wsRtt, dgConnect);
}

function metrics(events, t0, speechEnd, wsRtt, dgConnect) {
  const transcripts = events.filter((e) => e.kind === "transcript");
  const drafts = events.filter((e) => e.kind === "draft");
  const finals = events.filter((e) => e.kind === "FINAL");

  // Tempo entre a última transcrição recebida e o draft seguinte: aproxima a ida e
  // volta ao modelo (mais os gates de ritmo). É a parte que muda com o provedor/local.
  const t2d = [];
  for (const d of drafts) {
    const prev = [...transcripts].reverse().find((t) => t.t <= d.t);
    if (prev) t2d.push(d.t - prev.t);
  }

  return {
    wsRtt,
    dgConnect,
    firstTranscript: transcripts[0] ? transcripts[0].t - t0 : null,
    firstDraft: drafts[0] ? drafts[0].t - t0 : null,
    drafts: drafts.length,
    finals: finals.length,
    draftGap: median(drafts.slice(1).map((e, i) => e.t - drafts[i].t)),
    transcriptToDraft: median(t2d),
    endToFinal: finals.length ? finals[finals.length - 1].t - speechEnd : null,
    finalsDetail: finals.map((f) => ({ lag: f.t - speechEnd, text: f.detail })),
  };
}

function printSingle(m) {
  console.log("\n================ RESUMO ================");
  console.log(`WebSocket RTT até o servidor:       ${fmt(m.wsRtt)}`);
  console.log(`Deepgram conectou em:               ${fmt(m.dgConnect)}`);
  console.log(`Primeira transcrição (Deepgram):    ${fmt(m.firstTranscript)} após início da fala`);
  console.log(`Primeiro draft no overlay:          ${fmt(m.firstDraft)} após início da fala`);
  console.log(`Drafts / finais recebidos:          ${m.drafts} / ${m.finals}`);
  console.log(`Intervalo mediano entre drafts:     ${fmt(m.draftGap)}`);
  console.log(`Transcrição → draft (mediana):      ${fmt(m.transcriptToDraft)}`);
  for (const f of m.finalsDetail) {
    const when = f.lag >= 0 ? `${f.lag} ms após o fim da fala` : `${-f.lag} ms antes do fim da fala`;
    console.log(`FINAL: ${when}  → ${f.text}`);
  }
  console.log(
    m.endToFinal !== null
      ? `\n>>> Fim da fala → última legenda final no telão: ${m.endToFinal} ms`
      : "\n>>> Nenhuma legenda final chegou ao overlay."
  );
  console.log("========================================\n");
}

function printAggregate(rs) {
  const med = (k) => median(rs.map((r) => r[k]).filter((v) => v !== null && v !== undefined));
  console.log(`\n====== MEDIANAS de ${rs.length} rodadas${label ? ` [${label}]` : ""} ======`);
  console.log(`Fim da fala → final no telão:       ${fmt(med("endToFinal"))}`);
  console.log(`Transcrição → draft:                ${fmt(med("transcriptToDraft"))}   (ida e volta ao modelo)`);
  console.log(`Primeiro draft após início da fala: ${fmt(med("firstDraft"))}`);
  console.log(`Intervalo entre drafts:             ${fmt(med("draftGap"))}`);
  console.log(`WebSocket RTT:                      ${fmt(med("wsRtt"))}`);
  console.log(`Conexão Deepgram:                   ${fmt(med("dgConnect"))}`);
  console.log("==========================================\n");
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function fmt(v) {
  return v === null || v === undefined ? "—" : `${v} ms`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`timeout abrindo ${url}`)), 8000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readWav16k(p) {
  const buf = fs.readFileSync(p);
  if (buf.toString("ascii", 0, 4) !== "RIFF") fail(`${p} não é WAV`);
  let pos = 12;
  let fmtChunk = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmtChunk = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmtChunk || !data) fail(`${p}: WAV sem fmt/data`);
  if (fmtChunk.sampleRate !== 16000 || fmtChunk.channels !== 1 || fmtChunk.bits !== 16) {
    fail(`${p}: precisa ser 16 kHz, mono, 16-bit (rode scripts/make-test-audio.sh)`);
  }
  return data;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
