const login = document.getElementById("login");
const dash = document.getElementById("dash");
const roomsEl = document.getElementById("rooms");
let pollingTimer = null;

function startPolling() {
  if (pollingTimer) return;
  pollingTimer = setInterval(loadStatus, 4000);
}

async function loadStatus() {
  const res = await fetch("/admin/api/status");
  if (res.status === 401) {
    dash.hidden = true;
    login.hidden = false;
    return;
  }
  const data = await res.json();
  login.hidden = true;
  dash.hidden = false;
  roomsEl.innerHTML = "";
  for (const room of data.rooms) {
    const card = document.createElement("section");
    card.className = "room-card";

    const title = document.createElement("h2");
    title.textContent = room.id;
    card.appendChild(title);

    const status = document.createElement("p");
    status.textContent =
      `Captura: ${room.captureOnline ? "online" : "offline"} · ` +
      `Overlay: ${room.overlays} · ${room.direction ?? "—"}`;
    card.appendChild(status);

    const last = document.createElement("p");
    last.className = "last";
    last.textContent = room.lastCaption
      ? `${room.lastCaption.original}\n→ ${room.lastCaption.translated}`
      : "—";
    card.appendChild(last);

    const links = document.createElement("p");
    const addLink = (label, href) => {
      if (links.childNodes.length) links.append(" · ");
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      links.appendChild(link);
    };
    addLink("captura", room.captureUrl);
    addLink("overlay", room.overlayUrl);
    addLink(
      "download",
      `/admin/api/transcript/${encodeURIComponent(room.id)}?format=txt`,
    );
    card.appendChild(links);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reiniciar sessão";
    reset.addEventListener("click", async () => {
      await fetch(`/admin/api/reset/${encodeURIComponent(room.id)}`, {
        method: "POST",
      });
      loadStatus();
    });
    card.appendChild(reset);

    roomsEl.appendChild(card);
  }
}

login.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = new FormData(login).get("password");
  const res = await fetch("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    alert("Senha inválida");
    return;
  }
  await loadStatus();
  startPolling();
});

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/admin/logout", { method: "POST" });
  location.reload();
});

fetch("/admin/api/me").then((r) => {
  if (r.ok) {
    loadStatus();
    startPolling();
  }
});
