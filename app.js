/* TouchTether — tether to any open app + placeable touch controls that drive games.
 * No build step. Multi-touch via Pointer Events.
 * InputBridge: every control press maps to keyboard keys -> real keydown/keyup
 * events (for focused/embedded web games) + a shared state object the demo
 * game (or your own iframe game) can read. For native PC games, map these
 * same keys in JoyToKey/AntiMicroX/Steam Input, or forward via WebSocket
 * (see InputBridge.broadcast).
 */
(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stage = $("#stage"), layer = $("#controlLayer");
const video = $("#tetherVideo"), placeholder = $("#tetherPlaceholder");
const demoCanvas = $("#demoGame");
const logEl = $("#log"), keysLive = $("#keysLive");

const LS_KEY = "touchtether.layout.v1";
let mode = "play"; // 'play' | 'edit'
let controls = [];
let selectedId = null;
let seq = 1;

/* ---------------- Input bridge ---------------- */
const pressed = new Set(); // canonical key names, e.g. "KeyW", "Space", "ArrowUp"
const joyVec = { x: 0, y: 0 }; // last active joystick vector

const InputBridge = {
  get pressed() { return new Set(pressed); },
  get vector() { return { ...joyVec }; },
  // Optional: forward state to a native-game relay server over WebSocket.
  // Example relay: `node relay.js` listening on :8137, using nut.js/robotjs
  // to inject keys into the tethered desktop game. Uncomment to enable:
  // ws: null,
  // connect(url="ws://localhost:8137"){ this.ws=new WebSocket(url); },
  broadcast() {
    // if (this.ws && this.ws.readyState===1) this.ws.send(JSON.stringify({keys:[...pressed],joy:joyVec}));
  },
  canon(raw) {
    if (!raw) return null;
    const t = String(raw).trim();
    if (t.length === 1) {
      if (/^[a-z0-9]$/i.test(t)) return "Key" + t.toUpperCase();
      if (t === " ") return "Space";
      return "Key" + t.toUpperCase();
    }
    const up = t.toUpperCase();
    const map = { SPACE:"Space", SHIFT:"ShiftLeft", CTRL:"ControlLeft", ALT:"AltLeft", TAB:"Tab", ENTER:"Enter", ESC:"Escape", ESCAPE:"Escape", UP:"ArrowUp", DOWN:"ArrowDown", LEFT:"ArrowLeft", RIGHT:"ArrowRight" };
    if (map[up]) return map[up];
    if (/^(KEY[A-Z]|DIGIT[0-9]|ARROW(UP|DOWN|LEFT|RIGHT)|SPACE|ENTER|SHIFTLEFT|SHIFTRIGHT)$/.test(up)) return up[0]+up.slice(1).toLowerCase().replace(/^(.)/,c=>c.toUpperCase()) && normalizeCode(up);
    if (/^ARROW/.test(up)) return {ARROWUP:"ArrowUp",ARROWDOWN:"ArrowDown",ARROWLEFT:"ArrowLeft",ARROWRIGHT:"ArrowRight"}[up];
    return t.length <= 6 ? t : t.slice(0,6);
    function normalizeCode(u){ return u[0]+u.slice(1).toLowerCase(); }
  },
  eventCode(canon) {
    // canon already stored as e.code-style where possible
    return canon;
  },
  keyLabel(canon) {
    const m = { Space:"SPACE", ArrowUp:"↑", ArrowDown:"↓", ArrowLeft:"←", ArrowRight:"→" };
    if (m[canon]) return m[canon];
    if (/^Key(.)$/.test(canon)) return canon.slice(3);
    if (/^Digit(.)$/.test(canon)) return canon.slice(5);
    return canon;
  }
};

function pressKey(raw) {
  const c = InputBridge.canon(raw);
  if (!c) return;
  const was = pressed.has(c);
  pressed.add(c);
  if (!was) {
    const code = InputBridge.eventCode(c);
    const key = code === "Space" ? " " : code.replace(/^Key/,"").replace(/^Digit/,"").replace(/^Arrow/,"Arrow");
    document.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true }));
    // Also target the focused element / test box so typing works
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true }));
    log(`▼ <b>${esc(InputBridge.keyLabel(c))}</b> <span class="dim">${esc(code)} down</span>`);
  }
  InputBridge.broadcast();
  renderKeysLive();
}
function releaseKey(raw) {
  const c = InputBridge.canon(raw);
  if (!c) return;
  // Only release if no other control still holds it
  if (stillHeld(c)) return;
  if (pressed.delete(c)) {
    const code = InputBridge.eventCode(c);
    const key = code === "Space" ? " " : code.replace(/^Key/,"").replace(/^Digit/,"").replace(/^Arrow/,"Arrow");
    document.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code, key, bubbles: true }));
    log(`△ <b>${esc(InputBridge.keyLabel(c))}</b> <span class="dim">${esc(code)} up</span>`);
  }
  InputBridge.broadcast();
  renderKeysLive();
}
// Keys held directly by physical keyboard should not be released by overlay logic.
const heldByControl = new Map(); // canon -> count
function controlDown(raw) {
  const c = InputBridge.canon(raw); if (!c) return;
  heldByControl.set(c, (heldByControl.get(c) || 0) + 1);
  pressKey(c);
}
function controlUp(raw) {
  const c = InputBridge.canon(raw); if (!c) return;
  heldByControl.set(c, Math.max(0, (heldByControl.get(c) || 1) - 1));
  if ((heldByControl.get(c) || 0) === 0) releaseKey(c);
  else renderKeysLive();
}
function stillHeld(c) { return (heldByControl.get(c) || 0) > 0; }

function renderKeysLive() {
  const all = new Set([...pressed]);
  if (all.size === 0) { keysLive.innerHTML = `<span class="dim">— press a control or keyboard —</span>`; return; }
  keysLive.innerHTML = [...all].map(k => `<span class="keycap">${esc(InputBridge.keyLabel(k))}</span>`).join("");
  const names = [...all].map(k => InputBridge.keyLabel(k)).join(" + ");
  $("#mapSummary").textContent = names;
}

/* Physical keyboard passes through the same state so demo game + monitor agree */
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (/^(INPUT|TEXTAREA)/.test(document.activeElement?.tagName || "") && e.code !== "Escape") {
    // let typing work, but still mirror into state
  }
  if (!pressed.has(e.code)) { pressed.add(e.code); log(`▼ <b>${esc(InputBridge.keyLabel(e.code))}</b> <span class="dim">kbd</span>`); renderKeysLive(); }
});
window.addEventListener("keyup", (e) => {
  if (pressed.has(e.code) && !stillHeld(e.code)) { pressed.delete(e.code); log(`△ <b>${esc(InputBridge.keyLabel(e.code))}</b> <span class="dim">kbd up</span>`); renderKeysLive(); }
});

/* ---------------- Layout model ---------------- */
function defaults() {
  return [
    { id: "joy1", type: "joystick", x: 18, y: 62, size: 150, label: "MOVE", color: "#22d3ee",
      keys: { up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" } },
    { id: "btn1", type: "button", x: 82, y: 55, size: 92, label: "A", color: "#a78bfa", keys: { main: "Space" } },
    { id: "btn2", type: "button", x: 91, y: 72, size: 72, label: "B", color: "#f472b6", keys: { main: "KeyE" } },
    { id: "dpad1", type: "dpad", x: 82, y: 30, size: 132, label: "DPAD", color: "#34d399",
      keys: { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" } },
  ];
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(controls)); } catch {} }
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaults();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return defaults();
    return arr.filter(c => c && c.type && typeof c.x === "number");
  } catch { return defaults(); }
}

/* ---------------- Rendering controls ---------------- */
function render() {
  layer.innerHTML = "";
  document.body.dataset.mode = mode;
  for (const c of controls) layer.appendChild(renderControl(c));
  updateCfgPanel();
}

function renderControl(c) {
  const el = document.createElement("div");
  el.className = `ctl ${c.type === "button" ? "btn-c" : c.type === "dpad" ? "dpad" : "joy"}${selectedId === c.id && mode === "edit" ? " selected" : ""}`;
  el.dataset.id = c.id;
  el.style.left = c.x + "%";
  el.style.top = c.y + "%";
  el.style.width = c.size + "px";
  el.style.height = c.size + "px";
  el.style.setProperty("--c", c.color || "#22d3ee");
  el.style.setProperty("--s", c.size + "px");

  const tag = document.createElement("div");
  tag.className = "tag";
  tag.textContent = `${c.type} · ${keysSummary(c)}`;
  el.appendChild(tag);

  const body = document.createElement("div");
  body.className = "body";
  if (c.type === "joystick") {
    body.innerHTML = `<span style="font-size:11px;font-weight:800;opacity:.8">${esc(c.label || "JOY")}</span><div class="knob"></div>`;
    wireJoystick(el, body, c);
  } else if (c.type === "button") {
    body.textContent = c.label || "A";
    wireButton(el, body, c);
  } else {
    const g = document.createElement("div");
    g.className = "dpad-grid";
    const faces = [["", ""], ["up", "▲"], ["", ""], ["left", "◀"], ["", "●"], ["right", "▶"], ["", ""], ["down", "▼"], ["", ""]];
    for (const [name, glyph] of faces) {
      if (!name) { const s = document.createElement("span"); s.className = "empty"; g.appendChild(s); continue; }
      const b = document.createElement("button");
      b.textContent = glyph; b.dataset.face = name;
      b.setAttribute("aria-label", `dpad ${name} (${c.keys?.[name] || ""})`);
      wireDPadFace(b, c, name);
      g.appendChild(b);
    }
    body.appendChild(g);
  }
  el.appendChild(body);

  const rh = document.createElement("div");
  rh.className = "resize-handle";
  el.appendChild(rh);

  wireEditDrag(el, rh, c);
  return el;
}

function keysSummary(c) {
  if (c.type === "button") return InputBridge.keyLabel(InputBridge.canon(c.keys?.main) || "?");
  const k = c.keys || {};
  return [k.up && "↑", k.down && "↓", k.left && "←", k.right && "→"].filter(Boolean).join("") || "?";
}

/* ---------------- Play interactions ---------------- */
function wireButton(el, body, c) {
  const down = (e) => {
    if (mode !== "play") return;
    e.preventDefault();
    body.classList.add("pressed");
    el.setPointerCapture?.(e.pointerId);
    controlDown(c.keys.main);
  };
  const up = (e) => {
    if (!body.classList.contains("pressed")) return;
    body.classList.remove("pressed");
    controlUp(c.keys.main);
  };
  body.addEventListener("pointerdown", down);
  body.addEventListener("pointerup", up);
  body.addEventListener("pointercancel", up);
  body.addEventListener("lostpointercapture", up);
}

function wireDPadFace(btn, c, face) {
  btn.addEventListener("pointerdown", (e) => {
    if (mode !== "play") return;
    e.preventDefault(); e.stopPropagation();
    btn.classList.add("pressed");
    btn.setPointerCapture?.(e.pointerId);
    controlDown(c.keys[face]);
  });
  const up = () => { if (btn.classList.contains("pressed")) { btn.classList.remove("pressed"); controlUp(c.keys[face]); } };
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", up);
}

function wireJoystick(el, body, c) {
  const knob = body.querySelector(".knob");
  let activePointer = null;
  let cur = { x: 0, y: 0 };
  const heldDirs = new Set();

  const setKnob = (dx, dy) => {
    const r = el.clientWidth / 2;
    knob.style.transform = `translate(${dx * r * 0.55}px, ${dy * r * 0.55}px)`;
  };
  const applyDirs = (dx, dy) => {
    const want = new Set();
    const T = 0.28;
    if (dy < -T) want.add("up");
    if (dy > T) want.add("down");
    if (dx < -T) want.add("left");
    if (dx > T) want.add("right");
    for (const d of ["up", "down", "left", "right"]) {
      if (want.has(d) && !heldDirs.has(d)) { heldDirs.add(d); controlDown(c.keys[d]); }
      if (!want.has(d) && heldDirs.has(d)) { heldDirs.delete(d); controlUp(c.keys[d]); }
    }
    cur = { x: dx, y: dy };
    joyVec.x = dx; joyVec.y = dy;
    InputBridge.broadcast();
  };
  body.addEventListener("pointerdown", (e) => {
    if (mode !== "play") return;
    e.preventDefault();
    activePointer = e.pointerId;
    body.setPointerCapture?.(e.pointerId);
    move(e);
  });
  body.addEventListener("pointermove", (e) => { if (e.pointerId === activePointer) move(e); });
  const end = (e) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    setKnob(0, 0);
    applyDirs(0, 0);
    for (const d of [...heldDirs]) { heldDirs.delete(d); controlUp(c.keys[d]); }
    joyVec.x = 0; joyVec.y = 0;
  };
  body.addEventListener("pointerup", end);
  body.addEventListener("pointercancel", end);
  function move(e) {
    const r = el.getBoundingClientRect();
    let dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2));
    let dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2));
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    setKnob(dx, dy);
    applyDirs(dx, dy);
  }
}

/* ---------------- Edit interactions ---------------- */
function wireEditDrag(el, rh, c) {
  let drag = null, resize = null;
  el.addEventListener("pointerdown", (e) => {
    if (mode !== "edit") return;
    selectedId = c.id;
    render();
    updateCfgPanel();
  });
  // drag body
  el.addEventListener("pointerdown", (e) => {
    if (mode !== "edit" || e.target === rh || e.target.closest(".resize-handle")) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    const s = stage.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - (s.left + (c.x / 100) * s.width), dy: e.clientY - (s.top + (c.y / 100) * s.height) };
  });
  el.addEventListener("pointermove", (e) => {
    const s = stage.getBoundingClientRect();
    if (drag && e.pointerId === drag.id) {
      c.x = clamp(((e.clientX - drag.dx - s.left) / s.width) * 100, 3, 97);
      c.y = clamp(((e.clientY - drag.dy - s.top) / s.height) * 100, 6, 94);
      el.style.left = c.x + "%"; el.style.top = c.y + "%";
    }
    if (resize && e.pointerId === resize.id) {
      const d = Math.hypot(e.clientX - resize.x0, e.clientY - resize.y0);
      c.size = clamp(Math.round(resize.s0 + d), 48, 260);
      el.style.width = el.style.height = c.size + "px";
      el.style.setProperty("--s", c.size + "px");
    }
  });
  const stop = (e) => {
    if (drag && e.pointerId === drag.id) { drag = null; save(); updateCfgPanel(); }
    if (resize && e.pointerId === resize.id) { resize = null; save(); updateCfgPanel(); syncCfgSize(); }
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  rh.addEventListener("pointerdown", (e) => {
    if (mode !== "edit") return;
    e.preventDefault(); e.stopPropagation();
    selectedId = c.id; render(); updateCfgPanel();
    rh.setPointerCapture?.(e.pointerId);
    resize = { id: e.pointerId, x0: e.clientX, y0: e.clientY, s0: c.size };
  });
  rh.addEventListener("pointermove", (e) => {
    if (resize && e.pointerId === resize.id) {
      const d = Math.hypot(e.clientX - resize.x0, e.clientY - resize.y0);
      const ctl = controls.find(k => k.id === c.id);
      if (ctl) {
        ctl.size = clamp(Math.round(resize.s0 + d), 48, 260);
        const node = layer.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
        if (node) { node.style.width = node.style.height = ctl.size + "px"; }
      }
    }
  });
  rh.addEventListener("pointerup", (e) => { if (resize && e.pointerId === resize.id) { resize = null; save(); updateCfgPanel(); } });
}

/* ---------------- Config panel ---------------- */
function selected() { return controls.find(c => c.id === selectedId) || null; }
function updateCfgPanel() {
  const c = selected();
  $("#noSel").classList.toggle("hidden", !!c);
  $("#cfgPanel").classList.toggle("hidden", !c);
  if (!c) return;
  $("#cfgType").textContent = c.type;
  if (document.activeElement !== $("#cfgLabel")) $("#cfgLabel").value = c.label || "";
  $("#cfgColor").value = c.color || "#22d3ee";
  $("#cfgSize").value = c.size;
  $("#cfgSizeVal").textContent = c.size + "px";
  const box = $("#cfgKeys");
  box.innerHTML = "";
  const fields = c.type === "button" ? [["main", "Press key"]] :
    [["up", "↑ Up"], ["down", "↓ Down"], ["left", "← Left"], ["right", "→ Right"]];
  for (const [k, label] of fields) {
    const wrap = document.createElement("label");
    wrap.className = "kf";
    wrap.innerHTML = `<span>${label}</span>`;
    const inp = document.createElement("input");
    inp.value = c.keys?.[k] || "";
    inp.placeholder = "e.g. Space / W / ↑";
    inp.maxLength = 12;
    inp.spellcheck = false;
    inp.addEventListener("change", () => {
      const canon = InputBridge.canon(inp.value) || inp.value;
      c.keys[k] = canon;
      inp.value = canon;
      save(); render();
      log(`⚙ <b>${esc(c.label || c.type)}</b> ${esc(k)} → <b>${esc(canon)}</b>`);
    });
    wrap.appendChild(inp);
    box.appendChild(wrap);
  }
}
function syncCfgSize() { const c = selected(); if (c) { $("#cfgSize").value = c.size; $("#cfgSizeVal").textContent = c.size + "px"; } }
$("#cfgLabel").addEventListener("input", (e) => { const c = selected(); if (c) { c.label = e.target.value.toUpperCase().slice(0, 8); save(); renderSoft(); } });
$("#cfgColor").addEventListener("input", (e) => { const c = selected(); if (c) { c.color = e.target.value; save(); renderSoft(); } });
$("#cfgSize").addEventListener("input", (e) => { const c = selected(); if (c) { c.size = +e.target.value; $("#cfgSizeVal").textContent = c.size + "px"; save(); renderSoft(); } });
$("#btnDup").addEventListener("click", () => {
  const c = selected(); if (!c) return;
  const n = JSON.parse(JSON.stringify(c));
  n.id = "c" + Date.now().toString(36) + (seq++);
  n.x = clamp(n.x + 6, 3, 94); n.y = clamp(n.y + 6, 6, 92);
  controls.push(n); selectedId = n.id; save(); render();
});
$("#btnDel").addEventListener("click", () => {
  controls = controls.filter(c => c.id !== selectedId);
  selectedId = null; save(); render();
});
function renderSoft() {
  // update in place without rebuilding (keeps drag smooth for color/label)
  const c = selected(); if (!c) return;
  const node = layer.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
  if (!node) { render(); return; }
  node.style.width = node.style.height = c.size + "px";
  node.style.setProperty("--c", c.color);
}

/* ---------------- Toolbar / mode ---------------- */
function setMode(m) {
  mode = m;
  $("#modePlay").classList.toggle("active", m === "play");
  $("#modeEdit").classList.toggle("active", m === "edit");
  $("#editHint").classList.toggle("hidden", m !== "edit");
  render();
  log(m === "edit" ? "✏️ <b>Edit mode</b> — drag controls anywhere, resize with the yellow dot." : "▶ <b>Play mode</b> — controls are live. Try the joystick + buttons.");
}
$("#modePlay").addEventListener("click", () => setMode("play"));
$("#modeEdit").addEventListener("click", () => setMode("edit"));
$$("[data-add]").forEach(b => b.addEventListener("click", () => {
  const type = b.dataset.add;
  const base = type === "joystick"
    ? { type, x: 30, y: 55, size: 140, label: "JOY", color: "#22d3ee", keys: { up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" } }
    : type === "button"
    ? { type, x: 65, y: 60, size: 84, label: "A", color: "#a78bfa", keys: { main: "Space" } }
    : { type: "dpad", x: 65, y: 30, size: 132, label: "DPAD", color: "#34d399", keys: { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" } };
  base.id = "c" + Date.now().toString(36) + (seq++);
  controls.push(base); selectedId = base.id; save();
  if (mode !== "edit") setMode("edit"); else render();
  log(`＋ added <b>${type}</b> — drag it where you want it.`);
}));
$("#btnClear").addEventListener("click", () => { controls = []; selectedId = null; save(); render(); });
$("#btnSave").addEventListener("click", () => { save(); log("💾 layout saved to this browser."); });
$("#btnLoad").addEventListener("click", () => { controls = defaults(); selectedId = null; save(); render(); log("↺ defaults restored."); });
$("#btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(controls, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "touchtether-layout.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("#btnImport").addEventListener("click", () => $("#fileImport").click());
$("#fileImport").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { controls = JSON.parse(await f.text()); save(); render(); log("⬆ layout imported."); }
  catch { log("⚠ import failed — invalid JSON."); }
});
$("#btnClearLog").addEventListener("click", () => { logEl.innerHTML = ""; });
$("#btnTestKeys").addEventListener("click", () => { $("#testBox").focus(); log("⌨ test-box focused — press overlay controls and keys will type here."); });
$("#chkGrid").addEventListener("change", (e) => stage.classList.toggle("grid-off", !e.target.checked));
$("#chkDemoGame").addEventListener("change", (e) => { demoOn = e.target.checked; });
$("#chkVideoBg").addEventListener("change", (e) => { videoOn = e.target.checked; updateBg(); });
$("#rngOpacity").addEventListener("input", (e) => { const op = e.target.value / 100; video.style.opacity = op; photo.style.opacity = op; frame.style.opacity = op; $("#opacityVal").textContent = e.target.value + "%"; });

/* ---------------- Tethering (screen / camera / photo / web / demo) ----------------
 * Screen capture (getDisplayMedia) is desktop-only: iOS Safari does not
 * implement it and web pages cannot overlay native iOS apps. So on iPhone/iPad:
 *  - Camera: rear camera becomes the background (point at the game screen).
 *  - Photo: a screenshot from Photos becomes the background for layout.
 *  - Web URL: a web game is embedded in the stage; overlay controls send it keys.
 *  - Demo: the built-in game (always works, everywhere).
 */
let stream = null, videoOn = true, demoOn = true;
let tetherSource = "demo"; // 'screen' | 'camera' | 'photo' | 'web' | 'demo'
const photo = $("#tetherPhoto"), frame = $("#tetherFrame");
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function stopTracks() {
  if (stream) { stream.getTracks().forEach(t => { try { t.stop(); } catch {} }); stream = null; }
  video.srcObject = null;
}
function markMode() {
  $$(".tmode").forEach(b => b.classList.toggle("active", b.dataset.tether === tetherSource));
  $("#webRow").classList.toggle("hidden", tetherSource !== "web");
}
function setBadge(name) {
  if (!name) { $("#tetherBadge").classList.add("hidden"); $("#btnStopTether").classList.add("hidden"); return; }
  $("#tetherName").textContent = name;
  $("#tetherBadge").classList.remove("hidden");
  $("#btnStopTether").classList.remove("hidden");
}
async function tetherScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    const msg = IS_IOS
      ? "iOS Safari does not support window capture. On iPhone/iPad use Camera, Photo, or Web URL mode instead."
      : "Screen capture is not available in this browser. Try Chrome/Edge on desktop, or use Camera / Photo / Web URL mode.";
    log(`⚠ ${esc(msg)}`);
    alert(msg + " The demo game still works for testing controls.");
    return;
  }
  try {
    stopTracks();
    // NOTE: getDisplayMedia must be called from a user gesture — it is (button click).
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const track = stream.getVideoTracks()[0];
    photo.classList.add("hidden"); frame.classList.add("hidden"); frame.src = "about:blank";
    video.srcObject = stream;
    await video.play().catch(() => {});
    tetherSource = "screen";
    const name = track?.label?.replace(/^window:|^screen:/i, "").slice(0, 42) || "selected app";
    setBadge(name);
    $("#tetherStatus").innerHTML = `Status: <b>🔗 tethered (screen)</b> — ${esc(name)}`;
    placeholder.style.display = "none";
    markMode(); updateBg();
    log(`🔗 tethered to <b>${esc(name)}</b> — controls now float over it.`);
    track.onended = () => tetherDemo("Screen share ended.");
  } catch (err) {
    if (err?.name !== "NotAllowedError") log(`⚠ tether cancelled/failed: <span class="dim">${esc(err?.message || err)}</span>`);
  }
}
async function tetherCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) { log("⚠ Camera not supported in this browser."); alert("Camera (getUserMedia) is not available here. Try Safari/Chrome on iOS, or Chrome/Edge on desktop (HTTPS required)."); return; }
    stopTracks();
    // Rear camera by default; falls back gracefully on devices with one camera.
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    photo.classList.add("hidden"); frame.classList.add("hidden"); frame.src = "about:blank";
    video.srcObject = stream;
    await video.play().catch(() => {});
    tetherSource = "camera";
    setBadge(IS_IOS ? "iPhone camera" : "camera");
    $("#tetherStatus").innerHTML = `Status: <b>🔗 tethered (camera)</b> — point at the game screen. Controls float over the live feed.`;
    placeholder.style.display = "none";
    markMode(); updateBg();
    log(`📷 camera tether live — point at the game screen.`);
    stream.getVideoTracks()[0].onended = () => tetherDemo("Camera ended.");
  } catch (err) {
    log(`⚠ camera failed: <span class="dim">${esc(err?.message || err)}</span> — needs HTTPS + camera permission.`);
  }
}
function tetherPhotoPick() { $("#filePhoto").click(); }
$("#filePhoto").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  stopTracks();
  const url = URL.createObjectURL(f);
  frame.classList.add("hidden"); frame.src = "about:blank";
  video.classList.add("hidden");
  photo.src = url;
  photo.classList.remove("hidden");
  tetherSource = "photo";
  setBadge("screenshot");
  $("#tetherStatus").innerHTML = `Status: <b>🖼️ photo background</b> — ${esc(f.name.slice(0, 40))}. Lay out controls over it.`;
  placeholder.style.display = "none";
  markMode(); updateBg();
  log(`🖼️ photo loaded — lay out controls over the screenshot.`);
  e.target.value = "";
});
function tetherWeb(url) {
  url = (url || "").trim();
  if (!url) { $("#webRow").classList.remove("hidden"); $("#webUrl").focus(); return; }
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  stopTracks();
  photo.classList.add("hidden"); video.classList.add("hidden");
  frame.src = url;
  frame.classList.remove("hidden");
  tetherSource = "web";
  let host = url;
  try { host = new URL(url).host; } catch {}
  setBadge(host);
  $("#tetherStatus").innerHTML = `Status: <b>🌐 web game</b> — ${esc(host)}. Click the game once to focus it, then use overlay controls.`;
  placeholder.style.display = "none";
  markMode(); updateBg();
  log(`🌐 embedded <b>${esc(host)}</b> — click it to focus, then controls send keys to it. Note: some sites block embedding (X-Frame-Options).`);
}
function tetherDemo(note) {
  stopTracks();
  photo.classList.add("hidden"); frame.classList.add("hidden"); frame.src = "about:blank";
  tetherSource = "demo";
  setBadge(null);
  $("#tetherStatus").innerHTML = `Status: <b>untethered</b> — demo-game background active.`;
  placeholder.style.display = "";
  markMode(); updateBg();
  if (note) log(`⏹ ${esc(note)} Back to demo.`);
  else log("⏹ untethered — back to demo.");
}
function updateBg() {
  const has = tetherSource !== "demo";
  const showLayer = has && videoOn;
  video.classList.toggle("hidden", !(tetherSource === "screen" || tetherSource === "camera") || !showLayer);
  photo.classList.toggle("hidden", tetherSource !== "photo" || !showLayer);
  frame.classList.toggle("hidden", tetherSource !== "web" || !showLayer);
  demoCanvas.style.opacity = has && showLayer ? "0.25" : "1";
  // Placeholder only matters when nothing is tethered
  if (tetherSource === "demo") placeholder.style.display = "";
  else if (showLayer) placeholder.style.display = "none";
  const op = ($("#rngOpacity").value || 100) / 100;
  video.style.opacity = op; photo.style.opacity = op; frame.style.opacity = op;
}
$$(".tmode").forEach(b => b.addEventListener("click", () => {
  const m = b.dataset.tether;
  if (m === "screen") tetherScreen();
  else if (m === "camera") tetherCamera();
  else if (m === "photo") tetherPhotoPick();
  else if (m === "web") { tetherSource === "web" ? $("#webRow").classList.toggle("hidden") : tetherWeb($("#webUrl").value); markMode(); }
  else tetherDemo();
}));
$("#btnWebGo").addEventListener("click", () => tetherWeb($("#webUrl").value));
$("#webUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") tetherWeb(e.target.value); e.stopPropagation(); });
const tether = tetherScreen, untether = tetherDemo; // compat aliases
$("#btnTether").addEventListener("click", () => {
  // On iOS the Screen picker can never work — route to the iOS-friendly choice.
  if (IS_IOS) { log("📱 iOS: window capture unavailable — opening Camera tether. (Photo / Web URL also work.)"); tetherCamera(); }
  else tetherScreen();
});
$("#btnTether2").addEventListener("click", tetherScreen);
$("#btnStopTether").addEventListener("click", () => tetherDemo());

/* ---------------- Demo game (proves controls work in-game) ---------------- */
const ctx = demoCanvas.getContext("2d");
const player = { x: 480, y: 300, r: 16, vx: 0, vy: 0 };
let shots = [], targets = [], score = 0, last = performance.now(), spawnT = 0;
function resetTargets() {
  targets = [];
  for (let i = 0; i < 5; i++) targets.push({ x: 80 + Math.random() * 800, y: 70 + Math.random() * 380, r: 14 + Math.random() * 10, hp: 1 });
}
resetTargets();
demoCanvas.addEventListener("pointerdown", () => demoCanvas.focus?.());
function shoot() {
  const a = Math.atan2(joyVec.x, -joyVec.y);
  const ang = (joyVec.x || joyVec.y) ? a : -Math.PI / 2;
  shots.push({ x: player.x, y: player.y, vx: Math.sin(ang) * 520, vy: -Math.cos(ang) * 520, life: 1.2 });
  log(`● <b>SHOOT</b> <span class="dim">from demo game</span>`);
}
let spaceHeld = false;
setInterval(() => { // edge-trigger Space like a game would
  if (pressed.has("Space") && !spaceHeld) { spaceHeld = true; if (demoOn) shoot(); }
  if (!pressed.has("Space")) spaceHeld = false;
}, 30);

function gameStep(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const L = pressed.has("KeyA") || pressed.has("ArrowLeft");
  const R = pressed.has("KeyD") || pressed.has("ArrowRight");
  const U = pressed.has("KeyW") || pressed.has("ArrowUp");
  const D = pressed.has("KeyS") || pressed.has("ArrowDown");
  const ax = (R ? 1 : 0) - (L ? 1 : 0), ay = (D ? 1 : 0) - (U ? 1 : 0);
  player.vx = player.vx * 0.86 + ax * 620 * dt * 8 * 0.14;
  player.vy = player.vy * 0.86 + ay * 620 * dt * 8 * 0.14;
  player.x = clamp(player.x + player.vx * dt, 20, 940);
  player.y = clamp(player.y + player.vy * dt, 20, 520);
  shots = shots.filter(s => (s.life -= dt) > 0).map(s => ({ ...s, x: s.x + s.vx * dt, y: s.y + s.vy * dt }));
  for (const s of shots) for (const t of targets) {
    if (Math.hypot(s.x - t.x, s.y - t.y) < t.r + 4) { t.hp = 0; s.life = 0; score += 100; log(`💥 hit! score <b>${score}</b>`); }
  }
  targets = targets.filter(t => t.hp > 0);
  spawnT += dt;
  if (targets.length < 3 || spawnT > 6) { spawnT = 0; targets.push({ x: 80 + Math.random() * 800, y: 70 + Math.random() * 380, r: 14 + Math.random() * 10, hp: 1 }); }

  // draw
  ctx.clearRect(0, 0, 960, 540);
  const g = ctx.createLinearGradient(0, 0, 0, 540);
  g.addColorStop(0, "#0c1430"); g.addColorStop(1, "#070b1c");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 960, 540);
  ctx.strokeStyle = "rgba(139,150,179,.15)";
  for (let x = 0; x < 960; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 540); ctx.stroke(); }
  for (let y = 0; y < 540; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(960, y); ctx.stroke(); }
  ctx.fillStyle = "#e8edf7"; ctx.font = "700 20px system-ui";
  ctx.fillText(`SCORE ${score}`, 18, 32);
  ctx.font = "500 13px system-ui"; ctx.fillStyle = "#8b96b3";
  ctx.fillText(demoOn ? "Demo game LIVE — joystick/WASD moves • A/Space shoots" : "Demo game paused", 18, 52);
  for (const t of targets) {
    ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7);
    ctx.fillStyle = "rgba(248,113,113,.25)"; ctx.fill();
    ctx.strokeStyle = "#f87171"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fecaca"; ctx.font = "700 13px system-ui"; ctx.textAlign = "center";
    ctx.fillText("HIT", t.x, t.y + 4); ctx.textAlign = "start";
  }
  for (const s of shots) { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, 7); ctx.fillStyle = "#22d3ee"; ctx.fill(); }
  // player ship
  ctx.save(); ctx.translate(player.x, player.y);
  const ang = Math.atan2(player.vx, -player.vy) || 0;
  ctx.rotate(ang * 0.15);
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(12, 12); ctx.lineTo(0, 6); ctx.lineTo(-12, 12); ctx.closePath();
  ctx.fillStyle = "#22d3ee"; ctx.fill(); ctx.strokeStyle = "#a5f3fc"; ctx.stroke();
  ctx.restore();
  if (!demoOn) { ctx.fillStyle = "rgba(5,7,15,.55)"; ctx.fillRect(0, 0, 960, 540); }
  requestAnimationFrame(gameStep);
}

/* ---------------- misc ---------------- */
function log(html) {
  const d = document.createElement("div");
  const t = new Date().toLocaleTimeString([], { hour12: false });
  d.innerHTML = `<span class="dim">${t}</span> ${html}`;
  logEl.prepend(d);
  while (logEl.children.length > 60) logEl.lastChild.remove();
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });

/* ---------------- boot ---------------- */
controls = load();
render();
setMode("play");
if (IS_IOS) {
  $("#iosNotice").classList.remove("hidden");
  const scr = document.querySelector('[data-tether="screen"]');
  if (scr) { scr.style.opacity = ".45"; scr.title = "Unavailable on iOS — use Camera / Photo / Web URL"; }
}
markMode(); updateBg();
requestAnimationFrame((t) => { last = t; gameStep(t); });
log("✅ TouchTether ready. Press the joystick / buttons — the demo ship moves and keys fire.");
})();
