const STATUS_META = {
  ok: { label: "ปกติ", className: "ok" },
  warning: { label: "เฝ้าระวัง", className: "warning" },
  critical: { label: "วิกฤต", className: "critical" },
  offline: { label: "ออฟไลน์", className: "offline" },
};

const state = { devices: [], summary: null, filter: "all", query: "" };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function clampNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, number));
}

function formatPercent(value) {
  return value === null || value === undefined || value === "" ? "—" : `${clampNumber(value)}%`;
}

function barHtml(value) {
  const percent = clampNumber(value);
  const level = percent >= 95 ? "critical" : percent >= 85 ? "warning" : "";
  return `<div class="bar ${level ? `is-${level}` : ""}"><i style="width:${percent}%"></i></div>`;
}

function metricHtml(label, value) {
  return `<div class="metric">
    <div class="metric-value"><strong>${escapeHtml(label)}</strong><span>${formatPercent(value)}</span></div>
    ${barHtml(value)}
  </div>`;
}

function disksHtml(disks) {
  if (!Array.isArray(disks) || disks.length === 0) return '<span class="muted-cell">—</span>';
  return disks.slice(0, 3).map((disk) => {
    const percent = clampNumber(disk?.usedPct);
    const level = percent >= 95 ? "critical" : percent >= 85 ? "warning" : "";
    return `<div class="disk-row">
      <span class="disk-name">${escapeHtml(disk?.name)}</span>
      <div class="bar ${level ? `is-${level}` : ""}"><i style="width:${percent}%"></i></div>
      <span class="disk-pct">${formatPercent(disk?.usedPct)}</span>
    </div>`;
  }).join("");
}

function relativeTime(iso) {
  const difference = Date.now() - Date.parse(iso ?? "");
  if (!Number.isFinite(difference)) return "ไม่ทราบ";
  const seconds = Math.max(0, Math.round(difference / 1000));
  if (seconds < 10) return "เมื่อสักครู่";
  if (seconds < 60) return `${seconds} วิที่แล้ว`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ชม.ที่แล้ว`;
  return `${Math.floor(hours / 24)} วันที่แล้ว`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบ";
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function sparklineHtml(history) {
  const items = Array.isArray(history) ? history.slice(-20) : [];
  if (items.length === 0) return '<span class="muted-cell">—</span>';

  const positions = { ok: 19, offline: 15, warning: 10, critical: 4 };
  const colors = {
    ok: "var(--ok)",
    offline: "var(--offline)",
    warning: "var(--warning)",
    critical: "var(--critical)",
  };
  const last = items[items.length - 1];
  const step = items.length > 1 ? 96 / (items.length - 1) : 0;
  const points = items
    .map((item, index) => `${(index * step).toFixed(1)},${positions[item?.status] ?? 19}`)
    .join(" ");
  const color = colors[last?.status] ?? "var(--accent)";
  const lastY = positions[last?.status] ?? 19;

  return `<svg class="trend" viewBox="0 0 100 24" role="img" aria-label="ประวัติสถานะล่าสุด">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
    <circle cx="100" cy="${lastY}" r="2.5" fill="${color}"></circle>
  </svg>`;
}

function deviceRow(device) {
  const status = STATUS_META[device.status] ?? STATUS_META.offline;
  const uptime = device.metrics?.uptimeHours;
  const details = [
    device.os,
    device.user,
    device.ip,
    uptime !== null && uptime !== undefined ? `Uptime ${uptime} ชม.` : null,
  ].filter(Boolean).map(escapeHtml).join(" · ");
  const message = device.message
    ? `<span class="message">${escapeHtml(device.message)}</span>`
    : "";

  return `<tr>
    <td>
      <div class="device-name">${escapeHtml(device.displayName || device.hostname)}</div>
      <div class="device-meta">${details || escapeHtml(device.hostname)}</div>
    </td>
    <td>
      <span class="badge badge--${status.className}">${status.label}</span>
      ${message}
    </td>
    <td>${metricHtml("CPU", device.metrics?.cpuPct)}</td>
    <td>${metricHtml("RAM", device.metrics?.memUsedPct)}</td>
    <td>${disksHtml(device.metrics?.disks)}</td>
    <td>
      <div>${escapeHtml(relativeTime(device.lastSeen))}</div>
      <div class="device-meta">${escapeHtml(formatDateTime(device.lastSeen))}</div>
    </td>
    <td>${sparklineHtml(device.history)}</td>
  </tr>`;
}

function renderSummary() {
  const counts = state.summary ?? { total: state.devices.length, ok: 0, warning: 0, critical: 0, offline: 0 };
  for (const key of ["total", "ok", "warning", "critical", "offline"]) {
    const element = $(`#count-${key}`);
    if (element) element.textContent = String(counts[key] ?? 0);
  }
}

function render() {
  renderSummary();
  const query = state.query.toLowerCase();
  const visible = state.devices.filter((device) => {
    const matchesStatus = state.filter === "all" || device.status === state.filter;
    const haystack = [device.hostname, device.displayName, device.ip, device.os, device.user]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return matchesStatus && (!query || haystack.includes(query));
  });

  $("#deviceRows").innerHTML = visible.length
    ? visible.map(deviceRow).join("")
    : `<tr><td colspan="7" class="empty">ไม่พบเครื่องที่ตรงกับเงื่อนไข</td></tr>`;
}

function setConnection(kind, text) {
  const element = $("#connection");
  element.className = `connection${kind ? ` is-${kind}` : ""}`;
  element.textContent = text;
}

async function load() {
  const button = $("#refreshBtn");
  button.disabled = true;

  try {
    const response = await fetch("/api/devices", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    state.devices = Array.isArray(data.devices) ? data.devices : [];
    state.summary = data.summary ?? null;
    render();

    $("#lastUpdated").textContent = `อัปเดตเมื่อ ${formatDateTime(data.generatedAt)}`;
    $("#banner").hidden = true;
    setConnection("online", "เชื่อมต่อแล้ว");
  } catch (error) {
    setConnection("offline", "เชื่อมต่อไม่ได้");
    const banner = $("#banner");
    banner.hidden = false;
    banner.textContent = `โหลดข้อมูลไม่สำเร็จ: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$("#search").addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

$("#filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  state.filter = button.dataset.status;
  for (const item of $("#filter").querySelectorAll("button")) {
    item.classList.toggle("active", item === button);
  }
  render();
});

$("#refreshBtn").addEventListener("click", load);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});

setInterval(load, 10_000);
load();
