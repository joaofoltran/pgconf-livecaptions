import type { WebSocket } from "ws";
import type { Direction } from "./config.js";

export type CaptionLine = {
  ts: number;
  original: string;
  translated: string;
  direction: Direction;
  final: boolean;
};

export type Room = {
  id: string;
  token: string;
  direction: Direction;
  capture: WebSocket | null;
  overlays: Set<WebSocket>;
  transcript: CaptionLine[];
  lastCaption: CaptionLine | null;
  captureOnline: boolean;
  seq: number;
  renderedSeq: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  lastSource: string | null;
  lastTranslation: string | null;
  draftTs: number;
  draftSource: string;
  draftCandidate: string;
  draftTimer: NodeJS.Timeout | null;
  draftsInFlight: Map<AbortController, { source: string; promise: Promise<string> }>;
  lastDraft: { source: string; translated: string } | null;
  lastDraftSeq: number;
  // Começo da tradução da frase atual que já se repetiu em dois drafts seguidos:
  // fica travado e o modelo continua a partir dele, para a linha viva só crescer.
  lockedPrefix: string;
  renderedFinalSeq: number;
  // STT no servidor: a página de captura manda PCM e o servidor fala com o Deepgram.
  dg: WebSocket | null;
  dgLastMsg: number;
  dgReconnectTimer: NodeJS.Timeout | null;
  sttActive: boolean;
};

export function createRoom(id: string, token: string): Room {
  return {
    id,
    token,
    direction: "en-pt",
    capture: null,
    overlays: new Set(),
    transcript: [],
    lastCaption: null,
    captureOnline: false,
    seq: 0,
    renderedSeq: 0,
    pending: "",
    flushTimer: null,
    lastSource: null,
    lastTranslation: null,
    draftTs: 0,
    draftSource: "",
    draftCandidate: "",
    draftTimer: null,
    draftsInFlight: new Map(),
    lastDraft: null,
    lastDraftSeq: 0,
    lockedPrefix: "",
    renderedFinalSeq: 0,
    dg: null,
    dgLastMsg: 0,
    dgReconnectTimer: null,
    sttActive: false,
  };
}

// As traduções correm em paralelo, então uma lenta nunca pode sobrescrever uma mais
// nova. Finais e drafts são faixas diferentes no overlay: um final da frase anterior
// deve entrar na linha consolidada mesmo que um draft da frase seguinte já esteja
// na linha viva; já um draft mais antigo que o último final pertence a uma frase
// que acabou de fechar e é descartado.
export function emitCaption(
  room: Room,
  seq: number,
  payload: { final?: boolean } & Record<string, unknown>
): void {
  if (payload.final) {
    if (seq < room.renderedFinalSeq) return;
    room.renderedFinalSeq = seq;
    room.renderedSeq = Math.max(room.renderedSeq, seq);
  } else {
    if (seq < room.renderedSeq) return;
    room.renderedSeq = seq;
  }
  broadcastOverlays(room, payload);
}

export function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function broadcastOverlays(room: Room, payload: unknown): void {
  for (const overlay of room.overlays) {
    sendJson(overlay, payload);
  }
}

export function statusPayload(room: Room) {
  return {
    type: "status",
    room: room.id,
    captureOnline: room.captureOnline,
    overlays: room.overlays.size,
    direction: room.direction,
    lastCaption: room.lastCaption,
    // "server" = página nova mandando áudio para cá; "browser" = página antiga
    // falando direto com o Deepgram (ou captura parada).
    stt: room.dg ? "server" : "browser",
  };
}

export function notifyRoom(room: Room, payload: unknown): void {
  if (room.capture) sendJson(room.capture, payload);
  broadcastOverlays(room, payload);
}
