const $ = (selector) => document.querySelector(selector);

const state = { hasUsers: true };

function safeNext() {
  const value = new URLSearchParams(location.search).get("next") || "/";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function setStatus(text, isError = false) {
  const element = $("#loginStatus");
  element.textContent = text;
  element.classList.toggle("is-error", isError);
}

function errorMessage(data, fallback) {
  if (data?.detail) return data.detail;
  const messages = {
    INVALID_CREDENTIALS: "username หรือรหัสผ่านไม่ถูกต้อง",
    SETUP_CLOSED: "มีผู้ใช้แล้ว กรุณาเข้าสู่ระบบแทน",
    INVALID_INPUT: "ข้อมูลไม่ถูกต้อง",
    KV_BINDING_MISSING: "ยังไม่ได้ตั้งค่า KV ของแอป",
  };
  return messages[data?.error] ?? fallback;
}

async function init() {
  const button = $("#loginSubmit");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(errorMessage(data, "โหลดสถานะไม่สำเร็จ"));
    if (data.authenticated) {
      location.replace(safeNext());
      return;
    }

    state.hasUsers = Boolean(data.hasUsers);

    if (!state.hasUsers) {
      $("#loginTitle").textContent = "สร้างผู้ดูแลระบบ";
      $("#loginIntro").textContent = "ยังไม่มีผู้ใช้ กรอก username และรหัสผ่านเพื่อสร้าง admin คนแรก";
      $("#loginSubmit").textContent = "สร้างผู้ดูแลระบบ";
      $("#setupDisplayNameRow").hidden = false;
      $("#loginPassword").autocomplete = "new-password";
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function submit(event) {
  event.preventDefault();
  const button = $("#loginSubmit");
  button.disabled = true;
  setStatus("");

  const payload = {
    username: $("#loginUsername").value.trim(),
    password: $("#loginPassword").value,
  };
  if (!state.hasUsers) {
    payload.displayName = $("#setupDisplayName").value.trim();
  }

  try {
    const response = await fetch(state.hasUsers ? "/api/auth/login" : "/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorMessage(data, "เข้าสู่ระบบไม่สำเร็จ"));
    location.replace(safeNext());
  } catch (error) {
    setStatus(error.message, true);
    button.disabled = false;
  }
}

$("#loginForm").addEventListener("submit", submit);
init();
