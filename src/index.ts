import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import { Agent, setGlobalDispatcher } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import {
  LoginRateLimiter,
  loginAdmin,
  logoutAdmin,
  requireAdmin,
  requireSameOrigin,
} from "./auth.js";
import { loadConfig, timingSafeEqual, type Direction } from "./config.js";
import { deepgramListenUrl, grantDeepgramToken } from "./deepgram.js";
import {
  broadcastOverlays,
  createRoom,
  emitCaption,
  notifyRoom,
  sendJson,
  statusPayload,
  type CaptionLine,
  type Room,
} from "./rooms.js";
import { isRateLimited, translateCaption } from "./translate.js";

// Um provedor que trava sem dar erro congela o telão: os drafts em voo ocupam a
// fila e o final espera indefinidamente. Timeouts curtos devolvem o controle.
const DRAFT_TIMEOUT_MS = 3000;
const FINAL_TIMEOUT_MS = 3500;
const FALLBACK_TIMEOUT_MS = 6000;
const SLOW_WARN_MS = 1500;

// Disjuntor: a Cerebras degrada em rajadas (dezenas de timeouts em segundos).
// Depois de alguns estouros seguidos, drafts e finais vão ao fallback por um tempo
// e só então voltamos a tentar o principal.
const BREAKER_FAILURES = 4;
const BREAKER_WINDOW_MS = 15000;
const BREAKER_OPEN_MS = 45000;
const breaker = { failures: [] as number[], openUntil: 0 };

function primaryDegraded(): boolean {
  return Boolean(config.fallback) && Date.now() < breaker.openUntil;
}

function notePrimaryFailure(why: string): void {
  if (!config.fallback) return;
  const now = Date.now();
  breaker.failures = breaker.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
  breaker.failures.push(now);
  if (breaker.failures.length >= BREAKER_FAILURES && now >= breaker.openUntil) {
    breaker.openUntil = now + BREAKER_OPEN_MS;
    breaker.failures = [];
    console.warn(
      `provedor principal degradado (${why}); drafts e finais no fallback ${config.fallback.model} por ${BREAKER_OPEN_MS / 1000} s`
    );
  }
}

// Mantém as conexões TLS com OpenAI/Deepgram vivas entre frases: o keep-alive
// padrão (~4s) fecha na primeira pausa do palestrante e o draft seguinte paga
// handshake de novo.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000 }));

const config = loadConfig();
const rooms = new Map<string, Room>();
for (const id of config.rooms) {
  rooms.set(id, createRoom(id, config.tokens[id]));
}

function getRoom(id: string | undefined): Room | undefined {
  if (!id) return undefined;
  return rooms.get(id);
}

function validToken(room: Room, token: string | undefined): boolean {
  if (!token) return false;
  return timingSafeEqual(room.token, token);
}

const app = express();
app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
}
app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  if (
    req.path === "/admin" ||
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/r/") ||
    req.path.startsWith("/api/")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false }));
app.use("/static", express.static(path.resolve(process.cwd(), "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: config.rooms.length });
});

app.get("/r/:room", (req, res) => {
  const room = getRoom(req.params.room);
  if (!room || !validToken(room, String(req.query.k ?? ""))) {
    res.status(404).send("Sala não encontrada");
    return;
  }
  res.sendFile(path.resolve(process.cwd(), "public/capture.html"));
});

app.get("/r/:room/overlay", (req, res) => {
  const room = getRoom(req.params.room);
  if (!room || !validToken(room, String(req.query.k ?? ""))) {
    res.status(404).send("Overlay não encontrado");
    return;
  }
  res.sendFile(path.resolve(process.cwd(), "public/overlay.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), "public/admin.html"));
});

const adminLoginLimiter = new LoginRateLimiter();
const clientKey = (req: express.Request): string =>
  req.ip || req.socket.remoteAddress || "unknown";
const useSecureCookie = (req: express.Request): boolean =>
  req.secure || process.env.NODE_ENV === "production";

app.post("/admin/login", requireSameOrigin, adminLoginLimiter.middleware(), (req, res) => {
  const password = String(req.body?.password ?? "");
  if (!config.adminPassword || !timingSafeEqual(password, config.adminPassword)) {
    res.status(401).json({ error: "senha inválida" });
    return;
  }
  adminLoginLimiter.reset(clientKey(req));
  loginAdmin(res, config, useSecureCookie(req));
  res.json({ ok: true });
});

app.post("/admin/logout", requireSameOrigin, (req, res) => {
  logoutAdmin(res, useSecureCookie(req));
  res.json({ ok: true });
});

app.get("/api/session/:room", (req, res) => {
  const room = getRoom(req.params.room);
  if (!room || !validToken(room, String(req.query.k ?? ""))) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    room: room.id,
    overlayPath: `/r/${room.id}/overlay?k=${encodeURIComponent(room.token)}`,
    keyterms: config.keyterms,
    sttProxy: config.sttProxy && Boolean(config.deepgramApiKey),
  });
});

app.post("/api/deepgram-token/:room", async (req, res) => {
  const room = getRoom(req.params.room);
  if (!room || !validToken(room, String(req.query.k ?? ""))) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const direction = parseDirection(req.body?.direction);
  if (!config.deepgramApiKey) {
    res.status(500).json({ error: "DEEPGRAM_API_KEY não está definida no .env" });
    return;
  }
  try {
    const accessToken = await grantDeepgramToken(config.deepgramApiKey);
    res.json({
      accessToken,
      listenUrl: deepgramListenUrl(
        direction,
        config.keyterms,
        config.dgEndpointing,
        config.dgPtLanguage
      ),
      direction,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err instanceof Error ? err.message : "deepgram token failed" });
  }
});

const adminApi = express.Router();
adminApi.use(requireAdmin(config));

adminApi.get("/me", (_req, res) => {
  res.json({ ok: true });
});

adminApi.get("/status", (_req, res) => {
  res.json({
    rooms: [...rooms.values()].map((room) => ({
      id: room.id,
      captureOnline: room.captureOnline,
      overlays: room.overlays.size,
      direction: room.direction,
      lastCaption: room.lastCaption,
      transcriptLines: room.transcript.length,
      captureUrl: `/r/${room.id}?k=${encodeURIComponent(room.token)}`,
      overlayUrl: `/r/${room.id}/overlay?k=${encodeURIComponent(room.token)}`,
    })),
  });
});

adminApi.get("/transcript/:room", (req, res) => {
  const room = getRoom(req.params.room);
  if (!room) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const format = String(req.query.format ?? "json");
  if (format === "txt") {
    const body = room.transcript
      .filter((l) => l.final)
      .map((l) => `[${new Date(l.ts).toISOString()}] ${l.original}\n→ ${l.translated}`)
      .join("\n\n");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${room.id}.txt"`);
    res.send(body);
    return;
  }
  res.json({ room: room.id, transcript: room.transcript });
});

adminApi.post("/reset/:room", requireSameOrigin, (req, res) => {
  const room = getRoom(String(req.params.room));
  if (!room) {
    res.status(404).json({ error: "not found" });
    return;
  }
  room.transcript = [];
  room.lastCaption = null;
  room.pending = "";
  room.lastSource = null;
  room.lastTranslation = null;
  room.draftSource = "";
  room.draftCandidate = "";
  room.lastDraft = null;
  room.lockedPrefix = "";
  abortDrafts(room);
  if (room.draftTimer) {
    clearTimeout(room.draftTimer);
    room.draftTimer = null;
  }
  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }
  broadcastOverlays(room, { type: "clear" });
  broadcastOverlays(room, statusPayload(room));
  res.json({ ok: true });
});

app.use("/admin/api", adminApi);

app.use((_req, res) => {
  res.status(404).send("Not found");
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", "http://localhost");
  const room = getRoom(url.searchParams.get("room") ?? undefined);
  const token = url.searchParams.get("k") ?? "";
  const role = url.searchParams.get("role") === "overlay" ? "overlay" : "capture";

  if (!room || !validToken(room, token)) {
    ws.close(4401, "unauthorized");
    return;
  }

  if (role === "overlay") {
    room.overlays.add(ws);
    sendJson(ws, statusPayload(room));
    if (room.capture) sendJson(room.capture, statusPayload(room));
    if (room.lastCaption) {
      sendJson(ws, { type: "caption", ...room.lastCaption });
    }
    ws.on("close", () => {
      room.overlays.delete(ws);
      if (room.capture) sendJson(room.capture, statusPayload(room));
    });
  } else {
    if (room.capture && room.capture !== ws) {
      try {
        room.capture.close(4409, "replaced");
      } catch {
        /* ignore */
      }
    }
    room.capture = ws;
    room.captureOnline = true;
    notifyRoom(room, statusPayload(room));

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        // PCM 16 kHz da página de captura: só repassa para o Deepgram.
        if (room.dg && room.dg.readyState === WebSocket.OPEN) {
          room.dg.send(raw as Buffer);
        } else if (room.sttActive && !room.dg && !room.dgReconnectTimer) {
          // O Deepgram fechou por falta de áudio e voltou a chegar áudio: religa agora.
          openDeepgram(room);
        }
        return;
      }
      void handleCaptureMessage(room, ws, raw.toString());
    });
    ws.on("close", (code) => {
      if (room.capture === ws) {
        console.warn(`captura caiu ${room.id} (ws ${code})`);
        room.capture = null;
        room.captureOnline = false;
        room.sttActive = false;
        closeDeepgram(room);
        broadcastOverlays(room, statusPayload(room));
      }
    });
  }

  ws.on("error", (err) => {
    console.error("ws error", room.id, err);
  });
});

function parseDirection(value: unknown): Direction {
  return value === "pt-en" ? "pt-en" : "en-pt";
}

// Fecha a frase à força quando o Deepgram não detecta pausa. Com drafts o telão já
// está em movimento, então pode esperar mais e entregar frases mais inteiras.
const MAX_PENDING_CHARS = 200;
const MAX_PENDING_MS = config.liveDrafts ? 5000 : 2500;
const MAX_DRAFTS_IN_FLIGHT = 4;
const MIN_DRAFT_WORDS = 3;
const GLOBAL_DRAFT_SPACING_MS = Math.round(1000 / Math.max(1, config.draftsPerSecond));

// Espaçamento compartilhado pelas salas para não estourar o RPM da conta.
let lastGlobalDraftTs = 0;

async function handleCaptureMessage(room: Room, ws: WebSocket, raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (msg.type === "ping") {
    sendJson(ws, { type: "pong" });
    return;
  }

  if (msg.type === "start") {
    const direction = parseDirection(msg.direction);
    const directionChanged = direction !== room.direction;
    room.direction = direction;
    notifyRoom(room, statusPayload(room));
    sendJson(ws, { type: "started", direction: room.direction });
    // Só abre o Deepgram se a página pediu STT no servidor: páginas antigas
    // (que falam direto com o Deepgram) seguem funcionando após um deploy.
    if (config.sttProxy && config.deepgramApiKey && msg.stt === "server") {
      room.sttActive = true;
      // Idempotente: a página reenvia "start" a cada reconexão do WebSocket.
      if (!room.dg || directionChanged) openDeepgram(room);
    }
    return;
  }

  if (msg.type === "flush") {
    void flushPending(room, ws);
    return;
  }

  if (msg.type === "interim") {
    room.direction = parseDirection(msg.direction ?? room.direction);
    maybeDraft(room, fixTranscript(String(msg.text ?? "")));
    return;
  }

  if (msg.type !== "caption") return;
  const text = fixTranscript(String(msg.text ?? "").trim());
  if (!text) return;
  if (!msg.final) return;
  room.direction = parseDirection(msg.direction ?? room.direction);
  handleFinalFragment(room, ws, text, Boolean(msg.speechFinal));
}

// O STT escreve "patrone", "t c d", "pg poo" para a pronúncia brasileira de nomes em
// inglês; traduzir isso fielmente dá "patron", "TCD"... Corrigimos antes.
function fixTranscript(text: string): string {
  let out = text;
  for (const alias of config.aliases) out = out.replace(alias.pattern, alias.canonical);
  return out;
}

function handleFinalFragment(
  room: Room,
  ws: WebSocket | null,
  text: string,
  speechFinal: boolean
): void {
  room.pending = room.pending ? `${room.pending} ${text}` : text;

  if (speechFinal || room.pending.length >= MAX_PENDING_CHARS) {
    // Estouro por tamanho corta a frase no meio: o final não pode inventar um fim.
    void flushPending(room, ws, speechFinal);
    return;
  }

  if (!room.flushTimer) {
    room.flushTimer = setTimeout(() => {
      void flushPending(room, ws, false);
    }, MAX_PENDING_MS);
  }

  // O fragmento fechado também vale como candidato: mantém o telão andando
  // mesmo se o próximo interim demorar.
  maybeDraft(room, "");
}

// ---- STT no servidor -------------------------------------------------------
// O navegador manda PCM para cá e nós falamos com o Deepgram. Com o VPS perto
// do Deepgram e da OpenAI, a transcrição não precisa voltar ao notebook antes
// de virar tradução: o áudio cruza o oceano uma vez, a legenda outra.

const DG_RECONNECT_MS = 1000;
const DG_SILENCE_TIMEOUT_MS = 20000;

function openDeepgram(room: Room): void {
  closeDeepgram(room);

  const url = deepgramListenUrl(
    room.direction,
    config.keyterms,
    config.dgEndpointing,
    config.dgPtLanguage
  );
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${config.deepgramApiKey}` },
  });
  room.dg = dg;
  room.dgLastMsg = Date.now();
  let lastError = "";

  dg.on("open", () => {
    room.dgLastMsg = Date.now();
    if (room.capture) sendJson(room.capture, { type: "dg", status: "online" });
  });

  dg.on("message", (raw) => {
    room.dgLastMsg = Date.now();
    handleDeepgramMessage(room, raw.toString());
  });

  dg.on("error", (err) => {
    lastError = err.message;
    console.error("deepgram ws", room.id, err.message);
  });

  dg.on("close", (code, reason) => {
    if (room.dg !== dg) return;
    room.dg = null;
    const why = reason.length ? reason.toString() : lastError;
    const detail = `offline (${code}${why ? ` ${why}` : ""})`;
    if (room.capture) sendJson(room.capture, { type: "dg", status: detail });
    // 1011 = o Deepgram não recebeu áudio (aba dormindo, mic mudo, notebook fechado).
    // Religar em loop a noite inteira não ajuda ninguém: esperamos o próximo áudio.
    const noAudio = code === 1011;
    if (room.sttActive) {
      console.warn(`deepgram caiu ${room.id}: ${detail}; ${noAudio ? "aguardando áudio" : "reconectando"}`);
    }
    if (room.sttActive && !noAudio && !room.dgReconnectTimer) {
      room.dgReconnectTimer = setTimeout(() => {
        room.dgReconnectTimer = null;
        if (room.sttActive && !room.dg) openDeepgram(room);
      }, DG_RECONNECT_MS);
    }
  });
}

function closeDeepgram(room: Room): void {
  if (room.dgReconnectTimer) {
    clearTimeout(room.dgReconnectTimer);
    room.dgReconnectTimer = null;
  }
  const dg = room.dg;
  if (!dg) return;
  room.dg = null;
  try {
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(JSON.stringify({ type: "CloseStream" }));
    }
    dg.close();
  } catch {
    /* já fechado */
  }
}

function handleDeepgramMessage(room: Room, raw: string): void {
  let data: {
    type?: string;
    is_final?: boolean;
    speech_final?: boolean;
    channel?: { alternatives?: Array<{ transcript?: string }> };
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (data.type === "UtteranceEnd") {
    void flushPending(room, room.capture);
    return;
  }
  if (data.type !== "Results") return;

  const heard = data.channel?.alternatives?.[0]?.transcript?.trim();
  if (!heard) return;
  const text = fixTranscript(heard);
  if (room.capture) sendJson(room.capture, { type: "transcript", text });

  if (!data.is_final) {
    maybeDraft(room, text);
    return;
  }
  handleFinalFragment(room, room.capture, text, Boolean(data.speech_final));
}

// Deepgram mudo com áudio entrando: derruba e reconecta em vez de deixar o telão parado.
setInterval(() => {
  for (const room of rooms.values()) {
    const dg = room.dg;
    if (!dg || dg.readyState !== WebSocket.OPEN) continue;
    if (Date.now() - room.dgLastMsg > DG_SILENCE_TIMEOUT_MS) {
      console.warn("deepgram silent, reconnecting", room.id);
      if (room.capture) sendJson(room.capture, { type: "dg", status: "sem resposta, reconectando…" });
      dg.terminate();
    }
  }
}, 5000);

// Enquanto a frase é falada, retraduzimos ela inteira a cada intervalo para o telão
// não ficar parado. Cada versão substitui a anterior e se corrige com mais contexto.
function maybeDraft(room: Room, interim: string): void {
  if (!config.liveDrafts) return;

  const candidate = `${room.pending} ${interim}`.trim();
  if (candidate.split(/\s+/).length < MIN_DRAFT_WORDS) return;

  room.draftCandidate = candidate;
  fireDraft(room);
}

// Se o gate bloqueia agora, agenda o disparo para quando liberar, em vez de torcer
// para chegar outro interim: as últimas palavras antes da pausa também viram draft.
function scheduleDraft(room: Room, delayMs: number): void {
  if (room.draftTimer) return;
  room.draftTimer = setTimeout(() => {
    room.draftTimer = null;
    fireDraft(room);
  }, Math.max(25, delayMs));
}

function fireDraft(room: Room): void {
  const candidate = room.draftCandidate;
  if (!candidate || candidate === room.draftSource) return;

  const now = Date.now();
  const wait = Math.max(
    room.draftTs + config.draftIntervalMs - now,
    lastGlobalDraftTs + GLOBAL_DRAFT_SPACING_MS - now
  );
  if (wait > 0) {
    scheduleDraft(room, wait);
    return;
  }
  // Cancelar o draft anterior deixaria o telão vazio: cada um leva ~1s e os interims
  // chegam mais rápido que isso. Eles correm em paralelo e o seq descarta os atrasados.
  if (room.draftsInFlight.size >= MAX_DRAFTS_IN_FLIGHT) {
    scheduleDraft(room, config.draftIntervalMs);
    return;
  }

  lastGlobalDraftTs = now;
  room.draftTs = now;
  room.draftSource = candidate;

  const abort = new AbortController();
  let timedOut = false;
  const degraded = primaryDegraded();
  const timeout = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, degraded ? FALLBACK_TIMEOUT_MS : DRAFT_TIMEOUT_MS);

  const seq = ++room.seq;
  const direction = room.direction;
  const context = translationContext(room);
  const startedAt = now;
  const prefix = room.lockedPrefix;

  const promise = translateCaption(config, candidate, direction, {
    context,
    unfinished: true,
    signal: abort.signal,
    prefix,
    provider: degraded ? config.fallback ?? undefined : undefined,
  }).then(capitalizeFirst);
  // O flush consulta este mapa: se o final tem o mesmo texto de um draft em voo,
  // espera por ele em vez de pagar outra ida à OpenAI.
  room.draftsInFlight.set(abort, { source: candidate, promise });

  promise
    .then((translated) => {
      const took = Date.now() - startedAt;
      if (took > SLOW_WARN_MS) console.warn(`draft lento ${room.id}: ${took} ms`);
      if (seq <= room.lastDraftSeq) return;

      const previous = room.lastDraft?.translated ?? null;
      // A frase já mudou de dono (flush) desde que este draft saiu: não render.
      if (prefix !== room.lockedPrefix && !startsWithWords(translated, room.lockedPrefix)) return;
      if (prefix && !startsWithWords(translated, prefix)) {
        console.warn(`draft ignorou o prefixo travado ${room.id}`);
      }
      // Um draft que encolhe faz palavras sumirem do telão; o próximo vem em instantes.
      if (previous && words(translated).length < words(previous).length - 1) return;

      room.lastDraftSeq = seq;
      room.lastDraft = { source: candidate, translated };
      advanceLock(room, previous, translated);
      emitCaption(room, seq, {
        type: "caption",
        seq,
        original: candidate,
        translated,
        direction,
        final: false,
      });
    })
    .catch((err) => {
      if (abort.signal.aborted) {
        if (timedOut) {
          console.warn(`draft timeout ${room.id} (descartado)`);
          if (!degraded) notePrimaryFailure("draft timeout");
        }
        return;
      }
      // Draft perdido não pausa nada: o próximo vem em instantes.
      if (isRateLimited(err)) {
        console.warn("draft rate limited (descartado)");
        return;
      }
      console.error("draft failed", err);
      if (!degraded) notePrimaryFailure("draft error");
    })
    .finally(() => {
      clearTimeout(timeout);
      room.draftsInFlight.delete(abort);
    });
}

function abortDrafts(room: Room): void {
  for (const abort of room.draftsInFlight.keys()) {
    abort.abort();
  }
  room.draftsInFlight.clear();
}

// O draft é traduzido como frase aberta (sem ponto final); ao promovê-lo a final,
// devolve a pontuação que o original tinha.
function closePunctuation(translated: string, original: string): string {
  const end = original.match(/[.!?…]+$/)?.[0];
  if (!end || /[.!?…]$/.test(translated)) return translated;
  return `${translated}${end}`;
}

function translationContext(room: Room) {
  return room.lastSource && room.lastTranslation
    ? { source: room.lastSource, translated: room.lastTranslation }
    : undefined;
}

// O final do Deepgram difere do último interim só em caixa/pontuação na maioria
// das vezes; comparar sem isso permite reusar a tradução do draft.
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);
const normWords = (text: string): string[] => words(normalizeText(text));

function commonWordPrefix(a: string, b: string): number {
  const wa = normWords(a);
  const wb = normWords(b);
  let n = 0;
  while (n < wa.length && n < wb.length && wa[n] === wb[n]) n++;
  return n;
}

function startsWithWords(text: string, prefix: string): boolean {
  const wp = normWords(prefix);
  return wp.length === 0 || commonWordPrefix(text, prefix) >= wp.length;
}

function capitalizeFirst(text: string): string {
  const i = text.search(/\p{L}/u);
  return i < 0 ? text : text.slice(0, i) + text[i].toUpperCase() + text.slice(i + 1);
}

// As últimas palavras de um draft ainda podem mudar quando a frase avança (ordem
// adjetivo/substantivo, negação); as anteriores, se repetidas em dois drafts
// seguidos, já podem ser prometidas ao público.
const TAIL_FREE_WORDS = 3;

function advanceLock(room: Room, previous: string | null, shown: string): void {
  if (!previous) return;
  const n = Math.min(commonWordPrefix(previous, shown), words(shown).length - TAIL_FREE_WORDS);
  if (n <= normWords(room.lockedPrefix).length) return;
  const candidate = words(shown).slice(0, n).join(" ");
  if (startsWithWords(candidate, room.lockedPrefix)) room.lockedPrefix = candidate;
}

function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  return run(abort.signal).finally(() => clearTimeout(timer));
}

// O final não pode ficar preso num provedor travado nem cair no texto original por
// um 429 passageiro: tenta o principal com timeout, depois o fallback (outro
// provedor) e, sem fallback, insiste no principal antes de desistir.
async function translateFinal(
  room: Room,
  original: string,
  direction: Direction,
  context: ReturnType<typeof translationContext>,
  onPartial: ((partial: string) => void) | undefined,
  prefix: string,
  unfinished = false
): Promise<string> {
  const startedAt = Date.now();
  // No modo híbrido o final vai a outro provedor (mais lento, mais caprichado);
  // o timeout é mais folgado porque ele não segura a linha viva, só a consolidação.
  const degraded = primaryDegraded();
  const provider = degraded ? config.fallback ?? undefined : config.finalProvider ?? undefined;
  const timeoutMs = provider ? FALLBACK_TIMEOUT_MS : FINAL_TIMEOUT_MS;
  const base = { context, onPartial, prefix, unfinished };
  try {
    const out = await withTimeout(timeoutMs, (signal) =>
      translateCaption(config, original, direction, { ...base, signal, provider })
    );
    const took = Date.now() - startedAt;
    if (took > SLOW_WARN_MS) console.warn(`final lento ${room.id}: ${took} ms`);
    return out;
  } catch (err) {
    const why = err instanceof Error && err.name === "AbortError" ? `timeout ${timeoutMs} ms` : String(err);
    if (!degraded) notePrimaryFailure(`final ${why}`);
    if (config.fallback) {
      console.warn(`final no principal falhou (${why}); usando fallback ${config.fallback.model}`, room.id);
      return withTimeout(FALLBACK_TIMEOUT_MS, (signal) =>
        translateCaption(config, original, direction, {
          ...base,
          signal,
          provider: config.fallback ?? undefined,
        })
      );
    }
    if (!isRateLimited(err)) throw err;
  }

  let lastErr: unknown;
  for (const delay of [350, 900]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await withTimeout(timeoutMs, (signal) =>
        translateCaption(config, original, direction, { ...base, signal, provider })
      );
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
    }
  }
  throw lastErr;
}

// A frase só é traduzida inteira: em EN<->PT a ordem das palavras muda, e traduzir
// fragmento por fragmento deixa o texto travado.
async function flushPending(room: Room, ws: WebSocket | null, complete = true): Promise<void> {
  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }

  const original = room.pending.trim();
  room.pending = "";
  room.draftSource = "";
  room.draftCandidate = "";
  // O final continua o que o público já leu; a próxima frase começa sem travas.
  const prefix = room.lockedPrefix;
  room.lockedPrefix = "";
  if (room.draftTimer) {
    clearTimeout(room.draftTimer);
    room.draftTimer = null;
  }
  if (!original) return;

  const direction = room.direction;
  const seq = ++room.seq;
  const context = translationContext(room);

  // Com drafts ativos, o streaming por token só somaria tremido: cada versão
  // exibida já é uma frase completa.
  const onPartial = config.liveDrafts
    ? undefined
    : (partial: string) => {
        emitCaption(room, seq, {
          type: "caption",
          seq,
          original,
          translated: partial,
          direction,
          final: false,
        });
      };

  // Fast-path: se o último draft já traduziu exatamente esta frase, não há por que
  // esperar outra ida à OpenAI — o final sai na hora e sem reescrita no telão.
  // No híbrido o final existe justamente para ser refeito pelo provedor melhor.
  const wanted = normalizeText(original);
  let reusable =
    !config.finalProvider && room.lastDraft && normalizeText(room.lastDraft.source) === wanted
      ? room.lastDraft.translated
      : null;
  room.lastDraft = null;

  // O último interim do Deepgram costuma ser idêntico ao final, e o draft dele
  // ainda está em voo quando o flush chega: esperar por ele é mais rápido que
  // começar outra tradução.
  if (!reusable && !config.finalProvider) {
    for (const draft of room.draftsInFlight.values()) {
      if (normalizeText(draft.source) === wanted) {
        try {
          // Se esse draft estiver travado no provedor, não vale esperar por ele.
          reusable = await Promise.race([
            draft.promise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
          ]);
        } catch {
          reusable = null;
        }
        break;
      }
    }
  }

  let translated = original;
  if (reusable) {
    translated = closePunctuation(reusable, original);
    room.lastSource = original;
    room.lastTranslation = translated;
  } else {
    try {
      translated = capitalizeFirst(
        await translateFinal(room, original, direction, context, onPartial, prefix, !complete)
      );
      room.lastSource = original;
      room.lastTranslation = translated;
    } catch (err) {
      // Só aqui o telão mostra o texto na língua de origem, como último recurso.
      console.error("translate failed", err);
      if (ws) sendJson(ws, { type: "translate_error" });
    }
  }

  const line: CaptionLine = {
    ts: Date.now(),
    original,
    translated,
    direction,
    final: true,
  };
  room.lastCaption = line;
  room.transcript.push(line);
  if (room.transcript.length > 2000) {
    room.transcript.splice(0, room.transcript.length - 2000);
  }
  emitCaption(room, seq, { type: "caption", seq, ...line });
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.capture) sendJson(room.capture, { type: "ping" });
    broadcastOverlays(room, { type: "ping" });
  }
}, 15000);

server.listen(config.port, () => {
  console.log(`live-captions listening on ${config.port}`);
});
