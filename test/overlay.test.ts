import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import vm from "node:vm";

// Runs the real public/overlay.js against a minimal DOM and a fake WebSocket.
const source = fs.readFileSync(new URL("../public/overlay.js", import.meta.url), "utf8");

function element() {
  let html = "";
  return {
    offsetHeight: 0,
    clientHeight: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    get textContent() {
      return html.replace(/<[^>]+>/g, "");
    },
    set textContent(value: string) {
      html = value;
    },
  };
}

function loadOverlay() {
  const elements: Record<string, ReturnType<typeof element>> = {
    caption: element(),
    committed: element(),
    live: element(),
    "live-text": element(),
  };
  let socket: { onmessage?: (ev: { data: string }) => void } = {};
  vm.runInNewContext(source, {
    location: { search: "?k=token", pathname: "/r/room-1/overlay", protocol: "http:", host: "test" },
    document: { getElementById: (id: string) => elements[id] },
    WebSocket: class {
      constructor() {
        socket = this;
      }
      send() {}
    },
    URLSearchParams,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
  });
  return {
    caption: (seq: number, translated: string, final = false) =>
      socket.onmessage?.({ data: JSON.stringify({ type: "caption", seq, translated, final }) }),
    committed: () => elements.committed.textContent,
    live: () => elements["live-text"].textContent,
  };
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

// Mock timers fire one chained timeout per tick, so advance word by word.
const words = (n: number) => {
  for (let i = 0; i < n; i++) mock.timers.tick(50);
};

test("a large chunk is paced out word by word", () => {
  const overlay = loadOverlay();
  overlay.caption(1, "um dois três quatro");
  assert.equal(overlay.live(), "um");
  words(1);
  assert.equal(overlay.live(), "um dois");
  words(2);
  assert.equal(overlay.live(), "um dois três quatro");
});

test("a newer final does not drop an older final that is still pacing", () => {
  const overlay = loadOverlay();
  overlay.caption(1, "primeira frase bem longa aqui", true);
  overlay.caption(2, "segunda frase", true);
  assert.equal(overlay.committed(), "primeira frase bem longa aqui");
  words(3);
  assert.equal(overlay.committed(), "segunda frase");
});

test("revised words change in place instead of shrinking the line", () => {
  const overlay = loadOverlay();
  overlay.caption(1, "Post");
  overlay.caption(2, "PostgreSQL é rápido");
  assert.equal(overlay.live(), "PostgreSQL é");
  overlay.caption(3, "um dois três quatro cinco seis");
  words(6);
  overlay.caption(4, "um DOIS três quatro cinco seis sete.", true);
  assert.equal(overlay.committed(), "um DOIS três quatro cinco seis sete.");
});

test("a large chunk far behind is revealed several words per tick", () => {
  const overlay = loadOverlay();
  const chunk = Array.from({ length: 40 }, (_, i) => `p${i}`).join(" ");
  overlay.caption(1, chunk);
  words(14);
  assert.equal(overlay.live(), chunk);
});

test("after a server restart, drafts with restarted sequence numbers are shown", () => {
  const overlay = loadOverlay();
  overlay.caption(500, "frase antiga", true);
  words(2);
  overlay.caption(1, "nova frase");
  words(2);
  assert.equal(overlay.committed(), "frase antiga");
  assert.equal(overlay.live(), "nova frase");
});
