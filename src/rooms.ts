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
  // Start of the current sentence's translation repeated in two consecutive drafts:
  // lock it and have the model continue from there so the live line only grows.
  lockedPrefix: string;
  renderedFinalSeq: number;
  // Server-side STT: the capture page sends PCM and the server connects to Deepgram.
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

// Translations run in parallel, so a slow one must never overwrite a newer one.
// Finals and drafts occupy different overlay lanes: a previous sentence's final
// must enter the committed line even if a draft of the next sentence is already
// live. A draft older than the latest final belongs to a sentence that just
// closed and must be discarded.
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
    // "server" = new page sending audio here; "browser" = old page connecting
    // directly to Deepgram (or stopped capture).
    stt: room.dg ? "server" : "browser",
  };
}

export function notifyRoom(room: Room, payload: unknown): void {
  if (room.capture) sendJson(room.capture, payload);
  broadcastOverlays(room, payload);
}
