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

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
    committed = "";
    live = "";
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
      committed = "";
      live = "";
      liveSeq = 0;
      render();
      return;
    }
    if (msg.type === "caption") {
      const text = msg.translated || msg.original || "";
      const seq = Number(msg.seq ?? 0);
      if (msg.final) {
        committed = text;
        // Clear the live line only if it belongs to this sentence; keep the next one.
        if (seq >= liveSeq) live = "";
      } else {
        live = text;
        liveSeq = seq;
      }
      render();
      scheduleHide();
    }
  };
  ws.onclose = () => setTimeout(connect, 1200);
}

connect();
