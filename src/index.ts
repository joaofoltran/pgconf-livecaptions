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
import { DRAFT_TIMEOUT_MS, FALLBACK_TIMEOUT_MS, loadConfig, timingSafeEqual, type Direction } from "./config.js";
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
import { CircuitBreaker } from "./breaker.js";
import {
  isRateLimited,
  primaryProvider,
  translateWithHedge,
  type HedgeOptions,
  type Provider,
  type TranslateOptions,
} from "./translate.js";

// A provider that stalls without an error freezes the display: in-flight drafts
// occupy the queue and the final waits indefinitely. Short timeouts restore control.
const FINAL_TIMEOUT_MS = 3500;
const FINAL_RETRY_FIRST_TOKEN_MS = 1500;
const SLOW_WARN_MS = 1500;
// More finished sentences than this waiting to be shown skip the minimum display
// time, so the overlay's top line falls at most a few seconds behind.
const MAX_FINALS_HELD = 2;

// Circuit breaker per preferred provider: Cerebras can degrade in bursts (dozens
// of timeouts in seconds). BREAKER_* failures in a window route its traffic to the
// fallback for a while, then a single probe decides whether to return.
const breakers = new Map<string, CircuitBreaker>();

function breakerFor(provider: Provider): CircuitBreaker {
  const key = `${provider.baseUrl} ${provider.model}`;
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker(config.breakerFailureThreshold, config.breakerWindowMs, config.breakerOpenMs);
    breakers.set(key, breaker);
  }
  return breaker;
}

function hedgedTranslate(
  room: Room,
  kind: "draft" | "final",
  preferred: Provider,
  timeoutMs: number,
  text: string,
  direction: Direction,
  options: TranslateOptions & Pick<HedgeOptions, "onFallbackDone">
): Promise<string> {
  const fallback = config.fallback;
  const breaker = fallback ? breakerFor(preferred) : null;
  const route = breaker?.route() ?? "preferred";
  // A FINAL_* provider is chosen for quality, not speed: give it its whole timeout.
  const quality = preferred === config.finalProvider;
  const cutoffMs = quality ? timeoutMs : config.primaryCutoffMs;
  const promise = translateWithHedge(config, text, direction, {
    ...options,
    provider: preferred,
    fallback,
    fallbackAfterMs: quality ? timeoutMs : config.fallbackStartMs,
    cutoffMs,
    timeoutMs,
    fallbackTimeoutMs: FALLBACK_TIMEOUT_MS,
    skipPreferred: route === "fallback",
    onPreferredFailure: (why, err) => {
      const detail = err instanceof Error ? ` (${err.message.slice(0, 120)})` : "";
      console.warn(
        `${kind} ${room.id}: ${preferred.model} ${why}${detail}${fallback ? `; using ${fallback.model}` : ""}`
      );
      // Drafts run several per second, so their 429s alone would trip a healthy provider.
      if (kind === "draft" && isRateLimited(err)) return;
      if (breaker?.fail()) {
        console.warn(
          `${preferred.model} degraded; ${kind}s on fallback ${fallback?.model} for ${config.breakerOpenMs / 1000} s`
        );
      }
    },
    onPreferredSuccess: () => breaker?.succeed(),
    // Read by `measure-first-token --from-logs` to compute the median and p90.
    onPreferredFirstToken: (ms) =>
      console.log(`first token ${room.id} ${kind} ${quality ? "final" : "primary"} ${preferred.model} ${ms === null ? `>${cutoffMs} ms (cut off)` : `${ms} ms`}`),
  });
  if (route === "probe") {
    void promise.catch(() => {}).finally(() => breaker?.release());
  }
  return promise;
}

// Keep TLS connections to OpenAI/Deepgram alive between sentences: the default
// keep-alive (~4 s) closes on the speaker's first pause, forcing the next draft
// to pay for another handshake.
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
  room.lastFinalAt = 0;
  room.epoch++;
  // Finals from before the reset are dropped, so the new session's need not wait for them.
  room.finalShown = Promise.resolve();
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
  ws.on("error", (err) => {
    console.error("ws error", room?.id, err);
  });

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
      // Like a disconnect: the old capture's held finals stay in the transcript, off the overlay.
      room.epoch++;
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
        // 16 kHz PCM from the capture page: forward it directly to Deepgram.
        if (room.dg && room.dg.readyState === WebSocket.OPEN) {
          room.dg.send(raw as Buffer);
        } else if (room.sttActive && !room.dg && !room.dgReconnectTimer) {
          // Deepgram closed due to missing audio and audio resumed: reconnect now.
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
        room.epoch++;
        closeDeepgram(room);
        broadcastOverlays(room, statusPayload(room));
      }
    });
  }
});

function parseDirection(value: unknown): Direction {
  return value === "pt-en" ? "pt-en" : "en-pt";
}

// Force-close the sentence when Deepgram does not detect a pause. Drafts already
// keep the display moving, so wait longer to produce more complete sentences.
const MAX_PENDING_CHARS = 200;
const MAX_PENDING_MS = config.liveDrafts ? 5000 : 2500;
const MAX_DRAFTS_IN_FLIGHT = 4;
const MIN_DRAFT_WORDS = 3;
const GLOBAL_DRAFT_SPACING_MS = Math.round(1000 / Math.max(1, config.draftsPerSecond));

// Shared spacing across rooms to stay within the account's request-per-minute limit.
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
    // Open Deepgram only when the page requested server-side STT. Older pages
    // that connect directly to Deepgram keep working after a deploy.
    if (config.sttProxy && config.deepgramApiKey && msg.stt === "server") {
      room.sttActive = true;
      // Idempotent: the page resends "start" on every WebSocket reconnect.
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

// STT writes "patrone", "t c d", or "pg poo" for Brazilian pronunciations of
// English names; faithful translation would produce "patron" or "TCD". Fix them first.
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
    // A size overflow splits the sentence mid-phrase; the final must not invent an ending.
    void flushPending(room, ws, speechFinal);
    return;
  }

  if (!room.flushTimer) {
    room.flushTimer = setTimeout(() => {
      void flushPending(room, ws, false);
    }, MAX_PENDING_MS);
  }

    // The closed fragment is also a candidate, keeping the display moving even
    // if the next interim transcript takes a while.
  maybeDraft(room, "");
}

// ---- Server-side STT -------------------------------------------------------
// The browser sends PCM here and the server connects to Deepgram. With the VPS
// close to Deepgram and OpenAI, the transcript need not return to the laptop
// before translation: audio crosses the ocean once and captions cross back once.

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
    // 1011 = Deepgram received no audio (sleeping tab, muted mic, closed laptop).
    // Reconnecting all night does not help; wait for the next audio packet.
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
    /* already closed */
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

// Deepgram is silent while audio arrives: reconnect instead of freezing the display.
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

// While the sentence is being spoken, retranslate it in full on every interval
// so the display keeps moving. Each version replaces and corrects the previous one.
function maybeDraft(room: Room, interim: string): void {
  if (!config.liveDrafts) return;

  const candidate = `${room.pending} ${interim}`.trim();
  if (candidate.split(/\s+/).length < MIN_DRAFT_WORDS) return;

  room.draftCandidate = candidate;
  fireDraft(room);
}

// If the gate blocks now, schedule the request for when it opens instead of
// relying on another interim; words just before a pause must also become a draft.
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
  // Canceling the previous draft would leave the display empty: each takes ~1 s
  // while interims arrive faster. Run them in parallel and discard late sequences.
  // With every slot busy, the newest candidate fires when a draft settles.
  if (room.draftsInFlight.size >= MAX_DRAFTS_IN_FLIGHT) {
    evictStalledDraft(room, now);
    return;
  }

  lastGlobalDraftTs = now;
  room.draftTs = now;
  room.draftSource = candidate;

  const abort = new AbortController();
  const seq = ++room.seq;
  const sentence = room.sentence;
  const direction = room.direction;
  const context = translationContext(room);
  const startedAt = now;
  const prefix = room.lockedPrefix;
  const inFlight = { source: candidate, promise: Promise.resolve(""), gotToken: false, startedAt, awaited: false };

  const render = (translated: string): boolean => {
    if (sentence !== room.sentence || seq <= room.lastDraftSeq) return false;

    const previous = room.lastDraft?.translated ?? null;
    // Flush took ownership of the sentence after this draft started: do not render it.
    if (prefix !== room.lockedPrefix && !startsWithWords(translated, room.lockedPrefix)) return false;
    if (prefix && !startsWithWords(translated, prefix)) {
      console.warn(`draft ignorou o prefixo travado ${room.id}`);
    }
    // A shrinking draft removes words from the display; another arrives momentarily.
    if (previous && words(translated).length < words(previous).length - 1) return false;

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
    return true;
  };
  // The fallback's draft shows while the primary may still start before its cutoff.
  // If it does, its draft replaces the fallback's as if that one never showed.
  let fallbackShown: { text: string; lastDraft: Room["lastDraft"]; lastDraftSeq: number; lockedPrefix: string } | null =
    null;

  const promise = hedgedTranslate(room, "draft", primaryProvider(config), DRAFT_TIMEOUT_MS, candidate, direction, {
    context,
    unfinished: true,
    signal: abort.signal,
    prefix,
    onPartial: () => {
      inFlight.gotToken = true;
    },
    onFallbackDone: (text) => {
      const before = { lastDraft: room.lastDraft, lastDraftSeq: room.lastDraftSeq, lockedPrefix: room.lockedPrefix };
      const translated = capitalizeFirst(text);
      if (render(translated)) fallbackShown = { text: translated, ...before };
    },
  }).then(capitalizeFirst);
  inFlight.promise = promise;
  // Flush checks this map: if the final matches an in-flight draft, wait for it
  // instead of paying for another translation round trip.
  room.draftsInFlight.set(abort, inFlight);

  promise
    .then((translated) => {
      const took = Date.now() - startedAt;
      if (took > SLOW_WARN_MS) console.warn(`draft lento ${room.id}: ${took} ms`);
      if (fallbackShown) {
        if (translated === fallbackShown.text) return;
        if (sentence === room.sentence && room.lastDraftSeq === seq) {
          room.lastDraft = fallbackShown.lastDraft;
          room.lastDraftSeq = fallbackShown.lastDraftSeq;
          room.lockedPrefix = fallbackShown.lockedPrefix;
        }
      }
      render(translated);
    })
    .catch((err) => {
      if (abort.signal.aborted) return;
      if (isRateLimited(err)) {
        console.warn("draft rate limited");
        return;
      }
      if (isAbortError(err)) {
        console.warn(`draft timeout ${room.id}`);
        return;
      }
      console.error("draft failed", err);
    })
    .finally(() => {
      room.draftsInFlight.delete(abort);
      fireDraft(room);
    });
}

// A draft with no token after DRAFT_TIMEOUT_MS is stuck on both providers;
// younger ones may still be waiting for their hedge. Its slot frees only when
// its aborted streams have closed, so one eviction at a time.
function evictStalledDraft(room: Room, now: number): void {
  let oldest: [AbortController, number] | null = null;
  for (const [abort, draft] of room.draftsInFlight) {
    if (abort.signal.aborted) return;
    if (draft.gotToken || now - draft.startedAt < DRAFT_TIMEOUT_MS) continue;
    if (!oldest || draft.startedAt < oldest[1]) oldest = [abort, draft.startedAt];
  }
  oldest?.[0].abort();
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

function abortDrafts(room: Room): void {
  for (const abort of room.draftsInFlight.keys()) {
    abort.abort();
  }
  room.draftsInFlight.clear();
}

// Translate the draft as an open sentence without final punctuation. When
// promoting it to final, restore the punctuation from the original.
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

// Deepgram's final usually differs from the latest interim only in case and
// punctuation; ignoring those differences allows draft translation reuse.
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

// A draft's final words may still change as the sentence grows (adjective/noun
// order, negation). Earlier words repeated in two consecutive drafts can
// already be promised to the audience.
const TAIL_FREE_WORDS = 3;

function advanceLock(room: Room, previous: string | null, shown: string): void {
  if (!previous) return;
  const n = Math.min(commonWordPrefix(previous, shown), words(shown).length - TAIL_FREE_WORDS);
  if (n <= normWords(room.lockedPrefix).length) return;
  const candidate = words(shown).slice(0, n).join(" ");
  if (startsWithWords(candidate, room.lockedPrefix)) room.lockedPrefix = candidate;
}

// The final must not remain stuck on a stalled provider or fall back to source
// text after a transient 429. Hedge the preferred provider against fallback;
// without a fallback, retry the preferred provider after a 429 before giving up.
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
  // In hybrid mode, finals use another, slower but higher-quality provider.
  // Its timeout is looser because it delays only consolidation, not the live line.
  const preferred = config.finalProvider ?? primaryProvider(config);
  const timeoutMs = config.finalProvider ? FALLBACK_TIMEOUT_MS : FINAL_TIMEOUT_MS;
  const base = { context, onPartial, prefix, unfinished };
  const run = () => hedgedTranslate(room, "final", preferred, timeoutMs, original, direction, base);
  try {
    const out = await run();
    const took = Date.now() - startedAt;
    if (took > SLOW_WARN_MS) console.warn(`final lento ${room.id}: ${took} ms`);
    return out;
  } catch (err) {
    if (config.fallback) {
      // One more fallback try rides out a single fallback error, which would
      // otherwise put source text on screen. In a full outage it must not hold
      // the source text back, so it gets FINAL_RETRY_FIRST_TOKEN_MS to start streaming.
      console.warn(`final retry ${room.id}: fallback ${config.fallback.model}`);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FINAL_RETRY_FIRST_TOKEN_MS);
      try {
        return await translateWithHedge(config, original, direction, {
          ...base,
          signal: abort.signal,
          onPartial: (partial) => {
            clearTimeout(timer);
            onPartial?.(partial);
          },
          fallback: config.fallback,
          fallbackAfterMs: 0,
          cutoffMs: 0,
          timeoutMs: FALLBACK_TIMEOUT_MS,
          skipPreferred: true,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    if (!isRateLimited(err)) throw err;
  }

  let lastErr: unknown;
  for (const delay of [350, 900]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;
    }
  }
  throw lastErr;
}

// Translate only complete sentences: EN<->PT word order changes, and translating
// fragment by fragment produces rigid text.
async function flushPending(room: Room, ws: WebSocket | null, complete = true): Promise<void> {
  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }

  const original = room.pending.trim();
  room.pending = "";
  room.draftSource = "";
  room.draftCandidate = "";
  // The final continues what the audience already read; the next sentence starts unlocked.
  const prefix = room.lockedPrefix;
  room.lockedPrefix = "";
  if (room.draftTimer) {
    clearTimeout(room.draftTimer);
    room.draftTimer = null;
  }
  if (!original) return;

  const direction = room.direction;
  const seq = ++room.seq;
  // Taken before any await: a reset or disconnect during translation makes this final stale.
  const epoch = room.epoch;
  const transcript = room.transcript;
  const previousFinal = room.finalShown;
  let finalShown!: () => void;
  room.finalShown = new Promise((resolve) => (finalShown = resolve));
  try {
    // Drafts started before this final belong to the closed sentence: none may
    // render or become lastDraft, or the next sentence's draft hits the shrink guard.
    room.sentence++;
    const context = translationContext(room);

    // Stream the final word by word onto an empty live line. Over a visible draft,
    // the final replaces it in one step: its first partials would erase the draft.
    const onPartial = (partial: string) => {
      if (room.epoch !== epoch) return;
      if (room.renderedSeq !== seq && room.renderedSeq > room.renderedFinalSeq) return;
      emitCaption(room, seq, {
        type: "caption",
        seq,
        original,
        translated: partial,
        direction,
        final: false,
      });
    };

    // Fast path: if the latest draft already translated this exact sentence, avoid
    // another OpenAI round trip; emit the final immediately without rewriting the display.
    // In hybrid mode, the final exists specifically for the better provider to redo it.
    const wanted = normalizeText(original);
    let reusable =
      !config.finalProvider && room.lastDraft && normalizeText(room.lastDraft.source) === wanted
        ? room.lastDraft.translated
        : null;
    room.lastDraft = null;

    // Deepgram's latest interim is usually identical to the final, and its draft
    // is still in flight when flush arrives. Waiting is faster than starting
    // another translation.
    const matching =
      !reusable && !config.finalProvider
        ? [...room.draftsInFlight].find(([, draft]) => normalizeText(draft.source) === wanted)
        : undefined;
    // Retired drafts can no longer render; free their streams for the next sentence.
    // Each draft's own finally releases its slot. A draft an earlier flush awaits
    // is that sentence's final: aborting it would re-translate it behind this one.
    for (const [abort, draft] of room.draftsInFlight) {
      if (abort !== matching?.[0] && !draft.awaited) abort.abort();
    }
    if (matching) {
      const [abort, draft] = matching;
      draft.awaited = true;
      const budget = config.primaryCutoffMs + 1500;
      let timer: NodeJS.Timeout | undefined;
      try {
        // Do not wait for this draft if it is stalled at the provider. One that is
        // already streaming is nearly done, so give it up to twice the budget.
        reusable = await Promise.race([
          draft.promise,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              if (!draft.gotToken) return resolve(null);
              timer = setTimeout(() => resolve(null), budget);
            }, budget);
          }),
        ]);
      } catch {
        reusable = null;
      }
      clearTimeout(timer);
      if (!reusable) abort.abort();
    }

    let translated = original;
    let isTranslated = false;
    if (reusable) {
      translated = closePunctuation(reusable, original);
      isTranslated = true;
    } else {
      try {
        translated = capitalizeFirst(
          await translateFinal(room, original, direction, context, onPartial, prefix, !complete)
        );
        isTranslated = true;
      } catch (err) {
        // Only here does the display show source-language text as a last resort.
        if (isAbortError(err)) console.error(`translate failed ${room.id}: timeout`);
        else console.error("translate failed", err);
        if (ws) sendJson(ws, { type: "translate_error" });
      }
    }

    // Finals go out in sentence order: one that finished early waits for the
    // sentences before it, so a late final is shown instead of being dropped.
    room.finalsWaiting++;
    try {
      await previousFinal;
      // /reset replaced the transcript and cleared the context: this sentence belongs to the old session.
      if (room.transcript !== transcript) return;
      // Set after the wait, so the next sentence's context is the last one spoken, not the last to finish.
      if (isTranslated) {
        room.lastSource = original;
        room.lastTranslation = translated;
      }
      const holdMs = room.lastFinalAt + config.minFinalDisplayMs - Date.now();
      // A final that won't be shown must not hold up the ones after it.
      if (room.epoch === epoch && holdMs > 0 && room.finalsWaiting <= MAX_FINALS_HELD) {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      }
    } finally {
      room.finalsWaiting--;
    }
    // /reset replaces the transcript, so a sentence spoken before it is dropped. A capture
    // disconnect (maybe a blip) keeps the sentence in the transcript but off the overlay.
    if (room.transcript !== transcript) return;
    const show = room.epoch === epoch;
    const line: CaptionLine = {
      ts: Date.now(),
      original,
      translated,
      direction,
      final: true,
    };
    room.transcript.push(line);
    if (room.transcript.length > 2000) {
      room.transcript.splice(0, room.transcript.length - 2000);
    }
    if (!show) return;
    room.lastFinalAt = Date.now();
    room.lastCaption = line;
    emitCaption(room, seq, { type: "caption", seq, ...line });
  } finally {
    finalShown();
  }
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
