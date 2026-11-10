import './style.css';
import { parseSchema, FORMATS } from './parse.js';
import { layout } from './layout.js';
import { Diagram } from './diagram.js';
import { exportSVG } from './svg-export.js';
import { createSearchBox } from './search.js';
import { serialize, SERIALIZERS } from './formats/serialize.js';
import { applyEdit, addColumn, deleteColumn, toggleConstraint, addTable, deleteTable } from './edit.js';
import { createVisualEditor } from './visual-editor.js';
import { DIALECTS, DEFAULT_DIALECT } from './dialects.js';
import { highlightSQL } from './highlight.js';
import { encodeShare, decodeShare } from './share.js';
import { sanitizeAnnotations, groupColor } from './annotations.js';
import { EXAMPLE_SQL } from './examples.js';
import { createStore, hashText } from './store.js';

const $ = (id) => document.getElementById(id);
const sqlEl = $('sql');
const canvas = $('canvas');
const statusEl = $('status');
const emptyEl = $('empty');
const zoomLabel = $('zoom-reset');

const hlEl = $('hl');

const diagram = new Diagram(canvas);
diagram.onZoom = (s) => { zoomLabel.textContent = Math.round(s * 100) + '%'; };
window.__dbdiga = diagram;   // debug handle
let visualEditor = null;     // created after setup; refreshed on every model change

// read-only embed view (?embed=1) — never editable, no matter the input format
const isEmbed = new URLSearchParams(location.search).has('embed');

// ---- syntax highlight layer (painted behind the transparent textarea) ----
let hlQueued = false;
function syncHighlight() {
  // coalesce to one repaint per frame so fast typing never blocks
  if (hlQueued) return;
  hlQueued = true;
  requestAnimationFrame(() => {
    hlQueued = false;
    hlEl.innerHTML = highlightSQL(sqlEl.value);
    hlEl.parentElement.scrollTop = sqlEl.scrollTop;
    hlEl.parentElement.scrollLeft = sqlEl.scrollLeft;
  });
}
sqlEl.addEventListener('scroll', () => {
  hlEl.parentElement.scrollTop = sqlEl.scrollTop;
  hlEl.parentElement.scrollLeft = sqlEl.scrollLeft;
});

// ---- layout persistence (table positions + camera) ----
const LAYOUT_KEY = 'dbdiga-layout';
// My diagrams: several named diagrams in this browser. The open one keeps
// living in the working keys above (dbdiga-sql / dbdiga-layout / …), so the
// diagram that was open before this feature becomes the first in the list.
const store = createStore();

function collectLayout() {
  const positions = {};
  for (const t of diagram.model.tables) {
    if (Number.isFinite(t.x)) positions[t.key] = { x: Math.round(t.x), y: Math.round(t.y) };
  }
  return {
    positions,
    camera: { x: Math.round(diagram.cam.x), y: Math.round(diagram.cam.y), scale: +diagram.cam.scale.toFixed(4) },
    annotations: diagram.annotations.map(a => ({ ...a })),
    hidden: [...diagram.hidden],
    manualLinks: diagram.manualLinks.map(l => ({ from: { ...l.from }, to: { ...l.to } })),
    edgeBends: { ...diagram.edgeBends },
    edgeAnchors: { ...diagram.edgeAnchors },
    edgePaths: { ...diagram.edgePaths },
  };
}
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(collectLayout())); } catch { /* quota */ }
  recordHistory();
  // keep the diagram list's table count and "last changed" order fresh
  if (!isEmbed) store.touch({ tables: diagram.model.tables.length, hash: hashText(sqlEl.value) });
}

// ---- undo / redo: every saved change is a step; the camera is not part of it ----
const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let applyingHistory = false;

function historyState() {
  const { camera, ...layout } = collectLayout();
  return { sql: sqlEl.value, layout: JSON.stringify(layout) };
}
function recordHistory() {
  if (applyingHistory) return;
  const state = historyState();
  const last = undoStack.at(-1);
  if (last && last.sql === state.sql && last.layout === state.layout) return;
  undoStack.push(state);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}
function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveLayout();
}
function applyHistoryState(state) {
  const layout = JSON.parse(state.layout);
  applyingHistory = true;
  try {
    if (state.sql !== sqlEl.value) {
      sqlEl.value = state.sql;
      rebuild({ restore: { ...layout, camera: { ...diagram.cam } } });
    } else {
      for (const t of diagram.model.tables) {
        const p = layout.positions[t.key];
        if (p) { t.x = p.x; t.y = p.y; }
      }
      diagram.setHidden(layout.hidden);
      diagram.setManualLinks(layout.manualLinks);
      diagram.setEdgeBends(layout.edgeBends);
      diagram.setEdgeAnchors(layout.edgeAnchors);
      diagram.setEdgePaths(layout.edgePaths);
      diagram.setAnnotations(sanitizeAnnotations(layout.annotations));
      diagram._tmapDirty = true;
      diagram.markDirty();
      renderTables();
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    saveLayout();
  } finally {
    applyingHistory = false;
  }
}
function undo() {
  flushPendingSave();
  if (undoStack.length < 2) return false;
  redoStack.push(undoStack.pop());
  applyHistoryState(undoStack.at(-1));
  return true;
}
function redo() {
  flushPendingSave();
  const state = redoStack.pop();
  if (!state) return false;
  undoStack.push(state);
  applyHistoryState(state);
  return true;
}
// Straight lines re-routed after a move arrive a moment later; they belong to
// the move's undo step, so one Ctrl+Z undoes both.
function amendLastHistory() {
  if (applyingHistory) return;
  flushPendingSave();                                    // the move is recorded first
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(collectLayout())); } catch { /* quota */ }
  const state = historyState();
  if (undoStack.length) undoStack[undoStack.length - 1] = state;
  else undoStack.push(state);
}
let saveTimer = null;
function saveLayoutDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveLayout(); }, 400);
}
function loadSavedLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
// apply saved positions onto a freshly-parsed model; returns true if any matched
function applyLayoutData(model, data) {
  if (!data || !data.positions) return false;
  let placed = 0;
  for (const t of model.tables) {
    const p = data.positions[t.key];
    if (p && Number.isFinite(p.x)) { t.x = p.x; t.y = p.y; placed++; }
  }
  return placed > 0;
}
// position any tables that have no coordinates yet, beside the existing ones
function placeNewTables(model) {
  const missing = model.tables.filter(t => !Number.isFinite(t.x));
  if (!missing.length) return;
  const placed = model.tables.filter(t => Number.isFinite(t.x));
  if (!placed.length) { layout(model, layoutOpts, diagram.hidden); return; }
  let x1 = -Infinity, y0 = Infinity;
  for (const t of placed) { x1 = Math.max(x1, t.x + t.w); y0 = Math.min(y0, t.y); }
  let x = x1 + 80, y = Number.isFinite(y0) ? y0 : 40;
  for (const t of missing) { t.x = x; t.y = y; y += t.h + 40; }
}

diagram.onLayoutChange = saveLayoutDebounced;
diagram.onLinesRerouted = amendLastHistory;

// theme: restore preference
const savedTheme = localStorage.getItem('dbdiga-theme') || 'dark';
diagram.setTheme(savedTheme);

diagram.start();

// ---- hide tables: right-click context menu + "N hidden" restore chip ----
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.hidden = true;
canvas.parentElement.appendChild(ctxMenu);
const hideCtx = () => { ctxMenu.hidden = true; };

const hiddenChip = document.createElement('button');
hiddenChip.className = 'hidden-chip';
hiddenChip.hidden = true;
hiddenChip.title = 'Show all hidden tables';
hiddenChip.addEventListener('click', () => diagram.showAllHidden());
canvas.parentElement.appendChild(hiddenChip);
function syncHiddenChip() {
  const n = diagram.hiddenCount();
  hiddenChip.hidden = n === 0;
  hiddenChip.textContent = n ? `${n} hidden · Show all` : '';
}
diagram.onHiddenChange = () => { syncHiddenChip(); saveLayoutDebounced(); };

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const t = diagram.tableAt(sx, sy);
  const items = [];
  if (t) {
    const multi = diagram.selected.has(t) && diagram.selected.size > 1;
    items.push({ label: multi ? `Hide ${diagram.selected.size} tables` : 'Hide table', act: () => diagram.hideTable(t) });
    // lines can be hidden behind tables, so a table lists its own manual links
    for (const link of diagram.manualLinksOf(t.key)) {
      items.push({
        label: `Remove link: ${link.from.table}.${link.from.col} → ${link.to.table}.${link.to.col}`,
        act: () => diagram.removeManualLink(link),
      });
    }
  } else {
    const link = diagram.linkAt(sx, sy);
    if (link) items.push({ label: 'Remove link', act: () => diagram.removeManualLink(link) });
  }
  if (diagram.hiddenCount() > 0) items.push({ label: `Show all hidden (${diagram.hiddenCount()})`, act: () => diagram.showAllHidden() });
  if (diagram.manualLinkCount() > 0) {
    items.push({
      label: `Clear all manual links (${diagram.manualLinkCount()})`,
      act: () => {
        if (window.confirm(`Remove all ${diagram.manualLinkCount()} manual links? This can't be undone.`)) diagram.clearManualLinks();
      },
    });
  }
  if (!items.length) { hideCtx(); return; }
  ctxMenu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = it.label;
    b.addEventListener('click', () => { it.act(); hideCtx(); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.hidden = false;
  // a table with many links has a tall menu, so keep it on screen
  ctxMenu.style.left = Math.max(8, Math.min(sx, canvas.clientWidth - ctxMenu.offsetWidth - 8)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(sy, canvas.clientHeight - ctxMenu.offsetHeight - 8)) + 'px';
});
window.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideCtx(); });
window.addEventListener('blur', hideCtx);

// ---- Tables panel: fuzzy search + select/deselect + hide/show ----
const tablesPanel = document.createElement('div');
tablesPanel.className = 'tables-panel';
tablesPanel.hidden = true;
tablesPanel.innerHTML =
  '<div class="tp-head"><input class="tp-search" type="text" placeholder="Search tables…" autocomplete="off" spellcheck="false" />' +
  '<button class="tp-close icon-btn" aria-label="Close">✕</button></div>' +
  '<div class="tp-bar"><span class="tp-meta"></span>' +
  '<span class="tp-actions"><button class="tp-bulk" data-act="hide">Hide all</button>' +
  '<button class="tp-bulk" data-act="show">Show all</button></span></div>' +
  '<div class="tp-list"></div>';
canvas.parentElement.appendChild(tablesPanel);
const tpSearch = tablesPanel.querySelector('.tp-search');
const tpList = tablesPanel.querySelector('.tp-list');
const tpMeta = tablesPanel.querySelector('.tp-meta');
const tpHideAll = tablesPanel.querySelector('.tp-bulk[data-act="hide"]');
const tpShowAll = tablesPanel.querySelector('.tp-bulk[data-act="show"]');
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYEOFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-2.2 3"/><path d="M6.6 6.6A18.5 18.5 0 0 0 1 12s4 7 11 7a10.9 10.9 0 0 0 4-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function fuzzy(q, s) {
  if (!q) return true;
  q = q.toLowerCase(); s = s.toLowerCase();
  if (s.includes(q)) return true;
  let i = 0;
  for (const ch of s) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}
function filteredTables() {
  const q = tpSearch.value.trim();
  return diagram.model.tables.filter((t) => fuzzy(q, t.name));
}
function renderTables() {
  if (tablesPanel.hidden) return;
  const all = diagram.model.tables.slice().sort((a, b) => a.name.localeCompare(b.name));
  const q = tpSearch.value.trim();
  const rows = all.filter((t) => fuzzy(q, t.name));
  tpMeta.textContent = `${rows.length}/${all.length} table${all.length !== 1 ? 's' : ''} · ${diagram.hiddenCount()} hidden`;
  const shownInFilter = rows.filter((t) => !diagram.hidden.has(t.key)).length;
  tpHideAll.disabled = shownInFilter === 0;
  tpShowAll.disabled = rows.length - shownInFilter === 0;
  tpList.innerHTML = '';
  for (const t of rows) {
    const hidden = diagram.hidden.has(t.key);
    const sel = diagram.isSelected(t.key);
    const row = document.createElement('div');
    row.className = 'tp-row' + (hidden ? ' is-hidden' : '') + (sel ? ' is-sel' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'tp-sel'; cb.checked = sel; cb.title = 'Select';
    cb.addEventListener('change', () => diagram.selectByKey(t.key, cb.checked));
    const name = document.createElement('button');
    name.className = 'tp-name'; name.textContent = t.name; name.title = 'Center on ' + t.name;
    name.addEventListener('click', () => diagram.centerOn(t.key));
    const eye = document.createElement('button');
    eye.className = 'tp-hide'; eye.innerHTML = hidden ? EYEOFF : EYE; eye.title = hidden ? 'Show' : 'Hide';
    eye.addEventListener('click', () => diagram.setTableHidden(t.key, !hidden));
    row.append(cb, name, eye);
    tpList.appendChild(row);
  }
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'tp-empty';
    e.textContent = all.length ? 'No matches' : 'No tables yet';
    tpList.appendChild(e);
  }
}
function toggleTablesPanel(show) {
  tablesPanel.hidden = show === undefined ? !tablesPanel.hidden : !show;
  $('btn-tables').classList.toggle('active', !tablesPanel.hidden);
  if (!tablesPanel.hidden) { renderTables(); tpSearch.focus(); }
}
$('btn-tables').addEventListener('click', () => toggleTablesPanel());
tablesPanel.querySelector('.tp-close').addEventListener('click', () => toggleTablesPanel(false));
tpSearch.addEventListener('input', renderTables);
tpHideAll.addEventListener('click', () => diagram.setTablesHidden(filteredTables().map((t) => t.key), true));
tpShowAll.addEventListener('click', () => diagram.setTablesHidden(filteredTables().map((t) => t.key), false));
const _prevHiddenChange = diagram.onHiddenChange;
diagram.onHiddenChange = () => { if (_prevHiddenChange) _prevHiddenChange(); renderTables(); };
diagram.onSelectionChange = renderTables;

let lastModel = null;
let firstRender = true;

// layout options (persisted)
const layoutOpts = {
  dir: localStorage.getItem('dbdiga-dir') || 'LR',
  spacing: localStorage.getItem('dbdiga-spacing') || 'comfortable',
};

// input format: 'auto' detects SQL / Prisma / SQLAlchemy / Sequelize
let formatChoice = localStorage.getItem('dbdiga-format') || 'auto';
if (!FORMATS[formatChoice]) formatChoice = 'auto';

function rebuild({ arrange = false, restore = null } = {}) {
  const sql = sqlEl.value;
  localStorage.setItem('dbdiga-sql', sql);
  syncHighlight();

  let result;
  try {
    result = parseSchema(sql, formatChoice);
  } catch (err) {
    statusEl.textContent = 'Parse error';
    statusEl.className = 'status err';
    console.error(err);
    return;
  }

  diagram.editable = result.editable && !isEmbed;   // only SQL supports edit-back; never in embed
  updateStatus(result, sql);

  const prevKeys = lastModel ? lastModel.tables.map(t => t.key).sort().join('|') : '';
  const newKeys = result.tables.map(t => t.key).sort().join('|');
  const structureChanged = prevKeys !== newKeys;

  // pre-apply restored positions before setModel (it preserves what we set)
  if (restore) applyLayoutData(result, restore);

  diagram.setModel(result);
  // setModel keeps the old position of any table that shares a name with the
  // previous diagram, so put the restored positions back
  if (restore) applyLayoutData(result, restore);
  diagram._tmapDirty = true;

  if (arrange) {
    layout(result, layoutOpts, diagram.hidden);
    diagram.fit();
  } else if (restore) {
    diagram.setHidden(restore.hidden);               // restore hidden tables before placing
    diagram.setManualLinks(restore.manualLinks);     // restore user-drawn / inferred links
    diagram.setEdgeBends(restore.edgeBends);         // restore lines the user has bent
    diagram.setEdgeAnchors(restore.edgeAnchors);     // restore line ends the user has moved
    diagram.setEdgePaths(restore.edgePaths);         // restore straight-arranged lines
    placeNewTables(result);                          // tables not in the saved layout
    diagram.setAnnotations(sanitizeAnnotations(restore.annotations));
    if (restore.camera) diagram.setCamera(restore.camera);
    else diagram.fit();
  } else if (firstRender) {
    layout(result, layoutOpts, diagram.hidden);
    diagram.fit();
  } else if (structureChanged) {
    placeNewTables(result);                          // keep manual layout, place only new tables
  }

  diagram.markDirty();
  lastModel = result;
  firstRender = false;
  saveLayoutDebounced();
  renderTables();
  if (visualEditor) visualEditor.render();
}

function updateStatus(result, sql) {
  const hasTables = result.tables.length > 0;
  emptyEl.style.display = hasTables ? 'none' : 'grid';
  const nT = result.tables.length;
  const nR = result.relations.length;
  if (!hasTables && sql.trim()) {
    statusEl.textContent = result.errors[0] || 'No CREATE TABLE found';
    statusEl.className = 'status warn';
  } else if (hasTables) {
    const fmt = result.format && result.format !== 'sql' ? `${FORMATS[result.format] || result.format} · ` : '';
    statusEl.textContent = `${fmt}${nT} table${nT !== 1 ? 's' : ''} · ${nR} relation${nR !== 1 ? 's' : ''}`;
    statusEl.className = 'status ok';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'status';
  }
}

// ---- shared commit: re-parse edited SQL, preserve positions, refresh views ----
// Every model-mutating edit (canvas or visual panel) funnels through here so the
// textarea, the diagram and the visual panel stay in lockstep.
function commitSql(newSql, { pinKey = null, renameFrom = null, renameTo = null } = {}) {
  sqlEl.value = newSql;
  localStorage.setItem('dbdiga-sql', newSql);
  syncHighlight();
  // remember current positions so the edit doesn't reshuffle the diagram
  const oldPos = new Map(diagram.model.tables.map(t => [t.key, { x: t.x, y: t.y }]));
  const model = parseSchema(newSql, 'sql');
  for (const t of model.tables) {
    let p = oldPos.get(t.key);
    if (!p && renameTo && t.key === renameTo) p = oldPos.get(renameFrom);   // renamed table keeps its spot
    if (p && Number.isFinite(p.x)) { t.x = p.x; t.y = p.y; }
  }
  diagram.setModel(model);          // measures sizes, keeps the positions we set
  placeNewTables(model);            // position any brand-new tables
  if (pinKey) diagram.pinByKey(pinKey);
  diagram.markDirty();
  updateStatus(model, newSql);
  lastModel = model;
  saveLayoutDebounced();
  renderTables();
  if (visualEditor) visualEditor.render();
}

// ---- canvas editing: edit a table/column on the diagram -> rewrite SQL ----
function applyChange(change) {
  const sql = sqlEl.value;
  const fresh = parseSchema(sql, 'sql');   // SQL parser for accurate spans
  const result = applyEdit(sql, fresh, change);
  if (!result) return;
  commitSql(result.sql, { renameFrom: change.tableKey, renameTo: result.newKey });
}
diagram.onEdit = applyChange;

// ---- dialect (drives default column type + type suggestions) ----
let dialect = localStorage.getItem('dbdiga-dialect') || DEFAULT_DIALECT;
if (!DIALECTS[dialect]) dialect = DEFAULT_DIALECT;
diagram.typeSuggestions = DIALECTS[dialect].types;

// ---- add a column with the dialect default; returns its name (or null) ----
function addColumnTo(tableKey) {
  const sql = sqlEl.value;
  const fresh = parseSchema(sql, 'sql');
  const table = fresh.tables.find(t => t.key === tableKey);
  if (!table) return null;
  // pick a unique default name
  const existing = new Set(table.columns.map(c => c.name.toLowerCase()));
  let name = 'new_column', i = 2;
  while (existing.has(name.toLowerCase())) name = `new_column_${i++}`;
  const res = addColumn(sql, fresh, tableKey, name, DIALECTS[dialect].default);
  if (!res) return null;
  commitSql(res.sql, { pinKey: tableKey });
  return name;
}
// on the canvas: add the column, then open it inline for naming
diagram.onAddColumn = (tableKey) => {
  const name = addColumnTo(tableKey);
  if (name) diagram.editColumn(tableKey, name);
};

// debounced live parsing; highlight repaints immediately (rAF-coalesced)
let timer = null;
sqlEl.addEventListener('input', () => {
  syncHighlight();
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(), 180);
});

// ---- buttons ----
function loadExample() {
  sqlEl.value = EXAMPLE_SQL;
  firstRender = true;
  rebuild({ arrange: true });
}
$('btn-example').addEventListener('click', loadExample);
$('btn-example2')?.addEventListener('click', loadExample);

// Arrange button: re-arrange with current opts; the ▾ part toggles the menu.
const arrangeMenu = $('arrange-menu');
function syncMenu() {
  for (const el of arrangeMenu.querySelectorAll('[data-dir]'))
    el.classList.toggle('active', el.dataset.dir === layoutOpts.dir);
  for (const el of arrangeMenu.querySelectorAll('[data-spacing]'))
    el.classList.toggle('active', el.dataset.spacing === layoutOpts.spacing);
}
syncMenu();

// The button only opens and closes the menu. Direction and spacing are settings;
// tables move only when "Arrange tables" is chosen.
$('btn-arrange').addEventListener('click', (e) => {
  e.stopPropagation();
  arrangeMenu.hidden = !arrangeMenu.hidden;
  if (!arrangeMenu.hidden) syncMenu();
});
function arrangeTables() {
  const groups = diagram.annotations.filter((a) => a.type === 'group').length;
  if (groups && !window.confirm(
    `Arranging moves every table and ignores your ${groups} group box${groups === 1 ? '' : 'es'}, so tables will leave them.\n\nYou can undo it with Ctrl+Z. Arrange anyway?`,
  )) return;
  arrangeMenu.hidden = true;
  rebuild({ arrange: true });
}
arrangeMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  if (item.dataset.act === 'arrange') { arrangeTables(); return; }
  if (item.dataset.act === 'arrange-lines-straight') {
    arrangeMenu.hidden = true;
    const button = $('btn-arrange');
    button.textContent = 'Arranging lines…';
    button.disabled = true;
    canvas.style.cursor = 'progress';
    diagram.arrangeLinesStraight()                 // runs in a worker; Ctrl+Z undoes it
      .catch((err) => console.error(err))
      .finally(() => { button.textContent = 'Arrange'; button.disabled = false; canvas.style.cursor = ''; });
    return;
  }
  if (item.dataset.act === 'arrange-lines') {
    arrangeMenu.hidden = true;
    diagram.arrangeAllLines();                     // keeps hand-placed lines; Ctrl+Z undoes it
    return;
  }
  if (item.dataset.dir) {
    layoutOpts.dir = item.dataset.dir;
    localStorage.setItem('dbdiga-dir', layoutOpts.dir);
  }
  if (item.dataset.spacing) {
    layoutOpts.spacing = item.dataset.spacing;
    localStorage.setItem('dbdiga-spacing', layoutOpts.spacing);
  }
  syncMenu();
});
document.addEventListener('click', () => { arrangeMenu.hidden = true; });

$('btn-fit').addEventListener('click', () => diagram.fit());

$('btn-infer').addEventListener('click', () => {
  const n = diagram.inferLinks();
  flashButton($('btn-infer'), n ? `+${n} link${n !== 1 ? 's' : ''}` : 'No links found');
});

// ---- annotation tools (note / group) ----
$('tool-note').addEventListener('click', () => diagram.addAnnotation('note'));
$('tool-group').addEventListener('click', () => diagram.addAnnotation('group'));

// ---- input-format dropdown ----
const formatBtn = $('btn-format');
const formatMenu = $('format-menu');
const dialectWrap = $('dialect-wrap');
for (const [key, label] of Object.entries(FORMATS)) {
  const b = document.createElement('button');
  b.className = 'menu-item';
  b.dataset.format = key;
  b.textContent = label;
  formatMenu.appendChild(b);
}
function syncFormat() {
  formatBtn.textContent = formatChoice === 'auto' ? 'Auto' : FORMATS[formatChoice];
  for (const el of formatMenu.querySelectorAll('[data-format]'))
    el.classList.toggle('active', el.dataset.format === formatChoice);
  // dialect picker only matters for SQL
  const sqlish = formatChoice === 'auto' || formatChoice === 'sql';
  dialectWrap.style.display = sqlish ? '' : 'none';
}
syncFormat();
formatBtn.addEventListener('click', (e) => { e.stopPropagation(); formatMenu.hidden = !formatMenu.hidden; });
formatMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  formatChoice = item.dataset.format;
  localStorage.setItem('dbdiga-format', formatChoice);
  syncFormat();
  formatMenu.hidden = true;
  rebuild({ arrange: true });   // re-parse with the chosen format
});
document.addEventListener('click', () => { formatMenu.hidden = true; });

// ---- dialect dropdown ----
const dialectBtn = $('btn-dialect');
const dialectMenu = $('dialect-menu');
for (const [key, d] of Object.entries(DIALECTS)) {
  const b = document.createElement('button');
  b.className = 'menu-item';
  b.dataset.dialect = key;
  b.dataset.umamiEvent = 'dialect-' + key;
  b.textContent = d.label;
  dialectMenu.appendChild(b);
}
function syncDialect() {
  dialectBtn.textContent = DIALECTS[dialect].label;
  for (const el of dialectMenu.querySelectorAll('[data-dialect]'))
    el.classList.toggle('active', el.dataset.dialect === dialect);
  diagram.typeSuggestions = DIALECTS[dialect].types;
}
syncDialect();
dialectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  dialectMenu.hidden = !dialectMenu.hidden;
});
dialectMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  dialect = item.dataset.dialect;
  localStorage.setItem('dbdiga-dialect', dialect);
  syncDialect();
  dialectMenu.hidden = true;
});
document.addEventListener('click', () => { dialectMenu.hidden = true; });

// ---- hide / show SQL panel (collapse from inside the panel, reopen from the canvas) ----
const layoutEl = $('layout');
function setSqlHidden(hidden) {
  localStorage.setItem('dbdiga-sql-hidden', hidden ? '1' : '0');
  layoutEl.classList.toggle('sql-hidden', hidden);
  diagram.resize();
}
$('btn-collapse-sql').addEventListener('click', () => setSqlHidden(true));
$('btn-open-sql').addEventListener('click', () => setSqlHidden(false));
// default: panel hidden on phones (diagram-first), shown on desktop
const savedSqlHidden = localStorage.getItem('dbdiga-sql-hidden');
setSqlHidden(savedSqlHidden === null ? window.matchMedia('(max-width: 720px)').matches : savedSqlHidden === '1');

// ---- Visual editor: a form-based lens on the same SQL ----
const veActions = {
  rename(kind, tableKey, colName, value) {
    applyChange({ kind: kind === 'table' ? 'table' : 'column-name', tableKey, colName, value });
  },
  setType(tableKey, colName, value) {
    applyChange({ kind: 'column-type', tableKey, colName, value });
  },
  toggleConstraint(tableKey, colName, kind, on) {
    const sql = sqlEl.value;
    const res = toggleConstraint(sql, parseSchema(sql, 'sql'), tableKey, colName, kind, on);
    if (!res) return false;
    commitSql(res.sql, { pinKey: tableKey });
    return true;
  },
  deleteColumn(tableKey, colName) {
    const sql = sqlEl.value;
    const res = deleteColumn(sql, parseSchema(sql, 'sql'), tableKey, colName);
    if (res) commitSql(res.sql, { pinKey: tableKey });
  },
  addColumn(tableKey) { return addColumnTo(tableKey); },
  addTable() {
    const sql = sqlEl.value;
    const existing = new Set(parseSchema(sql, 'sql').tables.map(t => t.key));
    let name = 'new_table', i = 2;
    while (existing.has(name.toLowerCase())) name = `new_table_${i++}`;
    const idType = DIALECTS[dialect].types.find(t => /int|serial|number/i.test(t)) || 'bigint';
    const res = addTable(sql, name, idType);
    if (!res) return null;
    commitSql(res.sql, { pinKey: res.tableKey });
    return { key: res.tableKey, name };
  },
  deleteTable(tableKey) {
    const sql = sqlEl.value;
    const res = deleteTable(sql, parseSchema(sql, 'sql'), tableKey);
    if (res) commitSql(res.sql);
  },
  focusTable(tableKey) { diagram.centerOn(tableKey); diagram.pinByKey(tableKey); },
};
visualEditor = createVisualEditor({
  mount: $('visual-editor'),
  getModel: () => diagram.model,
  getDialect: () => DIALECTS[dialect],
  getEditable: () => diagram.editable,
  getFormatLabel: () => FORMATS[lastModel && lastModel.format] || 'another format',
  actions: veActions,
});

const modeToggle = $('mode-toggle');
const visualPane = $('visual-editor');
let editorMode = localStorage.getItem('dbdiga-mode') || 'code';
function setMode(mode) {
  editorMode = mode === 'visual' ? 'visual' : 'code';
  localStorage.setItem('dbdiga-mode', editorMode);
  layoutEl.classList.toggle('visual-mode', editorMode === 'visual');
  visualPane.hidden = editorMode !== 'visual';
  for (const b of modeToggle.querySelectorAll('.seg-btn'))
    b.classList.toggle('active', b.dataset.mode === editorMode);
  if (editorMode === 'visual') visualEditor.render();
}
modeToggle.addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) setMode(b.dataset.mode);
});
setMode(editorMode);

$('zoom-in').addEventListener('click', () => diagram.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => diagram.zoomBy(0.8));
$('zoom-reset').addEventListener('click', () => diagram.resetZoom());

$('btn-theme').addEventListener('click', () => {
  const next = diagram.themeName === 'dark' ? 'light' : 'dark';
  diagram.setTheme(next);
  localStorage.setItem('dbdiga-theme', next);
});

function download(filename, href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  download(filename, url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Reusable "here's some text — copy or download it" modal (export code, embed snippet).
let _modal = null;
function showCodeModal(title, text, filename, umamiLabel) {
  if (!_modal) {
    _modal = document.createElement('div');
    _modal.className = 'modal';
    _modal.hidden = true;
    _modal.innerHTML =
      '<div class="modal-card">' +
      '<div class="modal-head"><span class="modal-title"></span>' +
      '<button class="modal-close icon-btn" aria-label="Close">✕</button></div>' +
      '<textarea class="modal-text" readonly spellcheck="false"></textarea>' +
      '<div class="modal-actions"><span class="modal-hint"></span>' +
      '<button class="btn ghost modal-dl">Download</button>' +
      '<button class="btn primary modal-copy">Copy</button></div></div>';
    document.body.appendChild(_modal);
    const close = () => { _modal.hidden = true; };
    _modal.querySelector('.modal-close').addEventListener('click', close);
    _modal.addEventListener('click', (e) => { if (e.target === _modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !_modal.hidden) close(); });
  }
  const ta = _modal.querySelector('.modal-text');
  const copyBtn = _modal.querySelector('.modal-copy');
  const dlBtn = _modal.querySelector('.modal-dl');
  _modal.querySelector('.modal-title').textContent = title;
  _modal.querySelector('.modal-hint').textContent = filename ? filename : '';
  ta.value = text;
  copyBtn.textContent = 'Copy';
  if (umamiLabel) copyBtn.setAttribute('data-umami-event', 'copy-' + umamiLabel);
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(ta.value); copyBtn.textContent = 'Copied ✓'; }
    catch { ta.select(); document.execCommand && document.execCommand('copy'); copyBtn.textContent = 'Copied ✓'; }
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  };
  dlBtn.hidden = !filename;
  dlBtn.onclick = () => downloadText(filename, ta.value, 'text/plain');
  _modal.hidden = false;
  ta.focus(); ta.setSelectionRange(0, 0);
}

function exportImage(kind) {
  if (kind === 'png') {
    const url = diagram.exportPNG(2);
    if (url) download('schema.png', url);
  } else {
    const svg = exportSVG(diagram.model, diagram.themeName, diagram.annotations, diagram.hidden, diagram.edgeBends, diagram.edgeAnchors, diagram.edgePaths);
    if (svg) downloadText('schema.svg', svg, 'image/svg+xml');
  }
}

// ---- Export menu (image + code formats) ----
const exportBtn = $('btn-export');
const exportMenu = $('export-menu');
exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; });
exportMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  exportMenu.hidden = true;
  const kind = item.dataset.export;
  if (kind === 'png' || kind === 'svg') { exportImage(kind); return; }
  const s = SERIALIZERS[kind];
  if (!s) return;
  const text = serialize(diagram.model, kind);
  showCodeModal(`Export — ${s.label}`, text, `schema.${s.ext}`, s.label.toLowerCase());
});
document.addEventListener('click', () => { exportMenu.hidden = true; });

// ---- File menu (open / save / embed) ----
const fileBtn = $('btn-file');
const fileMenu = $('file-menu');
fileBtn.addEventListener('click', (e) => { e.stopPropagation(); fileMenu.hidden = !fileMenu.hidden; });
document.addEventListener('click', () => { fileMenu.hidden = true; });

// ---- Save / Open project (SQL + layout + camera + dialect) ----
$('btn-save').addEventListener('click', () => {
  const project = {
    app: 'dbdiga',
    version: 1,
    sql: sqlEl.value,
    dialect,
    ...collectLayout(),
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download('schema.sqltoerdiagram.json', url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- Share link (project encoded in the URL hash; nothing stored server-side) ----
function flashButton(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}
$('btn-share').addEventListener('click', async () => {
  const btn = $('btn-share');
  const project = { app: 'dbdiga', version: 1, sql: sqlEl.value, dialect, ...collectLayout() };
  let payload;
  try { payload = await encodeShare(project); }
  catch (err) { console.error(err); flashButton(btn, 'Failed'); return; }
  const hash = '#s=' + payload;
  history.replaceState(null, '', hash);                 // put it in the address bar too
  const url = location.origin + location.pathname + hash;
  try { await navigator.clipboard.writeText(url); flashButton(btn, 'Link copied ✓'); }
  catch { flashButton(btn, 'Link in URL ↑'); }          // clipboard blocked → it's in the URL
});

// ---- Embed: an <iframe> snippet that renders this diagram read-only & live ----
$('btn-embed').addEventListener('click', async () => {
  const project = { app: 'dbdiga', version: 1, sql: sqlEl.value, dialect, ...collectLayout() };
  let payload;
  try { payload = await encodeShare(project); }
  catch (err) { console.error(err); return; }
  const src = location.origin + location.pathname + '?embed=1#s=' + payload;
  const snippet =
    `<iframe src="${src}" width="100%" height="500" loading="lazy"\n` +
    `        style="border:1px solid #e5e7eb;border-radius:10px" title="ER diagram"></iframe>`;
  showCodeModal('Embed this diagram', snippet, null, 'embed');
});

const fileInput = $('file-open');
$('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  // a project file opens as a new diagram named after the file; the MCP bridge
  // marks its loads with data-mode="replace" to load into the open diagram
  const replace = fileInput.dataset.mode === 'replace';
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (typeof data.sql !== 'string') throw new Error('not a dbdiga project');
      if (!replace) {
        const name = file.name.replace(/\.json$/i, '').replace(/\.sqltoerdiagrams$/i, '') || 'Untitled diagram';
        newDoc(name, {
          sql: data.sql, dialect: data.dialect, format: data.format,
          layout: { positions: data.positions, camera: data.camera, annotations: data.annotations, hidden: data.hidden, manualLinks: data.manualLinks, edgeBends: data.edgeBends, edgeAnchors: data.edgeAnchors, edgePaths: data.edgePaths },
        });
        fileInput.value = '';
        return;
      }
      sqlEl.value = data.sql;
      localStorage.setItem('dbdiga-sql', data.sql);
      if (data.dialect && DIALECTS[data.dialect]) { dialect = data.dialect; localStorage.setItem('dbdiga-dialect', dialect); syncDialect(); }
      firstRender = true;          // ensure a clean restore even if a model exists
      rebuild({ restore: { positions: data.positions, camera: data.camera, annotations: data.annotations, hidden: data.hidden, manualLinks: data.manualLinks, edgeBends: data.edgeBends, edgeAnchors: data.edgeAnchors, edgePaths: data.edgePaths } });
      saveLayout();
    } catch (err) {
      statusEl.textContent = 'Invalid project file';
      statusEl.className = 'status err';
      console.error(err);
    }
    fileInput.value = '';          // allow re-opening the same file
  };
  reader.readAsText(file);
});

// ---- My diagrams: the header button with the open diagram's name ----
const docBtn = $('doc-btn'), docName = $('doc-name'), docMenu = $('doc-menu'), docRename = $('doc-rename');
const BASE_TITLE = document.title;
const currentContent = () => ({ sql: sqlEl.value, format: formatChoice, dialect, layout: collectLayout() });
const EMPTY_LAYOUT = { positions: {}, hidden: [], manualLinks: [], edgeBends: {}, edgeAnchors: {}, edgePaths: {}, annotations: [] };

function syncDocUI() {
  docName.textContent = store.current.name;
  document.title = store.current.name === 'Untitled diagram' ? BASE_TITLE : `${store.current.name} · SQL to ER Diagram`;
}

// show a diagram's content in the editor and on the canvas (null = empty)
function applyContent(c) {
  clearTimeout(timer); timer = null;
  clearTimeout(saveTimer); saveTimer = null;
  if (c && c.dialect && DIALECTS[c.dialect]) { dialect = c.dialect; localStorage.setItem('dbdiga-dialect', dialect); syncDialect(); }
  formatChoice = c && c.format && FORMATS[c.format] ? c.format : 'auto';
  localStorage.setItem('dbdiga-format', formatChoice);
  syncFormat();
  sqlEl.value = (c && c.sql) || '';
  undoStack.length = 0;            // undo history belongs to one diagram
  redoStack.length = 0;
  firstRender = true;
  const restore = { ...EMPTY_LAYOUT };
  for (const [k, v] of Object.entries((c && c.layout) || {})) if (v != null) restore[k] = v;
  rebuild({ restore });
  saveLayout();
}
function switchDoc(id) {
  if (id === store.currentId) return;
  const content = store.open(id, currentContent());
  if (content === undefined) return;
  applyContent(content);
  syncDocUI();
}
function newDoc(name = 'Untitled diagram', content = { sql: '' }) {
  const id = store.create(name, content);
  if (!id) { window.alert('This browser’s storage is full. Delete a diagram first.'); return false; }
  switchDoc(id);
  return true;
}
function deleteDoc(id) {
  const d = store.get(id);
  if (!d || !window.confirm(`Delete “${d.name}”? This can’t be undone.`)) return;
  if (id === store.currentId) {
    const other = store.list().find((x) => x.id !== id);
    if (other) switchDoc(other.id);
    else if (!newDoc()) return;
  }
  store.remove(id);
}
function startRename() {
  docMenu.hidden = true;
  docRename.value = store.current.name;
  docRename.hidden = false; docBtn.hidden = true;
  docRename.focus(); docRename.select();
}
function endRename(commit) {
  if (docRename.hidden) return;
  if (commit && docRename.value.trim()) { store.rename(store.currentId, docRename.value); syncDocUI(); }
  docRename.hidden = true; docBtn.hidden = false;
}
docRename.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); endRename(true); docBtn.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); endRename(false); docBtn.focus(); }
  e.stopPropagation();
});
docRename.addEventListener('blur', () => endRename(true));

function renderDocMenu() {
  docMenu.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'menu-label';
  label.textContent = 'My diagrams · saved in this browser';
  docMenu.appendChild(label);
  const listEl = document.createElement('div');
  listEl.className = 'doc-list';
  for (const d of store.list()) {
    const row = document.createElement('div');
    row.className = 'doc-row' + (d.id === store.currentId ? ' active' : '');
    const open = document.createElement('button');
    open.className = 'doc-open';
    const nm = document.createElement('span'); nm.className = 'doc-row-name'; nm.textContent = d.name;
    const sub = document.createElement('span'); sub.className = 'doc-row-sub';
    sub.textContent = `${d.tables || 0} table${d.tables === 1 ? '' : 's'}`;
    open.append(nm, sub);
    open.addEventListener('click', () => { docMenu.hidden = true; switchDoc(d.id); });
    const del = document.createElement('button');
    del.className = 'doc-del'; del.textContent = '✕';
    del.title = `Delete “${d.name}”`; del.setAttribute('aria-label', del.title);
    del.addEventListener('click', (e) => { e.stopPropagation(); docMenu.hidden = true; deleteDoc(d.id); });
    row.append(open, del);
    listEl.appendChild(row);
  }
  docMenu.appendChild(listEl);
  const sep = document.createElement('div'); sep.className = 'menu-sep'; docMenu.appendChild(sep);
  const item = (text, run) => {
    const b = document.createElement('button');
    b.className = 'menu-item'; b.textContent = text;
    b.addEventListener('click', () => { docMenu.hidden = true; run(); });
    docMenu.appendChild(b);
  };
  item('New diagram', () => { if (newDoc()) sqlEl.focus(); });
  item('Rename…', startRename);
  item('Duplicate', () => newDoc(store.current.name + ' copy', currentContent()));
}
docBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  docMenu.hidden = !docMenu.hidden;
  if (!docMenu.hidden) renderDocMenu();
});
docBtn.addEventListener('dblclick', startRename);
docMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { docMenu.hidden = true; });
$('btn-new').addEventListener('click', () => { fileMenu.hidden = true; if (newDoc()) sqlEl.focus(); });
if (isEmbed) docBtn.closest('.doc-wrap').hidden = true;
syncDocUI();

// ---- splitter (resize editor pane) ----
const splitter = $('splitter');
const editorPane = $('editor-pane');
let dragSplit = null;
splitter.addEventListener('mousedown', (e) => {
  dragSplit = { startX: e.clientX, startW: editorPane.offsetWidth };
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragSplit) return;
  const w = Math.max(220, Math.min(window.innerWidth - 320, dragSplit.startW + (e.clientX - dragSplit.startX)));
  editorPane.style.width = w + 'px';
  diagram.resize();
});
window.addEventListener('mouseup', () => {
  if (dragSplit) { dragSplit = null; document.body.style.cursor = ''; }
});

window.addEventListener('resize', () => diagram.resize());

// keyboard shortcuts
// A group's fifth colour dot opens the browser's colour picker, which accepts
// any colour, including a typed hex code. The change is previewed live and
// saved (and undoable) once the picker commits it.
const groupColorInput = document.createElement('input');
groupColorInput.type = 'color';
groupColorInput.className = 'group-color-input';
groupColorInput.setAttribute('aria-label', 'Group colour');
groupColorInput.tabIndex = -1;
canvas.parentElement.appendChild(groupColorInput);
let colorTarget = null;
diagram.onPickColor = (group, sx, sy) => {
  colorTarget = group;
  groupColorInput.value = groupColor(group.color);
  groupColorInput.style.left = `${sx}px`;
  groupColorInput.style.top = `${sy}px`;
  try { groupColorInput.showPicker(); } catch { groupColorInput.click(); }
};
groupColorInput.addEventListener('input', () => {
  if (!colorTarget) return;
  colorTarget.color = groupColorInput.value.toLowerCase();
  diagram.markDirty();
});
groupColorInput.addEventListener('change', () => {
  if (!colorTarget) return;
  colorTarget.color = groupColorInput.value.toLowerCase();
  diagram.markDirty();
  diagram.onLayoutChange?.();
  colorTarget = null;
});

// Ctrl+F searches the diagram (a canvas the browser's find can't read). In the
// SQL editor it is left to the browser.
const schemaSearch = createSearchBox(diagram, canvas.parentElement);

window.addEventListener('keydown', (e) => {
  const typing = document.activeElement &&
    (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
      && document.activeElement !== sqlEl && !isEmbed) {
    e.preventDefault();
    schemaSearch.open();
  } else if (mod && !typing && !isEmbed && e.key.toLowerCase() === 'z') {
    // inside a text box the browser's own undo applies
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (mod && !typing && !isEmbed && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    rebuild({ arrange: true });
  } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && diagram.selectedAnno) {
    e.preventDefault();
    diagram.deleteSelectedAnnotation();
  } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && diagram.removePinnedLink()) {
    e.preventDefault();
  } else if (!typing && (e.key === 'h' || e.key === 'H') && diagram.selected.size > 0) {
    e.preventDefault();
    diagram.hideTable(null);   // hide the current selection
  } else if (e.key === 'Escape' && !typing) {
    hideCtx();
    diagram.clearSelection();
  }
});

// ---- embed mode: read-only, chrome-free, with a click-through backlink ----
if (isEmbed) {
  document.body.classList.add('embed');
  diagram.editable = false;
  const brand = document.createElement('a');
  brand.className = 'embed-brand';
  brand.target = '_blank';
  brand.rel = 'noopener';
  brand.href = location.origin + location.pathname + location.hash; // open full editor, same diagram
  brand.title = 'Open in SQL to ER Diagram';
  brand.innerHTML =
    '<span class="logo" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg></span>' +
    'sqltoerdiagram.com';
  document.querySelector('.canvas-pane').appendChild(brand);
}

// ---- boot: shared link > last session > example ----
(async () => {
  // 1) shared link (#s=…) takes precedence
  if (location.hash.startsWith('#s=')) {
    try {
      const data = await decodeShare(location.hash.slice(3));
      if (!isEmbed) {
        // the shared diagram opens as its own entry in My diagrams; the one
        // that was open is kept. The link is then dropped from the address
        // bar, so reloading doesn't open it again over your edits.
        const parkedSql = localStorage.getItem('dbdiga-sql') || '';
        if (parkedSql.trim()) {
          const parked = { sql: parkedSql, dialect: localStorage.getItem('dbdiga-dialect'), format: localStorage.getItem('dbdiga-format'), layout: loadSavedLayout() };
          const id = store.create('Shared diagram', null);
          if (id) store.open(id, parked);
        }
        syncDocUI();
        history.replaceState(null, '', location.pathname + location.search);
      }
      sqlEl.value = data.sql || '';
      localStorage.setItem('dbdiga-sql', sqlEl.value);
      if (data.dialect && DIALECTS[data.dialect]) {
        dialect = data.dialect;
        localStorage.setItem('dbdiga-dialect', dialect);
        syncDialect();
      }
      if (data.format && FORMATS[data.format]) {
        formatChoice = data.format;
        localStorage.setItem('dbdiga-format', formatChoice);
        syncFormat();
      }
      firstRender = true;
      // a shared schema with no saved positions (e.g. gallery links) → auto-arrange
      const hasPositions = data.positions && Object.keys(data.positions).length > 0;
      if (hasPositions) {
        rebuild({ restore: { positions: data.positions, camera: data.camera, annotations: data.annotations, hidden: data.hidden, manualLinks: data.manualLinks, edgeBends: data.edgeBends, edgeAnchors: data.edgeAnchors, edgePaths: data.edgePaths } });
      } else {
        rebuild({ arrange: true });
      }
      saveLayout();
      return;
    } catch (err) {
      console.error('Could not read shared link', err);
      statusEl.textContent = 'Bad share link';
      statusEl.className = 'status err';
    }
  }
  // 2) last session
  const saved = localStorage.getItem('dbdiga-sql');
  if (saved && saved.trim()) {
    sqlEl.value = saved;
    const savedLayout = loadSavedLayout();
    if (savedLayout) rebuild({ restore: savedLayout });
    else rebuild();
    return;
  }
  // 3) first visit
  loadExample();
})();
