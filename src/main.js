"use strict";

/* ============================================================
 * mdEditor - main frontend logic
 * ============================================================ */

if (!window.__TAURI__) {
  document.body.innerHTML = '<div style="padding:40px;font-size:16px">Tauri 환경에서만 실행할 수 있습니다.</div>';
  throw new Error("not in tauri");
}

const { invoke, convertFileSrc } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const webview = window.__TAURI__.webview.getCurrentWebview();

/* ---------------- state ---------------- */

const state = {
  roots: [],            // [{path, name, isDir}]
  files: new Map(),     // path -> {path,name,type,content,savedContent,segs,mtimeMs,prompting}
  panes: [],            // [{id, tabs:[path], active, el, tabbarEl, findbarEl, editorEl, dropHintEl, shadowBody, scrollTops:Map, find:{...}}]
  activePane: 0,
  splitRatio: 0.5,
  fontSize: 15,
  dark: true,
  forceClose: false,
};

/* ---------------- dom helpers ---------------- */

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ---------------- settings ---------------- */

function saveSettings() {
  try {
    localStorage.setItem("mde-settings", JSON.stringify({
      roots: state.roots.map((r) => r.path),
      dark: state.dark,
      fontSize: state.fontSize,
      sidebarWidth: $("#sidebar").style.width || "",
    }));
  } catch (_) {}
}

async function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("mde-settings") || "null"); } catch (_) {}
  if (!s) return;
  if (typeof s.dark === "boolean") state.dark = s.dark;
  if (s.fontSize) state.fontSize = s.fontSize;
  if (s.sidebarWidth) $("#sidebar").style.width = s.sidebarWidth;
  if (Array.isArray(s.roots)) {
    for (const p of s.roots) {
      try {
        const st = await invoke("stat_path", { path: p });
        if (st.exists) state.roots.push({ path: p, name: basename(p), isDir: st.is_dir });
      } catch (_) {}
    }
  }
}

/* ---------------- path utils ---------------- */

function basename(p) {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i === -1 ? s : s.slice(i + 1);
}
function dirname(p) {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i === -1 ? s : s.slice(0, i);
}
function resolvePath(dir, rel) {
  let r = rel.replace(/\//g, "\\");
  try { r = decodeURIComponent(r); } catch (_) {}
  if (/^[a-zA-Z]:\\/.test(r) || r.startsWith("\\\\")) return r;
  const parts = dir.split("\\").filter(Boolean);
  for (const seg of r.split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  let out = parts.join("\\");
  if (/^[a-zA-Z]:$/.test(parts[0])) {} else if (dir.startsWith("\\\\")) out = "\\\\" + out;
  return out;
}
function fileType(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  return "txt";
}

/* ---------------- toast / modal ---------------- */

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

let modalChain = Promise.resolve();
function showModal({ message, buttons }) {
  const run = () => new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = "";
    const card = el("div", "modal-card");
    card.appendChild(el("div", "modal-msg", message));
    const btns = el("div", "modal-buttons");
    for (const b of buttons) {
      const btn = el("button", b.kind === "primary" ? "primary" : "", b.label);
      btn.addEventListener("click", () => {
        root.hidden = true;
        root.innerHTML = "";
        resolve(b.value);
      });
      btns.appendChild(btn);
    }
    card.appendChild(btns);
    root.appendChild(card);
    root.hidden = false;
    const first = btns.querySelector("button.primary") || btns.querySelector("button");
    if (first) first.focus();
  });
  const p = modalChain.then(run);
  modalChain = p.catch(() => {});
  return p;
}

/* ---------------- sidebar tree ---------------- */

function renderTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const root of state.roots) {
    tree.appendChild(treeNode(root, 0, true));
  }
}

function treeNode(entry, depth, isRoot) {
  const wrap = el("div", "tree-node");
  const row = el("div", "tree-row");
  row.style.paddingLeft = 6 + depth * 14 + "px";
  row.title = entry.path;

  const chev = el("span", "tree-chevron", entry.isDir ? "▸" : "");
  const icon = el("span", "tree-icon", entry.isDir ? "\u{1F4C1}" : "\u{1F4C4}");
  const name = el("span", "tree-name", entry.name);
  row.append(chev, icon, name);

  if (isRoot) {
    const rm = el("button", "tree-remove", "✕");
    rm.title = "목록에서 제거";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      state.roots = state.roots.filter((r) => r.path !== entry.path);
      saveSettings();
      renderTree();
    });
    row.appendChild(rm);
  }

  let childrenEl = null;
  row.addEventListener("click", async () => {
    if (entry.isDir) {
      if (childrenEl) {
        childrenEl.remove();
        childrenEl = null;
        chev.textContent = "▸";
        return;
      }
      chev.textContent = "▾";
      childrenEl = el("div", "tree-children");
      try {
        const list = await invoke("list_dir", { path: entry.path });
        for (const c of list) {
          childrenEl.appendChild(treeNode({ path: c.path, name: c.name, isDir: c.is_dir }, depth + 1, false));
        }
        if (!list.length) {
          const empty = el("div", "tree-row", "(비어 있음)");
          empty.style.paddingLeft = 6 + (depth + 1) * 14 + "px";
          empty.style.color = "var(--fg-dim)";
          childrenEl.appendChild(empty);
        }
      } catch (err) {
        toast("폴더를 읽을 수 없습니다: " + err);
      }
      wrap.appendChild(childrenEl);
    } else {
      openFile(entry.path);
    }
  });

  wrap.appendChild(row);
  return wrap;
}

async function addRoot(path) {
  if (state.roots.some((r) => r.path === path)) return false;
  const st = await invoke("stat_path", { path });
  if (!st.exists) return false;
  state.roots.push({ path, name: basename(path), isDir: st.is_dir });
  saveSettings();
  renderTree();
  return st.is_dir;
}

/* ---------------- panes ---------------- */

function makePane() {
  return {
    id: 0, // reassigned on split (0 or 1)
    tabs: [],
    active: null,
    el: null, tabbarEl: null, findbarEl: null, editorEl: null, dropHintEl: null,
    htmlDoc: null,
    scrollTops: new Map(),
    find: { open: false, replace: false, query: "", ranges: [], idx: 0, pos: 0 },
  };
}

function activePaneObj() {
  return state.panes[Math.min(state.activePane, state.panes.length - 1)];
}
function activeFile(pane) {
  pane = pane || activePaneObj();
  return pane && pane.active ? state.files.get(pane.active) : null;
}

function buildPanes() {
  const area = $("#editor-area");
  area.innerHTML = "";
  state.panes.forEach((pane, i) => {
    if (i > 0) {
      const div = el("div", "pane-divider");
      attachDividerDrag(div);
      area.appendChild(div);
    }
    const pe = el("div", "pane");
    pe.dataset.pane = i;
    pe.style.flex = state.panes.length === 1 ? "1 1 0" :
      (i === 0 ? `${state.splitRatio} 1 0` : `${1 - state.splitRatio} 1 0`);

    const tabbar = el("div", "tabbar");
    const findbar = buildFindbar(pane);
    const editor = el("div", "editor");
    const dropHint = el("div", "drop-hint");

    pe.append(tabbar, findbar, editor, dropHint);
    area.appendChild(pe);

    pane.el = pe; pane.tabbarEl = tabbar; pane.findbarEl = findbar;
    pane.editorEl = editor; pane.dropHintEl = dropHint;

    pe.addEventListener("mousedown", () => setActivePane(i), true);

    renderTabs(pane);
    renderEditor(pane);
    updateFindbarVisibility(pane);
  });
  markActivePane();
}

function setActivePane(i) {
  if (state.activePane === i) return;
  state.activePane = Math.min(i, state.panes.length - 1);
  markActivePane();
  updateTitle();
}

function markActivePane() {
  state.panes.forEach((p, i) => {
    p.el.classList.toggle("active-pane", i === state.activePane && state.panes.length > 1);
  });
}

function paneIndex(pane) {
  return state.panes.indexOf(pane);
}

function removePaneIfEmpty(pane) {
  if (pane.tabs.length === 0 && state.panes.length > 1) {
    clearFindHighlights(pane);
    state.panes = state.panes.filter((p) => p !== pane);
    state.activePane = 0;
    buildPanes();
  }
}

function attachDividerDrag(div) {
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("mde-dragging");
    const area = $("#editor-area");
    const rect = area.getBoundingClientRect();
    const move = (ev) => {
      let r = (ev.clientX - rect.left) / rect.width;
      r = Math.max(0.15, Math.min(0.85, r));
      state.splitRatio = r;
      if (state.panes[0]) state.panes[0].el.style.flex = `${r} 1 0`;
      if (state.panes[1]) state.panes[1].el.style.flex = `${1 - r} 1 0`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("mde-dragging");
      saveSession();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ---------------- tabs ---------------- */

function renderTabs(pane) {
  const bar = pane.tabbarEl;
  bar.innerHTML = "";
  for (const path of pane.tabs) {
    const file = state.files.get(path);
    if (!file) continue;
    const tab = el("div", "tab" + (pane.active === path ? " active" : ""));
    tab.dataset.path = path;
    tab.title = path;

    if (file.dirty) tab.appendChild(el("span", "tab-dirty", "●"));
    tab.appendChild(el("span", "tab-name", file.name));
    const close = el("span", "tab-close", "✕");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(pane, path);
    });
    tab.appendChild(close);

    tab.addEventListener("click", () => {
      if (suppressClick) return;
      activateTab(pane, path);
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(pane, path); }
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabContextMenu(e, pane, path);
    });
    attachTabPointerDrag(tab, pane, path);
    bar.appendChild(tab);
  }
}

function renderAllTabs() {
  state.panes.forEach(renderTabs);
}

function activateTab(pane, path) {
  commitBlockEdit();
  if (pane.active === path) { setActivePane(paneIndex(pane)); return; }
  storeScroll(pane);
  pane.active = path;
  setActivePane(paneIndex(pane));
  renderTabs(pane);
  renderEditor(pane);
  updateTitle();
}

function storeScroll(pane) {
  if (!pane.active || !pane.editorEl) return;
  let v = pane.editorEl.scrollTop;
  if (pane.htmlDoc) {
    try { v = pane.htmlDoc.documentElement.scrollTop || pane.htmlDoc.body.scrollTop; } catch (_) {}
  }
  pane.scrollTops.set(pane.active, v);
}

async function loadFileEntry(path) {
  if (state.files.has(path)) return true;
  let content;
  try {
    const st = await invoke("stat_path", { path });
    if (!st.exists || st.is_dir) return false;
    content = await invoke("read_text", { path });
    state.files.set(path, {
      path,
      name: basename(path),
      type: fileType(path),
      content,
      savedContent: content,
      segs: null,
      mtimeMs: st.mtime_ms,
      prompting: false,
      rawMode: false,
      rawSnapshot: null,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function openFile(path) {
  // already open somewhere -> focus it
  for (const pane of state.panes) {
    if (pane.tabs.includes(path)) {
      activateTab(pane, path);
      return;
    }
  }
  if (!(await loadFileEntry(path))) {
    toast("파일을 열 수 없습니다: " + path);
    return;
  }
  const pane = activePaneObj();
  pane.tabs.push(path);
  pane.active = path;
  renderTabs(pane);
  renderEditor(pane);
  updateTitle();
}

function fileIsDirty(file) {
  return file.content !== file.savedContent;
}

function updateDirtyUI() {
  for (const f of state.files.values()) f.dirty = fileIsDirty(f);
  renderAllTabs();
  updateTitle();
}

async function closeTab(pane, path, opts = {}) {
  commitBlockEdit();
  const file = state.files.get(path);
  if (file && fileIsDirty(file) && !opts.skipConfirm) {
    const v = await showModal({
      message: `'${file.name}' 파일에 저장하지 않은 변경 사항이 있습니다.`,
      buttons: [
        { label: "저장 후 닫기", value: "save", kind: "primary" },
        { label: "저장 안 함", value: "discard" },
        { label: "취소", value: "cancel" },
      ],
    });
    if (v === "cancel") return false;
    if (v === "save") await saveFile(file);
  }
  const idx = pane.tabs.indexOf(path);
  if (idx === -1) return true;
  pane.tabs.splice(idx, 1);
  pane.scrollTops.delete(path);
  if (pane.active === path) {
    pane.active = pane.tabs[Math.min(idx, pane.tabs.length - 1)] || null;
  }
  // drop file from memory if no pane has it
  if (!state.panes.some((p) => p.tabs.includes(path))) state.files.delete(path);
  if (pane.tabs.length === 0 && state.panes.length > 1) {
    removePaneIfEmpty(pane);
  } else {
    renderTabs(pane);
    renderEditor(pane);
  }
  updateTitle();
  return true;
}

async function closeMany(pane, paths) {
  for (const p of [...paths]) {
    const ok = await closeTab(pane, p);
    if (ok === false) return;
  }
}

/* ---------------- tab context menu ---------------- */

function showTabContextMenu(e, pane, path) {
  const idx = pane.tabs.indexOf(path);
  const left = pane.tabs.slice(0, idx);
  const right = pane.tabs.slice(idx + 1);
  const others = pane.tabs.filter((p) => p !== path);
  const other = state.panes.find((p) => p !== pane);
  showContextMenu(e.clientX, e.clientY, [
    { label: "닫기", fn: () => closeTab(pane, path) },
    {
      label: other ? (paneIndex(pane) === 0 ? "오른쪽 분할로 이동" : "왼쪽 분할로 이동") : "오른쪽 분할로 열기",
      fn: () => { if (other) moveTabToPane(pane, other, path); else splitWithTab(pane, path); },
    },
    { sep: true },
    { label: "왼쪽 전체 닫기", disabled: !left.length, fn: () => closeMany(pane, left) },
    { label: "오른쪽 전체 닫기", disabled: !right.length, fn: () => closeMany(pane, right) },
    { label: "이 파일 제외 전체 닫기", disabled: !others.length, fn: () => closeMany(pane, others) },
    { sep: true },
    { label: "전체 닫기", fn: () => closeMany(pane, pane.tabs) },
  ]);
}

function showContextMenu(x, y, items) {
  const menu = $("#ctxmenu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) { menu.appendChild(el("div", "ctx-sep")); continue; }
    const item = el("div", "ctx-item" + (it.disabled ? " disabled" : ""), it.label);
    item.addEventListener("click", () => {
      hideContextMenu();
      it.fn();
    });
    menu.appendChild(item);
  }
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + "px";
}
function hideContextMenu() { $("#ctxmenu").hidden = true; }
window.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctxmenu")) hideContextMenu();
});

/* ---------------- tab drag & split ----------------
 * Pointer-based drag (native HTML5 DnD is unavailable while Tauri's
 * OS file drag-drop interception is enabled). */

let tabDrag = null;
let suppressClick = false;

function hideAllDropHints() {
  state.panes.forEach((p) => { if (p.dropHintEl) p.dropHintEl.style.display = "none"; });
}

function hitTestDrop(x, y) {
  for (const pane of state.panes) {
    const tb = pane.tabbarEl.getBoundingClientRect();
    if (x >= tb.left && x <= tb.right && y >= tb.top && y <= tb.bottom) {
      let insertIdx = pane.tabs.length;
      const under = document.elementFromPoint(x, y);
      const t = under && under.closest && under.closest(".tab");
      if (t) {
        const i = pane.tabs.indexOf(t.dataset.path);
        if (i !== -1) insertIdx = i;
      }
      return { type: "tabbar", pane, insertIdx };
    }
    const r = pane.editorEl.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const rel = (x - r.left) / r.width;
      if (state.panes.length === 1 && rel > 0.5) return { type: "split", pane };
      return { type: "pane", pane };
    }
  }
  return null;
}

function updateDropHints(x, y) {
  hideAllDropHints();
  const drop = hitTestDrop(x, y);
  if (!drop || drop.type === "tabbar") return;
  const pane = drop.pane;
  const r = pane.editorEl.getBoundingClientRect();
  const pr = pane.el.getBoundingClientRect();
  const hint = pane.dropHintEl;
  hint.style.top = r.top - pr.top + "px";
  hint.style.height = r.height + "px";
  if (drop.type === "split") {
    hint.style.left = "50%"; hint.style.width = "50%";
  } else {
    hint.style.left = "0"; hint.style.width = "100%";
  }
  hint.style.display = "block";
}

function attachTabPointerDrag(tab, pane, path) {
  tab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".tab-close")) return;
    const sx = e.clientX, sy = e.clientY;
    let dragging = false;
    let ghost = null;
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        dragging = true;
        tabDrag = { path, from: pane };
        document.body.classList.add("mde-dragging");
        const file = state.files.get(path);
        ghost = el("div", "tab-ghost", file ? file.name : "");
        document.body.appendChild(ghost);
      }
      if (dragging) {
        ghost.style.left = ev.clientX + 10 + "px";
        ghost.style.top = ev.clientY + 12 + "px";
        updateDropHints(ev.clientX, ev.clientY);
      }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("mde-dragging");
      if (!dragging) return;
      if (ghost) ghost.remove();
      hideAllDropHints();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      const drag = tabDrag;
      tabDrag = null;
      const drop = hitTestDrop(ev.clientX, ev.clientY);
      if (!drop || !drag) return;
      if (drop.type === "split") {
        splitWithTab(drag.from, drag.path);
      } else if (drop.type === "tabbar") {
        moveTabToPane(drag.from, drop.pane, drag.path, drop.insertIdx);
      } else if (drop.type === "pane" && drop.pane !== drag.from) {
        moveTabToPane(drag.from, drop.pane, drag.path);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function toggleSplit() {
  commitBlockEdit();
  if (state.panes.length === 1) {
    const p0 = state.panes[0];
    storeScroll(p0);
    const pane = makePane();
    pane.id = 1;
    if (p0.active) { pane.tabs = [p0.active]; pane.active = p0.active; }
    state.panes.push(pane);
    state.activePane = 1;
  } else {
    const [p0, p1] = state.panes;
    storeScroll(p0); storeScroll(p1);
    clearFindHighlights(p1);
    for (const t of p1.tabs) if (!p0.tabs.includes(t)) p0.tabs.push(t);
    if (!p0.active) p0.active = p1.active;
    state.panes = [p0];
    state.activePane = 0;
  }
  buildPanes();
  updateTitle();
}

function moveTabToPane(from, to, path, insertIdx) {
  commitBlockEdit();
  if (from === to) {
    const cur = from.tabs.indexOf(path);
    if (cur === -1) return;
    from.tabs.splice(cur, 1);
    if (insertIdx === undefined) insertIdx = from.tabs.length;
    from.tabs.splice(Math.min(insertIdx, from.tabs.length), 0, path);
    renderTabs(from);
    return;
  }
  const cur = from.tabs.indexOf(path);
  if (cur === -1) return;
  if (to.tabs.includes(path)) {
    // already there: just remove from source & activate
    from.tabs.splice(cur, 1);
  } else {
    from.tabs.splice(cur, 1);
    to.tabs.splice(insertIdx === undefined ? to.tabs.length : insertIdx, 0, path);
  }
  if (from.active === path) from.active = from.tabs[Math.min(cur, from.tabs.length - 1)] || null;
  to.active = path;
  state.activePane = paneIndex(to);
  if (from.tabs.length === 0 && state.panes.length > 1) {
    removePaneIfEmpty(from); // rebuilds everything
  } else {
    renderTabs(from); renderEditor(from);
    renderTabs(to); renderEditor(to);
    markActivePane();
  }
  updateTitle();
}

function splitWithTab(from, path) {
  if (state.panes.length >= 2) return;
  commitBlockEdit();
  storeScroll(from);
  const cur = from.tabs.indexOf(path);
  if (cur === -1) return;
  if (from.tabs.length > 1) {
    from.tabs.splice(cur, 1);
    if (from.active === path) from.active = from.tabs[Math.min(cur, from.tabs.length - 1)] || null;
  }
  // if it was the only tab, keep it on the left too (duplicate view)

  const pane = makePane();
  pane.id = 1;
  pane.tabs = [path];
  pane.active = path;
  state.panes.push(pane);
  state.activePane = 1;
  buildPanes();
  updateTitle();
}

/* ---------------- editor rendering ---------------- */

function renderEditor(pane) {
  clearFindHighlights(pane);
  pane.htmlDoc = null;
  const ed = pane.editorEl;
  ed.onmousedown = null;
  ed.innerHTML = "";
  const file = activeFile(pane);
  if (!file) {
    const ph = el("div", "editor-placeholder");
    ph.appendChild(el("div", "", "파일을 열거나 왼쪽 목록에서 선택하세요"));
    ph.appendChild(el("div", "", "Ctrl+S 저장 · Ctrl+F 찾기 · Ctrl+R 바꾸기"));
    ed.appendChild(ph);
    return;
  }
  pane._htmlFinishEdit = null;
  pane._txtArea = null;
  if (file.rawMode || file.type === "txt") renderTextEditor(pane, file);
  else if (file.type === "md") renderMarkdownEditor(pane, file);
  else if (file.type === "html") renderHtmlEditor(pane, file);

  const st = pane.scrollTops.get(file.path);
  if (st !== undefined) ed.scrollTop = st;
  if (pane.find.open && pane.find.query) runFind(pane);
  updateRawButtons();
}

/* ---------------- whole-document text mode ---------------- */

function updateRawButtons() {
  const file = activeFile();
  const raw = $("#btn-raw"), cancel = $("#btn-raw-cancel");
  raw.disabled = !file;
  raw.classList.toggle("toggled", !!(file && file.rawMode));
  cancel.disabled = !(file && file.rawMode);
}

function toggleRaw() {
  const pane = activePaneObj();
  const file = activeFile(pane);
  if (!file) return;
  commitBlockEdit();
  commitHtmlEdit(pane);
  if (!file.rawMode) {
    file.rawMode = true;
    file.rawSnapshot = file.content;
  } else {
    // leave text mode, keeping the edits
    file.rawMode = false;
    file.rawSnapshot = null;
    file.segs = null;
  }
  rerenderFile(file.path, null);
  updateRawButtons();
}

function cancelRaw() {
  const file = activeFile();
  if (!file || !file.rawMode) return;
  file.rawMode = false;
  const snap = file.rawSnapshot;
  file.rawSnapshot = null;
  if (snap !== null && snap !== file.content) {
    setFileContent(file, snap); // revert + rerender
  } else {
    file.segs = null;
    rerenderFile(file.path, null);
    updateDirtyUI();
  }
  updateRawButtons();
}

function rerenderFile(path, exceptPane) {
  for (const pane of state.panes) {
    if (pane !== exceptPane && pane.active === path) {
      storeScroll(pane);
      renderEditor(pane);
    }
  }
}

function setFileContent(file, text, exceptPane) {
  file.content = text;
  file.segs = file.type === "md" ? splitSegments(text) : null;
  rerenderFile(file.path, exceptPane);
  updateDirtyUI();
}

/* ---------------- markdown block editor ---------------- */

function splitSegments(src) {
  const lines = src.split("\n");
  const segs = [];
  let cur = null;
  let fence = null;
  const push = (type) => { cur = { type, lines: [] }; segs.push(cur); };

  // YAML frontmatter: '---' on the very first line until a closing '---'/'...'
  let start = 0;
  if (lines.length > 1 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        segs.push({ type: "block", fm: true, lines: lines.slice(0, i + 1) });
        start = i + 1;
        break;
      }
    }
  }

  for (const line of lines.slice(start)) {
    const fm = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      cur.lines.push(line);
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      continue;
    }
    if (line.trim() === "") {
      if (!cur || cur.type !== "gap") push("gap");
      cur.lines.push(line);
    } else {
      if (!cur || cur.type !== "block") push("block");
      if (fm) fence = fm[1];
      cur.lines.push(line);
    }
  }
  return segs;
}

function joinSegments(segs) {
  return segs.flatMap((s) => s.lines).join("\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// render YAML frontmatter as a key/value table
function renderFrontmatter(lines) {
  const inner = lines.slice(1, lines.length - 1); // strip --- fences
  const rows = []; // [key, value]
  for (const line of inner) {
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.\- ]*):\s?(.*)$/);
    if (m) {
      rows.push([m[1], m[2]]);
    } else if (rows.length) {
      // continuation / nested line: append to previous value
      rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? "\n" : "") + line.replace(/^\s{2}/, "");
    } else if (line.trim()) {
      rows.push(["", line]);
    }
  }
  if (!rows.length) return marked.parse(lines.join("\n"));
  const tr = rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("");
  return `<table class="md-frontmatter"><tbody>${tr}</tbody></table>`;
}

let blockEdit = null; // {pane, file, segIdx, ta, blockEl, original, cancelled}

function renderMarkdownEditor(pane, file) {
  if (!file.segs) file.segs = splitSegments(file.content);
  const ed = pane.editorEl;
  const doc = el("div", "md-doc");
  file.segs.forEach((seg, idx) => {
    if (seg.type !== "block") return;
    doc.appendChild(makeBlockEl(pane, file, seg, idx));
  });
  if (!file.segs.some((s) => s.type === "block")) {
    const hint = el("div", "editor-placeholder", "빈 문서입니다. 클릭하여 입력을 시작하세요.");
    hint.style.height = "200px";
    doc.appendChild(hint);
  }
  ed.appendChild(doc);
  // click on empty area below content -> append new block
  // (assignment, not addEventListener: renderEditor reuses the element)
  ed.onmousedown = (e) => {
    if (e.target === ed || e.target === doc || e.target.classList.contains("editor-placeholder")) {
      e.preventDefault();
      addBlockAtEnd(pane, file);
    }
  };
}

function makeBlockEl(pane, file, seg, idx) {
  const div = el("div", "md-block");
  div.dataset.idx = idx;
  if (seg.fm) div.innerHTML = renderFrontmatter(seg.lines);
  else div.innerHTML = marked.parse(seg.lines.join("\n"));
  fixImages(div, file.path, false);
  div.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a) e.preventDefault();
    if (blockEdit && blockEdit.blockEl === div) return;
    beginBlockEdit(pane, file, idx, div);
  });
  return div;
}

function beginBlockEdit(pane, file, segIdx, blockEl) {
  commitBlockEdit();
  const seg = file.segs[segIdx];
  if (!seg) return;
  const original = seg.lines.join("\n");
  const wrap = el("div", "md-block editing");
  const ta = el("textarea", "md-edit");
  ta.value = original;
  ta.spellcheck = false;
  wrap.appendChild(ta);
  blockEl.replaceWith(wrap);
  blockEdit = { pane, file, segIdx, ta, blockEl: wrap, original, cancelled: false };
  autoGrow(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      blockEdit.cancelled = true;
      ta.blur();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ta.blur();
    }
  });
  ta.addEventListener("blur", () => commitBlockEdit());
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + 4 + "px";
}

function commitBlockEdit() {
  if (!blockEdit) return;
  const { pane, file, segIdx, ta, original, cancelled } = blockEdit;
  const be = blockEdit;
  blockEdit = null;
  const newText = cancelled ? original : ta.value;
  const seg = file.segs[segIdx];
  if (!seg) return;
  if (newText.trim() === "") {
    file.segs.splice(segIdx, 1);
  } else {
    seg.lines = newText.split("\n");
  }
  const joined = joinSegments(file.segs);
  storeScroll(pane);
  setFileContent(file, joined);
}

function addBlockAtEnd(pane, file) {
  commitBlockEdit();
  if (!file.segs) file.segs = splitSegments(file.content);
  const hasBlock = file.segs.some((s) => s.type === "block");
  if (!hasBlock) {
    file.segs = [{ type: "block", lines: [""] }];
  } else {
    const last = file.segs[file.segs.length - 1];
    if (last.type !== "gap") file.segs.push({ type: "gap", lines: [""] });
    file.segs.push({ type: "block", lines: [""] });
  }
  const segIdx = file.segs.length - 1;
  // render a placeholder block element then edit it
  storeScroll(pane);
  renderEditorKeepScroll(pane);
  const doc = pane.editorEl.querySelector(".md-doc");
  const blockEl = doc && doc.querySelector(`.md-block[data-idx="${segIdx}"]`);
  if (blockEl) {
    beginBlockEdit(pane, file, segIdx, blockEl);
    pane.editorEl.scrollTop = pane.editorEl.scrollHeight;
  }
}

function renderEditorKeepScroll(pane) {
  const st = pane.editorEl.scrollTop;
  renderEditor(pane);
  pane.editorEl.scrollTop = st;
}

/* ---------------- image path fixing ---------------- */

function fixImages(container, filePath, keepOriginalAttr) {
  const dir = dirname(filePath);
  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src || /^([a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(src) || src.startsWith("data:")) return;
    if (keepOriginalAttr) img.setAttribute("data-mde-src", src);
    try { img.src = convertFileSrc(resolvePath(dir, src)); } catch (_) {}
  });
}

/* ---------------- html wysiwyg editor ---------------- */

const HTML_FRAME_CSS = `
  .mde-html-edit {
    border: 1px solid #0078d4; border-radius: 4px; margin: 4px 0; background: #f6f8fa;
  }
  .mde-html-edit textarea {
    display: block; width: 100%; border: none; outline: none; resize: none;
    background: transparent; color: #1f1f1f;
    font-family: Consolas, "D2Coding", monospace; font-size: 13px; line-height: 1.5;
    padding: 8px; box-sizing: border-box;
  }
  ::highlight(mde-find-0), ::highlight(mde-find-1) { background-color:#f7c948; color:#1f1f1f; }
  ::highlight(mde-findcur-0), ::highlight(mde-findcur-1) { background-color:#ff8c00; color:#000; }
`;

function extractHtmlParts(content) {
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : content;
  const styles = [...content.matchAll(/<style[\s\S]*?<\/style>/gi)].map((m) => m[0]).join("\n");
  return { body, styles, hasBodyTag: !!bodyMatch };
}

function spliceHtmlBody(orig, newBody) {
  const m = orig.match(/(<body[^>]*>)([\s\S]*)(<\/body>)/i);
  if (m) {
    const start = m.index + m[1].length;
    return orig.slice(0, start) + newBody + orig.slice(start + m[2].length);
  }
  return newBody;
}

// asset-protocol URL for a directory, with real '/' separators so that
// relative URLs in the document resolve correctly against it
function assetDirUrl(dir) {
  const probe = convertFileSrc("__mde__");
  const origin = probe.slice(0, probe.indexOf("__mde__"));
  const path = encodeURI(dir.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return origin + path + "/";
}

// build srcdoc: original document + <base> for relative urls + editor styles
function buildHtmlSrcdoc(content, filePath) {
  let baseHref = "";
  try { baseHref = assetDirUrl(dirname(filePath)); } catch (_) {}
  const extras = `<base href="${baseHref}"><style data-mde-internal>${HTML_FRAME_CSS}</style>`;
  const headMatch = content.match(/<head[^>]*>/i);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return content.slice(0, at) + extras + content.slice(at);
  }
  return extras + content;
}

function renderHtmlEditor(pane, file) {
  const ed = pane.editorEl;
  const iframe = document.createElement("iframe");
  iframe.className = "html-frame";
  // no allow-scripts: page JS must not run, but we can still edit the DOM
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.srcdoc = buildHtmlSrcdoc(file.content, file.path);
  ed.appendChild(iframe);
  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return;
    pane.htmlDoc = doc;
    attachHtmlEditing(pane, file, doc);
    doc.addEventListener("keydown", handleGlobalKeys, true);
    doc.addEventListener("mousedown", () => setActivePane(paneIndex(pane)), true);
    const st = pane.scrollTops.get(file.path);
    if (st !== undefined) doc.documentElement.scrollTop = st;
    if (pane.find.open && pane.find.query) runFind(pane);
  });
}

function attachHtmlEditing(pane, file, doc) {
  const container = doc.body;

  // click an element -> edit its raw HTML in a textarea (like md blocks)
  let editing = null; // {wrapper, ta, original}

  const syncContent = () => {
    const newBody = container.innerHTML;
    const { body: oldBody } = extractHtmlParts(file.content);
    if (newBody !== oldBody) {
      file.content = spliceHtmlBody(file.content, newBody);
      rerenderFile(file.path, pane);
      updateDirtyUI();
    }
  };

  const finishEdit = (cancelled) => {
    if (!editing) return;
    const { wrapper, ta, original } = editing;
    editing = null;
    if (cancelled) {
      wrapper.outerHTML = original;
    } else {
      const html = ta.value;
      if (html.trim()) wrapper.outerHTML = html;
      else wrapper.remove();
    }
    syncContent();
  };

  const beginEdit = (target) => {
    if (editing) finishEdit(false);
    const original = target.outerHTML;
    const wrapper = doc.createElement("div");
    wrapper.className = "mde-html-edit";
    const ta = doc.createElement("textarea");
    ta.value = original;
    ta.spellcheck = false;
    wrapper.appendChild(ta);
    target.replaceWith(wrapper);
    editing = { wrapper, ta, original };
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finishEdit(true); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishEdit(false); }
    });
    ta.addEventListener("blur", () => {
      setTimeout(() => { if (editing && editing.ta === ta) finishEdit(false); }, 0);
    });
  };

  doc.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest(".mde-html-edit")) return;
    if (e.target.closest && e.target.closest("a")) e.preventDefault();
    const PREFER = new Set(["P","H1","H2","H3","H4","H5","H6","LI","BLOCKQUOTE","PRE","TD","TH","DT","DD","FIGCAPTION","CAPTION","SUMMARY","BUTTON","LABEL","IMG","A","TABLE","UL","OL"]);
    let target = null;
    let last = null;
    for (let n = e.target; n && n !== container && n.nodeType === 1; n = n.parentElement) {
      if (!target && PREFER.has(n.tagName)) target = n;
      last = n;
    }
    if (!target) target = last && last.parentElement === container ? last : null;
    if (!target) return;
    e.preventDefault();
    beginEdit(target);
  });

  pane._htmlFinishEdit = finishEdit;
}

function commitHtmlEdit(pane) {
  if (pane && pane._htmlFinishEdit) pane._htmlFinishEdit(false);
}

/* ---------------- plain text editor ---------------- */

function renderTextEditor(pane, file) {
  const ta = el("textarea", "txt-edit");
  ta.value = file.content;
  ta.spellcheck = false;
  ta.addEventListener("input", () => {
    file.content = ta.value;
    file.segs = null;
    // sync other pane showing same file
    for (const p of state.panes) {
      if (p !== pane && p.active === file.path) {
        const other = p.editorEl.querySelector(".txt-edit");
        if (other && other !== document.activeElement) other.value = ta.value;
      }
    }
    updateDirtyUI();
  });
  pane.editorEl.appendChild(ta);
  pane._txtArea = ta;
}

/* ---------------- save ---------------- */

async function saveFile(file) {
  try {
    await invoke("write_text", { path: file.path, content: file.content });
  } catch (err) {
    toast("저장 실패: " + err);
    return;
  }
  file.savedContent = file.content;
  const st = await invoke("stat_path", { path: file.path });
  file.mtimeMs = st.mtime_ms;
  updateDirtyUI();
  toast("저장됨: " + file.name);
}

async function saveActive() {
  commitBlockEdit();
  commitHtmlEdit(activePaneObj());
  const file = activeFile();
  if (file) await saveFile(file);
}

/* ---------------- external change detection ---------------- */

setInterval(async () => {
  for (const file of [...state.files.values()]) {
    if (file.prompting) continue;
    let st;
    try { st = await invoke("stat_path", { path: file.path }); } catch (_) { continue; }
    if (!st.exists || st.mtime_ms <= file.mtimeMs) continue;
    file.prompting = true;
    try {
      const v = await showModal({
        message: `'${file.name}' 파일이 외부에서 수정되었습니다.\n다시 로드할까요?` +
          (fileIsDirty(file) ? "\n(다시 로드하면 저장하지 않은 변경 사항이 사라집니다)" : ""),
        buttons: [
          { label: "다시 로드", value: "reload", kind: "primary" },
          { label: "무시", value: "ignore" },
        ],
      });
      const st2 = await invoke("stat_path", { path: file.path });
      file.mtimeMs = st2.mtime_ms;
      if (v === "reload") {
        const text = await invoke("read_text", { path: file.path });
        file.content = text;
        file.savedContent = text;
        file.segs = null;
        if (blockEdit && blockEdit.file === file) blockEdit = null;
        rerenderFile(file.path, null);
        updateDirtyUI();
      }
    } finally {
      file.prompting = false;
    }
  }
}, 2000);

/* ---------------- find / replace ---------------- */

function buildFindbar(pane) {
  const bar = el("div", "findbar");
  bar.hidden = true;

  const input = el("input");
  input.placeholder = "찾기";
  const count = el("span", "find-count", "0/0");
  const prev = el("button", "", "▲");
  prev.title = "이전 (Shift+Enter)";
  const next = el("button", "", "▼");
  next.title = "다음 (Enter)";

  const replaceRow = el("div", "replace-row");
  const rInput = el("input");
  rInput.placeholder = "바꾸기";
  const rOne = el("button", "", "바꾸기");
  const rAll = el("button", "", "모두 바꾸기");
  replaceRow.append(rInput, rOne, rAll);

  const close = el("button", "", "✕");
  close.title = "닫기 (Esc)";

  bar.append(input, count, prev, next, replaceRow, close);

  pane._find = { bar, input, count, replaceRow, rInput };

  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      pane.find.query = input.value;
      pane.find.idx = 0;
      pane.find.pos = 0;
      runFind(pane);
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); navFind(pane, e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(pane); }
  });
  rInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); replaceOne(pane); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(pane); }
  });
  prev.addEventListener("click", () => navFind(pane, -1));
  next.addEventListener("click", () => navFind(pane, 1));
  rOne.addEventListener("click", () => replaceOne(pane));
  rAll.addEventListener("click", () => replaceAll(pane));
  close.addEventListener("click", () => closeFind(pane));

  return bar;
}

function updateFindbarVisibility(pane) {
  pane.findbarEl.hidden = !pane.find.open;
  if (pane._find) pane._find.replaceRow.style.display = pane.find.replace ? "flex" : "none";
}

function openFind(pane, withReplace) {
  commitBlockEdit();
  pane.find.open = true;
  pane.find.replace = withReplace;
  updateFindbarVisibility(pane);
  const f = pane._find;
  f.input.focus();
  f.input.select();
  if (f.input.value) { pane.find.query = f.input.value; runFind(pane); }
}

function closeFind(pane) {
  pane.find.open = false;
  pane.find.query = "";
  clearFindHighlights(pane);
  updateFindbarVisibility(pane);
  if (pane._find) pane._find.count.textContent = "0/0";
}

function clearFindHighlights(pane) {
  for (const win of [window, pane._hlWin]) {
    try {
      if (win && win.CSS && win.CSS.highlights) {
        win.CSS.highlights.delete(`mde-find-${pane.id}`);
        win.CSS.highlights.delete(`mde-findcur-${pane.id}`);
      }
    } catch (_) {}
  }
  pane._hlWin = null;
  pane.find.ranges = [];
}

function findSearchRoot(pane) {
  const file = activeFile(pane);
  if (!file || file.rawMode || file.type === "txt") return null; // textarea path
  if (file.type === "html") return pane.htmlDoc ? pane.htmlDoc.body : null;
  return pane.editorEl.querySelector(".md-doc");
}

function collectRanges(root, query) {
  const out = [];
  const q = query.toLowerCase();
  if (!q) return out;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const p = node.parentElement;
    if (p && /^(STYLE|SCRIPT|TEXTAREA)$/.test(p.tagName)) continue;
    const text = node.data.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(q, i)) !== -1) {
      const r = doc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      out.push(r);
      i += q.length;
    }
  }
  return out;
}

function runFind(pane) {
  clearFindHighlights(pane);
  const q = pane.find.query;
  const f = pane._find;
  const file = activeFile(pane);
  if (!q || !file) { f.count.textContent = "0/0"; return; }

  if (file.type === "txt" || file.rawMode) {
    const matches = countOccurrences(file.content, q);
    f.count.textContent = matches ? `${Math.min(pane.find.idx + 1, matches)}/${matches}` : "0/0";
    return;
  }

  const root = findSearchRoot(pane);
  if (!root) { f.count.textContent = "0/0"; return; }
  const ranges = collectRanges(root, q);
  pane.find.ranges = ranges;
  if (pane.find.idx >= ranges.length) pane.find.idx = 0;
  applyFindHighlights(pane);
  f.count.textContent = ranges.length ? `${pane.find.idx + 1}/${ranges.length}` : "0/0";
}

function applyFindHighlights(pane) {
  const { ranges, idx } = pane.find;
  if (!ranges.length) return;
  const win = ranges[0].startContainer.ownerDocument.defaultView || window;
  if (!(win.CSS && win.CSS.highlights && win.Highlight)) return;
  pane._hlWin = win;
  const others = ranges.filter((_, i) => i !== idx);
  win.CSS.highlights.set(`mde-find-${pane.id}`, new win.Highlight(...(others.length ? others : [])));
  win.CSS.highlights.set(`mde-findcur-${pane.id}`, new win.Highlight(ranges[idx]));
}

function navFind(pane, dir) {
  const file = activeFile(pane);
  if (!file) return;
  const q = pane.find.query;
  if (!q) return;

  if (file.type === "txt" || file.rawMode) {
    navFindTextarea(pane, file, dir);
    return;
  }
  const n = pane.find.ranges.length;
  if (!n) return;
  pane.find.idx = (pane.find.idx + dir + n) % n;
  applyFindHighlights(pane);
  pane._find.count.textContent = `${pane.find.idx + 1}/${n}`;
  const r = pane.find.ranges[pane.find.idx];
  const elx = r.startContainer.parentElement;
  if (elx) elx.scrollIntoView({ block: "center" });
}

function countOccurrences(text, q) {
  let c = 0, i = 0;
  const t = text.toLowerCase(), ql = q.toLowerCase();
  while ((i = t.indexOf(ql, i)) !== -1) { c++; i += ql.length; }
  return c;
}

function navFindTextarea(pane, file, dir) {
  const ta = pane._txtArea;
  if (!ta) return;
  const t = ta.value.toLowerCase();
  const q = pane.find.query.toLowerCase();
  const total = countOccurrences(ta.value, q);
  if (!total) { pane._find.count.textContent = "0/0"; return; }
  let from = dir > 0 ? ta.selectionEnd : ta.selectionStart - 1;
  let idx;
  if (dir > 0) {
    idx = t.indexOf(q, from);
    if (idx === -1) idx = t.indexOf(q);
  } else {
    idx = t.lastIndexOf(q, Math.max(0, from - 1));
    if (idx === -1) idx = t.lastIndexOf(q);
  }
  if (idx === -1) return;
  ta.focus();
  ta.setSelectionRange(idx, idx + q.length);
  const lineNo = ta.value.slice(0, idx).split("\n").length - 1;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, lineNo * lh - ta.clientHeight / 2);
  const cur = countOccurrences(ta.value.slice(0, idx), q) + 1;
  pane._find.count.textContent = `${cur}/${total}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOne(pane) {
  commitBlockEdit();
  const file = activeFile(pane);
  const q = pane._find.input.value;
  const rep = pane._find.rInput.value;
  if (!file || !q) return;
  const lower = file.content.toLowerCase();
  let idx = lower.indexOf(q.toLowerCase(), pane.find.pos);
  if (idx === -1) {
    idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) { toast("일치하는 항목이 없습니다"); return; }
  }
  const newContent = file.content.slice(0, idx) + rep + file.content.slice(idx + q.length);
  pane.find.pos = idx + rep.length;
  setFileContent(file, newContent);
  pane.find.query = q;
  runFind(pane);
}

function replaceAll(pane) {
  commitBlockEdit();
  const file = activeFile(pane);
  const q = pane._find.input.value;
  const rep = pane._find.rInput.value;
  if (!file || !q) return;
  const re = new RegExp(escapeRegExp(q), "gi");
  const count = (file.content.match(re) || []).length;
  if (!count) { toast("일치하는 항목이 없습니다"); return; }
  setFileContent(file, file.content.replace(re, rep));
  pane.find.pos = 0;
  runFind(pane);
  toast(`${count}개 항목을 바꿨습니다`);
}

/* ---------------- title ---------------- */

function updateTitle() {
  const file = activeFile();
  const t = file ? `${file.dirty ? "● " : ""}${file.name} - mdEditor` : "mdEditor";
  appWindow.setTitle(t).catch(() => {});
  updateRawButtons();
  saveSession();
}

/* ---------------- session (open tabs) persistence ---------------- */

function saveSession() {
  try {
    localStorage.setItem("mde-session", JSON.stringify({
      panes: state.panes.map((p) => ({ tabs: p.tabs, active: p.active })),
      activePane: state.activePane,
      splitRatio: state.splitRatio,
    }));
  } catch (_) {}
}

async function restoreSession() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("mde-session") || "null"); } catch (_) {}
  if (!s || !Array.isArray(s.panes) || !s.panes.length) return false;
  if (typeof s.splitRatio === "number") state.splitRatio = s.splitRatio;
  const panes = [];
  for (const ps of s.panes.slice(0, 2)) {
    const pane = makePane();
    for (const path of ps.tabs || []) {
      if (await loadFileEntry(path)) pane.tabs.push(path);
    }
    pane.active = ps.active && pane.tabs.includes(ps.active) ? ps.active : pane.tabs[0] || null;
    panes.push(pane);
  }
  const finalPanes = panes.filter((p, i) => i === 0 || p.tabs.length > 0);
  finalPanes.forEach((p, i) => { p.id = i; });
  state.panes = finalPanes;
  state.activePane = Math.min(s.activePane || 0, finalPanes.length - 1);
  return true;
}

/* ---------------- theme / font ---------------- */

function applyTheme() {
  document.body.classList.toggle("dark", state.dark);
  $("#btn-theme").textContent = state.dark ? "☀️" : "\u{1F319}";
}

function applyFontSize() {
  document.documentElement.style.setProperty("--editor-font", state.fontSize + "px");
  $("#font-size-label").textContent = state.fontSize + "px";
}

/* ---------------- shortcuts ---------------- */

function handleGlobalKeys(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === "s") {
    e.preventDefault();
    saveActive();
  } else if (mod && key === "f") {
    e.preventDefault();
    openFind(activePaneObj(), false);
  } else if (mod && key === "r") {
    e.preventDefault();
    openFind(activePaneObj(), true);
  } else if (mod && key === "w") {
    e.preventDefault();
    const pane = activePaneObj();
    if (pane && pane.active) closeTab(pane, pane.active);
  } else if (e.key === "F5") {
    e.preventDefault();
  } else if (e.key === "Escape") {
    hideContextMenu();
  }
}
window.addEventListener("keydown", handleGlobalKeys, true);

/* ---------------- OS file drag & drop ---------------- */

webview.onDragDropEvent(async (event) => {
  const ev = event.payload;
  const overlay = $("#drop-overlay");
  if (ev.type === "enter" || ev.type === "over") {
    if (!tabDrag) overlay.hidden = false;
  } else if (ev.type === "leave") {
    overlay.hidden = true;
  } else if (ev.type === "drop") {
    overlay.hidden = true;
    const paths = ev.paths || [];
    for (const p of paths) {
      const st = await invoke("stat_path", { path: p });
      if (!st.exists) continue;
      if (st.is_dir) {
        await addRoot(p);
      } else {
        // show the file's containing folder in the explorer, then open the file
        await addRoot(dirname(p));
        await openFile(p);
      }
    }
  }
});

/* ---------------- sidebar resize ---------------- */

$("#sidebar-resizer").addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.body.classList.add("mde-dragging");
  const move = (ev) => {
    const w = Math.max(120, Math.min(500, ev.clientX));
    $("#sidebar").style.width = w + "px";
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.classList.remove("mde-dragging");
    saveSettings();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

/* ---------------- toolbar ---------------- */

async function dialogOpen(opts) {
  if (window.__TAURI__.dialog && window.__TAURI__.dialog.open) {
    return window.__TAURI__.dialog.open(opts);
  }
  return invoke("plugin:dialog|open", { options: opts });
}

async function dialogSave(opts) {
  if (window.__TAURI__.dialog && window.__TAURI__.dialog.save) {
    return window.__TAURI__.dialog.save(opts);
  }
  return invoke("plugin:dialog|save", { options: opts });
}

$("#btn-new-file").addEventListener("click", async () => {
  const sel = await dialogSave({
    title: "새 파일 만들기",
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "HTML", extensions: ["html"] },
      { name: "텍스트", extensions: ["txt"] },
    ],
  });
  if (!sel) return;
  let p = sel;
  if (!/\.[^\\/]+$/.test(p)) p += ".md";
  try {
    await invoke("write_text", { path: p, content: "" });
  } catch (err) {
    toast("파일을 만들 수 없습니다: " + err);
    return;
  }
  await addRoot(dirname(p));
  await openFile(p);
});

$("#btn-open-folder").addEventListener("click", async () => {
  const sel = await dialogOpen({ directory: true, multiple: false, title: "폴더 열기" });
  if (sel) await addRoot(sel);
});

$("#btn-open-file").addEventListener("click", async () => {
  const sel = await dialogOpen({
    directory: false, multiple: true, title: "파일 열기",
    filters: [
      { name: "문서", extensions: ["md", "markdown", "html", "htm", "txt"] },
      { name: "모든 파일", extensions: ["*"] },
    ],
  });
  if (!sel) return;
  const arr = Array.isArray(sel) ? sel : [sel];
  for (const p of arr) {
    await addRoot(dirname(p));
    await openFile(p);
  }
});

$("#btn-font-dec").addEventListener("click", () => {
  state.fontSize = Math.max(10, state.fontSize - 1);
  applyFontSize(); saveSettings();
});
$("#btn-font-inc").addEventListener("click", () => {
  state.fontSize = Math.min(28, state.fontSize + 1);
  applyFontSize(); saveSettings();
});
$("#btn-theme").addEventListener("click", () => {
  state.dark = !state.dark;
  applyTheme(); saveSettings();
});
$("#btn-split").addEventListener("click", () => toggleSplit());
$("#btn-raw").addEventListener("click", () => toggleRaw());
$("#btn-raw-cancel").addEventListener("click", () => cancelRaw());

/* ---------------- window close confirm ---------------- */

appWindow.onCloseRequested((event) => {
  if (state.forceClose) return;
  commitBlockEdit();
  const dirtyFiles = [...state.files.values()].filter(fileIsDirty);
  if (!dirtyFiles.length) return;
  event.preventDefault();
  (async () => {
    const v = await showModal({
      message: `저장하지 않은 파일이 ${dirtyFiles.length}개 있습니다.\n` +
        dirtyFiles.map((f) => "  ● " + f.name).join("\n"),
      buttons: [
        { label: "모두 저장 후 종료", value: "save", kind: "primary" },
        { label: "저장 안 함", value: "discard" },
        { label: "취소", value: "cancel" },
      ],
    });
    if (v === "cancel") return;
    if (v === "save") {
      for (const f of dirtyFiles) await saveFile(f);
    }
    state.forceClose = true;
    appWindow.destroy().catch(() => appWindow.close());
  })();
});

/* ---------------- init ---------------- */

(async function init() {
  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });
  }
  await loadSettings();
  applyTheme();
  applyFontSize();
  renderTree();
  // restore previous tabs / split layout
  const restored = await restoreSession();
  if (!restored) {
    state.panes = [makePane()];
    state.panes[0].id = 0;
    state.activePane = 0;
  }
  buildPanes();
  updateTitle();

  // open files passed on the command line (e.g. mdEditor.exe note.md)
  try {
    const args = await invoke("get_args");
    for (const a of args) {
      const st = await invoke("stat_path", { path: a });
      if (!st.exists) continue;
      if (st.is_dir) await addRoot(a);
      else { await addRoot(dirname(a)); await openFile(a); }
    }
  } catch (_) {}
})();
