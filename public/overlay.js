const params = new URLSearchParams(location.search);
const parts = location.pathname.split("/").filter(Boolean);
const room = parts[1];
const k = params.get("k") ?? "";

const wrap = document.getElementById("caption");
const committedEl = document.getElementById("committed");
const liveEl = document.getElementById("live");
const liveTextEl = document.getElementById("live-text");

// TV style: the finalized sentence stays on top while the current one forms below.
let committed = "";
let live = "";
let liveSeq = 0;
let hideTimer = null;
let liveShown = "";
let liveTarget = "";
let pendingFinal = false;
let paceTimer = null;

const PACE_WORD_MS = 50;

// Words already on screen are revised in place ("Post" to "PostgreSQL"), so the
// line never shrinks to retype them. New words appear one per tick, several when
// far behind so a large chunk does not trail the speaker.
function nextPacedCaption(shown, target) {
  if (target === shown || !target) return target;
  const targetWords = target.trim().split(/\s+/);
  const shownCount = shown.trim().split(/\s+/).filter(Boolean).length;
  const behind = targetWords.length - shownCount;
  const n = shownCount + (behind > 8 ? Math.ceil(behind / 4) : 1);
  return n >= targetWords.length ? target : targetWords.slice(0, n).join(" ");
}

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function stopPace() {
  if (paceTimer != null) {
    clearTimeout(paceTimer);
    paceTimer = null;
  }
}

function promoteFinal() {
  committed = liveTarget || live;
  live = "";
  liveTarget = "";
  liveShown = "";
  pendingFinal = false;
  render();
}

function paceTick() {
  paceTimer = null;
  live = nextPacedCaption(live, liveTarget);
  render();
  if (live !== liveTarget) paceTimer = setTimeout(paceTick, PACE_WORD_MS);
  else if (pendingFinal) promoteFinal();
}

function startPace() {
  if (paceTimer != null) return;
  paceTick();
}

// The server locks the start of the sentence, so usually only the tail changes:
// fade it in instead of flashing the entire line.
function renderLive() {
  if (!live) {
    liveTextEl.textContent = "";
    liveShown = "";
    return;
  }
  let n = 0;
  while (n < liveShown.length && n < live.length && liveShown[n] === live[n]) n++;
  n = live.lastIndexOf(" ", n) + 1;
  liveTextEl.innerHTML = `${escapeHtml(live.slice(0, n))}<span class="grow">${escapeHtml(live.slice(n))}</span>`;
  liveShown = live;
}

function render() {
  committedEl.textContent = committed;
  renderLive();
  wrap.classList.toggle("has-live", Boolean(live));
  // Measure with the live caption limited to one line; give it both lines if it overflows.
  wrap.classList.remove("live-long");
  if (committed && live && liveTextEl.offsetHeight > liveEl.clientHeight + 2) {
    wrap.classList.add("live-long");
  }
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    stopPace();
    committed = "";
    live = "";
    liveTarget = "";
    pendingFinal = false;
    render();
  }, 10000);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&k=${encodeURIComponent(k)}&role=overlay`,
  );
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "clear") {
      stopPace();
      committed = "";
      live = "";
      liveTarget = "";
      liveSeq = 0;
      pendingFinal = false;
      render();
      return;
    }
    if (msg.type === "caption") {
      const text = msg.translated || msg.original || "";
      const seq = Number(msg.seq ?? 0);
      // Any other sequence is a new sentence; it must not overwrite a final that is
      // still pacing out. Non-finals are always accepted: the server orders them,
      // and after a server restart their sequence numbers start over.
      if (pendingFinal && seq !== liveSeq) promoteFinal();
      if (msg.final && seq < liveSeq) {
        committed = text;
        render();
      } else {
        liveTarget = text;
        liveSeq = seq;
        pendingFinal = Boolean(msg.final);
        startPace();
      }
      scheduleHide();
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}

connect();
