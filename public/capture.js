const params = new URLSearchParams(location.search);
const parts = location.pathname.split("/").filter(Boolean);
const room = parts[1];
const k = params.get("k") ?? "";

const deviceEl = document.getElementById("device");
const directionEl = document.getElementById("direction");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const copyBtn = document.getElementById("copy");
const lastEl = document.getElementById("last");

let overlayUrl = "";
let roomWs = null;
let dgWs = null;
let mediaStream = null;
let workletNode = null;
let audioCtx = null;
let running = false;
let pingTimer = null;
let watchdogTimer = null;
let lastDgMessage = 0;
// true = the server connects to Deepgram; send only PCM through the room WebSocket.
let sttProxy = false;

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === "audioinput");
  deviceEl.innerHTML = "";
  for (const d of mics) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microfone ${deviceEl.options.length + 1}`;
    deviceEl.appendChild(opt);
  }
}

async function ensurePermission() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  await listDevices();
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}&k=${encodeURIComponent(k)}&role=capture`;
}

function connectRoom() {
  return new Promise((resolve, reject) => {
    roomWs = new WebSocket(wsUrl());
    const timer = setTimeout(() => reject(new Error("servidor indisponível")), 8000);
    roomWs.onopen = () => {
      clearTimeout(timer);
      setText("st-ws", "online");
      // Resent on every reconnect: in server mode, this opens the Deepgram connection.
      if (running) {
        roomWs.send(
          JSON.stringify({
            type: "start",
            direction: directionEl.value,
            stt: sttProxy ? "server" : "browser",
          }),
        );
      }
      resolve();
    };
    roomWs.onclose = (event) => {
      if (event.code === 4409) {
        stop();
        setText("st-ws", "substituída");
        lastEl.textContent =
          "Outra página assumiu esta sala. Feche a duplicata e clique em Iniciar para reconectar.";
        return;
      }
      setText("st-ws", "offline");
      if (sttProxy) setText("st-dg", "offline");
      if (running) setTimeout(() => connectRoom().catch(console.error), 1500);
    };
    roomWs.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ping") roomWs.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "status") setText("st-ov", String(msg.overlays ?? "—"));
      if (msg.type === "dg") setText("st-dg", String(msg.status));
      if (msg.type === "transcript") lastEl.textContent = msg.text;
    };
  });
}

function downsample(buffer, inRate, outRate) {
  if (outRate === inRate) return buffer;
  const ratio = inRate / outRate;
  const outLen = Math.round(buffer.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = idx - lo;
    out[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac;
  }
  return out;
}

function floatTo16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function startDeepgram() {
  const res = await fetch(`/api/deepgram-token/${encodeURIComponent(room)}?k=${encodeURIComponent(k)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: directionEl.value }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Deepgram: ${detail.slice(0, 300)}`);
  }
  const { accessToken, listenUrl } = await res.json();
  dgWs = new WebSocket(listenUrl, ["bearer", accessToken]);
  dgWs.binaryType = "arraybuffer";
  dgWs.onopen = () => {
    lastDgMessage = Date.now();
    setText("st-dg", "online");
  };
  dgWs.onclose = (ev) => {
    setText("st-dg", `offline (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
    if (running) setTimeout(() => startDeepgram().catch(console.error), 2000);
  };
  dgWs.onerror = () => setText("st-dg", "erro");
  dgWs.onmessage = (ev) => {
    lastDgMessage = Date.now();
    const data = JSON.parse(ev.data);

    // Closes the sentence when Deepgram does not detect the pause on its own.
    if (data.type === "UtteranceEnd") {
      if (roomWs?.readyState === WebSocket.OPEN) {
        roomWs.send(JSON.stringify({ type: "flush" }));
      }
      return;
    }

    const alt = data.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text) return;
    lastEl.textContent = text;

    if (!data.is_final) {
      if (roomWs?.readyState === WebSocket.OPEN) {
        roomWs.send(
          JSON.stringify({ type: "interim", text, direction: directionEl.value }),
        );
      }
      return;
    }

    if (roomWs?.readyState === WebSocket.OPEN) {
      roomWs.send(
        JSON.stringify({
          type: "caption",
          text,
          final: true,
          speechFinal: Boolean(data.speech_final),
          direction: directionEl.value,
        }),
      );
    }
  };
}

async function startAudio() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceEl.value },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  audioCtx = new AudioContext({ sampleRate: 48000 });
  await audioCtx.audioWorklet.addModule("/static/audio-worklet.js");
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-capture");
  workletNode.port.onmessage = (e) => {
    const target = sttProxy ? roomWs : dgWs;
    if (!target || target.readyState !== WebSocket.OPEN) return;
    const down = downsample(e.data, audioCtx.sampleRate, 16000);
    target.send(floatTo16(down).buffer);
  };
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  source.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(audioCtx.destination);
  setText("st-mic", "capturando");
}

    // If Deepgram goes silent (throttled tab, network, etc.), force a reconnect
    // instead of leaving the display frozen.
function startWatchdog() {
  watchdogTimer = setInterval(() => {
    if (!running || !lastDgMessage) return;
    const quietMs = Date.now() - lastDgMessage;
    if (quietMs > 10000) {
      setText("st-dg", "sem resposta, reconectando…");
      lastDgMessage = Date.now();
      try {
        dgWs?.close();
      } catch {
        /* onclose schedules the reconnect */
      }
    }
  }, 5000);
}

async function start() {
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  await connectRoom();
  if (sttProxy) {
    setText("st-dg", "via servidor…");
  } else {
    await startDeepgram();
  }
  await startAudio();
  pingTimer = setInterval(() => {
    if (roomWs?.readyState === WebSocket.OPEN) {
      roomWs.send(JSON.stringify({ type: "ping" }));
    }
  }, 10000);
  if (!sttProxy) startWatchdog();
}

function stop() {
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  clearInterval(pingTimer);
  clearInterval(watchdogTimer);
  workletNode?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  dgWs?.close();
  roomWs?.close();
  setText("st-mic", "parado");
  setText("st-dg", "offline");
  setText("st-ws", "offline");
}

startBtn.addEventListener("click", () => start().catch((err) => {
  console.error(err);
  lastEl.textContent = String(err);
  stop();
}));
stopBtn.addEventListener("click", stop);
copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(overlayUrl);
  copyBtn.textContent = "Copiado";
  setTimeout(() => {
    copyBtn.textContent = "Copiar URL do overlay";
  }, 1500);
});

(async () => {
  const res = await fetch(`/api/session/${encodeURIComponent(room)}?k=${encodeURIComponent(k)}`);
  const data = await res.json();
  overlayUrl = `${location.origin}${data.overlayPath}`;
  sttProxy = Boolean(data.sttProxy);
  await ensurePermission().catch(() => listDevices());
})();
