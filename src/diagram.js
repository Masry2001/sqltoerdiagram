// Diagram controller: owns the camera, input handling (pan / zoom / drag),
// the render loop, edge routing and export. Renders only when dirty and only
// what is on screen.
import { THEMES, rasterizeTable, columnY, measureTable, ROW_H, HEADER_H } from './renderer.js';
import { NOTE_COLORS, GROUP_COLORS, NOTE_ORDER, GROUP_ORDER, makeAnnotation, groupColor, isHexColor } from './annotations.js';
import { relationCardinality } from './cardinality.js';
import { inferLinks as inferLinksCore } from './infer-links.js';
import { routeEdges, edgeMidpoint, anchorForPoint } from './edge-routing.js';
import { arrangeLines } from './line-arranger.js';
import { pathStillFits, pathJumps, pathMidpoint, pathDistance, JUMP_RADIUS, elbowPath, pathUnderTables, separateOverlaps, routeMoved } from './orthogonal-router.js';

const GROUP_LABEL_FAMILY = 'ui-sans-serif, system-ui, sans-serif';
const GROUP_LABEL_FONT = `600 13px ${GROUP_LABEL_FAMILY}`;
const GROUP_LABEL_H = 32;      // screen px: the strip that holds a group's name
const GROUP_LABEL_MIN_W = 80;  // screen px: keeps short or empty names grabbable
const SEARCH_MIN_SCALE = 0.7;  // zoom used to show a search result that is too small to read
const SEARCH_MARK_COLOR = '#f5b14a';
const LIVE_IN_PAGE_MS = 25;     // live routing slower than this moves to a worker
const EDGE_HIT = 8;            // screen px: how close a click must be to select a line
const EDGE_HANDLE_R = 7;       // screen px: the bend handle on a clicked line
const EDGE_HANDLE_HIT = 11;    // screen px: how close a press must be to grab it
const EDGE_END_R = 5;          // screen px: the handle at each end of a clicked line
const EDGE_END_HIT = 10;       // screen px: how close a press must be to grab it
const EDGE_DELETE_R = 9;       // screen px: the delete button on a clicked manual link
const EDGE_DELETE_OFFSET = 26; // screen px: its distance to the right of the handle
const EDGE_DELETE_COLOR = '#d9534f';

export class Diagram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cam = { x: 0, y: 0, scale: 1 };
    this.model = { tables: [], relations: [] };
    this.themeName = 'dark';
    this.theme = THEMES.dark;
    this.bitmaps = new Map();      // table.key -> offscreen canvas
    this.dirty = true;
    this.frameQueued = false;
    this.drag = null;              // active single-table drag
    this.dragGroup = null;         // active multi-table drag
    this.marquee = null;           // active rubber-band selection (world coords)
    this.selected = new Set();     // multi-selected tables (for group drag)
    this.hidden = new Set();       // keys of hidden tables (node + edges suppressed)
    this.onHiddenChange = null;    // fired when the hidden set changes
    this.onSelectionChange = null; // fired when the selected set changes
    this.manualLinks = [];         // user-drawn / inferred links {from:{table,col},to:{table,col}}
    this.hoverConn = null;         // {t, colIndex} — column row showing connector dots
    this.linking = null;           // in-progress link drag {fromKey, fromCol, side, wx, wy, cx, cy}
    this.pan = null;               // active background pan
    this.hover = null;             // table under cursor (transient highlight)
    this.hoverEdge = null;         // id of the line under the cursor
    this.pinnedEdge = null;        // clicked line {id, fromKey, toKey} (sticky focus)
    this.pressEdge = null;         // line under an in-progress click
    this.edgeBends = {};           // line id -> {x, y} offset of its midpoint
    this.edgeDrag = null;          // active bend {id, baseX, baseY, grabX, grabY, moved}
    this.edgeAnchors = {};         // line id -> {from?, to?} ends pinned as {side, t}
    this.edgeEndDrag = null;       // active end drag {id, end, tableKey, moved}
    this.edgePaths = {};           // line id -> straight path {points, fromSide, toSide}
    this._straightRun = 0;         // the latest straight routing; older results are dropped
    this._live = null;             // background routing while tables are dragged
    this._livePaths = null;        // its latest routes, for the dragged tables' lines
    this.highlightedRoutes = [];   // lines emphasised on the last draw
    this.pinned = null;            // clicked table (sticky focus)
    this.pinnedKeys = null;        // Set of focused table + neighbour keys
    this.onZoom = null;
    this.onLayoutChange = null;    // fired after a drag / pan / zoom so positions persist
    this.onEdit = null;            // callback({kind, tableKey, colName?, value})
    this.onAddColumn = null;       // callback(tableKey)
    this.editing = null;           // active inline editor
    this.editable = true;          // false for parse-only formats (Prisma/ORM) — no edit-back
    this.typeSuggestions = [];     // dialect type list for the type editor
    this.annotations = [];         // group boxes + sticky notes
    this.selectedAnno = null;      // currently selected annotation
    this.annoDrag = null;          // annotation move
    this.annoResize = null;        // annotation resize

    this._bindInput();
    this._loop = this._loop.bind(this);
  }

  setModel(model, { keepCamera = false } = {}) {
    // preserve positions of tables that still exist (so live edits don't jump)
    const prev = new Map((this.model.tables || []).map(t => [t.key, t]));
    for (const t of model.tables) {
      // always size every table — layout() may be skipped on live edits, but
      // the renderer & fit need w/h regardless.
      const dims = measureTable(t);
      t.w = dims.w; t.h = dims.h; t.rowH = dims.rowH; t.headerH = dims.headerH;
      const old = prev.get(t.key);
      if (old && Number.isFinite(old.x)) { t.x = old.x; t.y = old.y; }
    }
    this.model = model;
    this.bitmaps.clear();
    this._tmapDirty = true;
    this.pinned = null;
    this.pinnedKeys = null;
    this.selected = new Set();
    this.dragGroup = null;
    this.marquee = null;
    this.linking = null;
    this.hoverConn = null;
    this.hoverEdge = null;
    this.pinnedEdge = null;
    this.pressEdge = null;
    this.searchMark = null;
    this.markDirty();
    if (!keepCamera) {/* caller may fit */}
  }

  // The table whose relationships should be emphasised: a click-pinned table
  // wins over a transient hover.
  get focus() { return this.pinned || this.hover; }

  _pin(t) {
    if (this.pinned === t) { this.pinned = null; this.pinnedKeys = null; }
    else this._setPin(t);
    this.markDirty();
  }

  // Pins a clicked line, or releases it when clicked again.
  _pinEdge(seg) {
    this.pinned = null;
    this.pinnedKeys = null;
    this.pinnedEdge = this.pinnedEdge?.id === seg.id
      ? null
      : { id: seg.id, fromKey: seg.fromKey, toKey: seg.toKey };
    this.markDirty();
  }

  _clearPinnedEdge() {
    if (!this.pinnedEdge) return;
    this.pinnedEdge = null;
    this.markDirty();
  }

  _setPin(t) {
    this.pinnedEdge = null;
    this.pinned = t;
    const keys = new Set([t.key]);
    for (const r of this.model.relations) {
      if (r.fromTable.toLowerCase() === t.key) keys.add(r.toTable.toLowerCase());
      if (r.toTable.toLowerCase() === t.key) keys.add(r.fromTable.toLowerCase());
    }
    this.pinnedKeys = keys;
  }

  // pin a table by key (used after add-column so the affordance stays visible)
  pinByKey(key) {
    const t = this.model.tables.find(x => x.key === key);
    if (t) { this._setPin(t); this.markDirty(); }
  }

  // open the inline editor on a specific column's name (used right after adding)
  editColumn(tableKey, colName) {
    const t = this.model.tables.find(x => x.key === tableKey);
    if (!t) return;
    const idx = t.columns.findIndex(c => c.name === colName);
    if (idx < 0) return;
    const rowY = t.y + HEADER_H + idx * ROW_H;
    const split = t.x + t.w * 0.58;
    this._beginEdit({
      table: t, kind: 'column-name', colName, value: colName,
      rect: { x: t.x + 30, y: rowY, w: split - (t.x + 30), h: ROW_H },
      align: 'left', weight: 400,
    });
  }

  setTheme(name) {
    this.themeName = name;
    this.theme = THEMES[name] || THEMES.dark;
    this.bitmaps.clear();
    document.documentElement.dataset.theme = name;
    this.markDirty();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.markDirty();
  }

  start() {
    this.resize();
    requestAnimationFrame(this._loop);
  }

  markDirty() {
    this.dirty = true;
    if (!this.frameQueued) {
      this.frameQueued = true;
      requestAnimationFrame(this._loop);
    }
  }

  _loop() {
    this.frameQueued = false;
    if (this.dirty) {
      this.dirty = false;
      this._render();
    }
  }

  // ---- coordinate transforms ----
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.cam.x) / this.cam.scale,
      y: (sy - this.cam.y) / this.cam.scale,
    };
  }

  // ---- bitmaps ----
  _bitmap(t) {
    let bm = this.bitmaps.get(t.key);
    if (!bm) {
      bm = rasterizeTable(t, this.theme, this.dpr);
      this.bitmaps.set(t.key, bm);
    }
    return bm;
  }

  // ---- rendering ----
  _render() {
    const { ctx, cam, theme, dpr } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);

    this._drawGrid();

    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, cam.x * dpr, cam.y * dpr);

    // viewport in world coords (for culling)
    const vx0 = -cam.x / cam.scale, vy0 = -cam.y / cam.scale;
    const vx1 = (this.viewW - cam.x) / cam.scale, vy1 = (this.viewH - cam.y) / cam.scale;
    const margin = 50;
    const cull = { x0: vx0 - margin, y0: vy0 - margin, x1: vx1 + margin, y1: vy1 + margin };

    // group boxes sit behind everything
    for (const a of this.annotations) if (a.type === 'group') this._drawGroup(a, cull);

    // edges
    this._drawEdges(cull.x0, cull.y0, cull.x1, cull.y1);

    // tables
    const pinned = this.pinned;
    const pinnedEdge = this.pinnedEdge;
    for (const t of this.model.tables) {
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      if (t.x > vx1 + margin || t.x + t.w < vx0 - margin ||
          t.y > vy1 + margin || t.y + t.h < vy0 - margin) continue;
      const bm = this._bitmap(t);
      const onPinnedEdge = pinnedEdge && (pinnedEdge.fromKey === t.key || pinnedEdge.toKey === t.key);
      const dim = pinnedEdge ? !onPinnedEdge : pinned && !this.pinnedKeys.has(t.key);
      ctx.save();
      ctx.globalAlpha = dim ? 0.22 : 1;
      // soft shadow (skip for dimmed tables to keep them recessive)
      if (!dim) {
        ctx.shadowColor = theme.shadow;
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 6;
      }
      ctx.drawImage(bm, t.x, t.y, t.w, t.h);
      ctx.restore();

      const emphasised = this.hover === t || this.drag?.t === t || pinned === t || this.selected.has(t) || onPinnedEdge;
      if (emphasised) {
        ctx.strokeStyle = theme.edgeHi;
        ctx.lineWidth = (pinned === t || this.selected.has(t) || onPinnedEdge ? 2.5 : 2) / cam.scale;
        roundRectPath(ctx, t.x, t.y, t.w, t.h, 10);
        ctx.stroke();
      }
    }

    // "+ add column" affordance under the pinned table (SQL only)
    if (pinned && Number.isFinite(pinned.x) && this.editable) this._drawAddButton(pinned);

    this._drawLinkedColumns();
    this._drawSearchMark();

    // group names above the edges and tables
    for (const a of this.annotations) if (a.type === 'group') this._drawGroupLabel(a, cull);

    // sticky notes on top of tables
    for (const a of this.annotations) if (a.type === 'note') this._drawNote(a, cull);

    this._drawEdgeHandle();

    // selection chrome (handles, colour dots, delete) for the selected annotation
    if (this.selectedAnno) this._drawAnnoChrome(this.selectedAnno);

    // rubber-band marquee
    if (this.marquee) {
      const m = this.marquee;
      const x = Math.min(m.ax, m.x), y = Math.min(m.ay, m.y);
      const w = Math.abs(m.x - m.ax), h = Math.abs(m.y - m.ay);
      ctx.save();
      ctx.fillStyle = hexA(theme.edgeHi, 0.10);
      ctx.strokeStyle = theme.edgeHi;
      ctx.lineWidth = 1 / cam.scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    // connector dots on the hovered column row (drag one to link)
    if (this.hoverConn && !this.linking && !this.drag && !this.dragGroup && !this.pan) {
      const d = this._connDots(this.hoverConn.t, this.hoverConn.colIndex);
      const rr = 4.5 / cam.scale;
      for (const p of d) {
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = theme.edgeHi; ctx.fill();
        ctx.lineWidth = 2 / cam.scale; ctx.strokeStyle = theme.tableBg; ctx.stroke();
      }
    }

    // in-progress link drag (preview)
    if (this.linking) {
      const k = this.linking;
      const dx = Math.max(28, Math.abs(k.cx - k.wx) * 0.4);
      ctx.save();
      ctx.setLineDash([6 / cam.scale, 5 / cam.scale]);
      ctx.strokeStyle = theme.edgeHi; ctx.lineWidth = 2 / cam.scale;
      ctx.beginPath();
      ctx.moveTo(k.wx, k.wy);
      ctx.bezierCurveTo(k.wx + (k.side === 'right' ? dx : -dx), k.wy, k.cx, k.cy, k.cx, k.cy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.edgeHi;
      dot(ctx, k.wx, k.wy, 4 / cam.scale);
      ctx.restore();
    }
  }

  // left/right connector dot positions for a column row (world coords)
  _connDots(t, idx) {
    const y = t.y + HEADER_H + idx * ROW_H + ROW_H / 2;
    return [{ x: t.x, y, side: 'left' }, { x: t.x + t.w, y, side: 'right' }];
  }

  // ---- annotation rendering ----
  _annoVisible(a, c) {
    return !(a.x > c.x1 || a.x + a.w < c.x0 || a.y > c.y1 || a.y + a.h < c.y0);
  }

  _drawGroup(a, cull) {
    if (!this._annoVisible(a, cull)) return;
    const { ctx, cam } = this;
    const color = groupColor(a.color);
    ctx.save();
    roundRectPath(ctx, a.x, a.y, a.w, a.h, 12);
    ctx.fillStyle = hexA(color, 0.08);
    ctx.fill();
    ctx.strokeStyle = hexA(color, 0.7);
    ctx.lineWidth = 1.5 / cam.scale;
    ctx.stroke();
    ctx.restore();
  }

  // Drawn after the edges and tables so the name is never covered by them.
  _drawGroupLabel(a, cull) {
    if (!a.text || !this._annoVisible(a, cull)) return;
    const { ctx, cam } = this;
    ctx.save();
    ctx.fillStyle = groupColor(a.color);
    ctx.font = `600 ${13 / cam.scale}px ${GROUP_LABEL_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const pad = 10 / cam.scale;
    ctx.fillText(clip(ctx, a.text, a.w - pad * 2), a.x + pad, a.y + 16 / cam.scale);
    ctx.restore();
  }

  _drawNote(a, cull) {
    if (!this._annoVisible(a, cull)) return;
    const { ctx, cam } = this;
    const c = NOTE_COLORS[a.color] || NOTE_COLORS.yellow;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    roundRectPath(ctx, a.x, a.y, a.w, a.h, 8);
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, a.x, a.y, a.w, a.h, 8);
    ctx.clip();
    ctx.fillStyle = c.text;
    ctx.font = `${13 / cam.scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const pad = 10 / cam.scale;
    const lh = 17 / cam.scale;
    const text = a.text || 'Double-click to edit';
    if (!a.text) ctx.globalAlpha = 0.5;
    let y = a.y + pad;
    for (const line of wrapText(ctx, text, a.w - pad * 2)) {
      ctx.fillText(line, a.x + pad, y);
      y += lh;
      if (y > a.y + a.h - pad) break;
    }
    ctx.restore();
  }

  _drawAnnoChrome(a) {
    const { ctx, cam } = this;
    const s = cam.scale;
    // selection outline
    ctx.strokeStyle = this.theme.edgeHi;
    ctx.lineWidth = 2 / s;
    roundRectPath(ctx, a.x, a.y, a.w, a.h, a.type === 'group' ? 12 : 8);
    ctx.stroke();

    // resize handle (bottom-right)
    const hs = 9 / s;
    ctx.fillStyle = this.theme.edgeHi;
    ctx.fillRect(a.x + a.w - hs, a.y + a.h - hs, hs, hs);

    // toolbar above: colour dots + delete
    const dots = this._annoChromeRects(a);
    for (const d of dots.colors) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.fillStyle = d.fill;
      ctx.fill();
      if (d.active) { ctx.strokeStyle = this.theme.edgeHi; ctx.lineWidth = 2 / s; ctx.stroke(); }
    }
    if (dots.custom) {
      const d = dots.custom;
      if (d.active) {                                // the chosen colour, ringed like the other dots
        ctx.beginPath();
        ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.fill;
        ctx.fill();
        ctx.strokeStyle = this.theme.edgeHi;
        ctx.lineWidth = 2 / s;
        ctx.stroke();
      } else {                                       // a colour wheel: "any colour"
        const hues = 12;
        for (let i = 0; i < hues; i++) {
          ctx.beginPath();
          ctx.moveTo(d.cx, d.cy);
          ctx.arc(d.cx, d.cy, d.r, (i / hues) * Math.PI * 2, ((i + 1) / hues) * Math.PI * 2 + 0.02);
          ctx.closePath();
          ctx.fillStyle = `hsl(${(i * 360) / hues}, 80%, 60%)`;
          ctx.fill();
        }
      }
    }
    const del = dots.delete;
    ctx.beginPath();
    ctx.arc(del.cx, del.cy, del.r, 0, Math.PI * 2);
    ctx.fillStyle = '#e06c6c';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / s;
    const k = del.r * 0.45;
    ctx.beginPath();
    ctx.moveTo(del.cx - k, del.cy - k); ctx.lineTo(del.cx + k, del.cy + k);
    ctx.moveTo(del.cx + k, del.cy - k); ctx.lineTo(del.cx - k, del.cy + k);
    ctx.stroke();
  }

  // geometry of the colour dots + delete button + resize handle (world coords)
  _annoChromeRects(a) {
    const s = this.cam.scale;
    const r = 8 / s;
    const gap = 22 / s;
    const y = a.y - 18 / s;
    const order = a.type === 'group' ? GROUP_ORDER : NOTE_ORDER;
    const colors = order.map((key, i) => ({
      key, cx: a.x + r + i * gap, cy: y, r,
      fill: a.type === 'group' ? GROUP_COLORS[key] : NOTE_COLORS[key].fill,
      active: a.color === key,
    }));
    // groups get a fifth dot that opens a picker for any colour
    const custom = a.type === 'group'
      ? { cx: a.x + r + order.length * gap, cy: y, r, active: isHexColor(a.color), fill: groupColor(a.color) }
      : null;
    const del = { cx: a.x + a.w - r, cy: y, r };
    const hs = 9 / s;
    const resize = { x: a.x + a.w - hs, y: a.y + a.h - hs, w: hs, h: hs };
    return { colors, custom, delete: del, resize };
  }

  // ---- annotation API ----
  setAnnotations(arr) {
    this.annotations = Array.isArray(arr) ? arr : [];
    this.selectedAnno = null;
    this.markDirty();
  }

  addAnnotation(type) {
    const center = this.screenToWorld(this.viewW / 2, this.viewH / 2);
    const a = makeAnnotation(type, center.x, center.y);
    this.annotations.push(a);
    this.selectedAnno = a;
    this.pinned = null; this.pinnedKeys = null;
    this.markDirty();
    this.onLayoutChange?.();
    this._beginEditAnnotation(a);
    return a;
  }

  deleteSelectedAnnotation() {
    if (!this.selectedAnno) return;
    const i = this.annotations.indexOf(this.selectedAnno);
    if (i >= 0) this.annotations.splice(i, 1);
    this.selectedAnno = null;
    this.markDirty();
    this.onLayoutChange?.();
  }

  _noteAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a.type === 'note' && inside(w, a)) return a;
    }
    return null;
  }

  // The group whose name is under the cursor. Names keep their on-screen size,
  // so this is measured in screen pixels.
  _groupLabelAt(sx, sy) {
    const { ctx, cam } = this;
    ctx.save();
    ctx.font = GROUP_LABEL_FONT;
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a.type !== 'group') continue;
      const left = a.x * cam.scale + cam.x;
      const top = a.y * cam.scale + cam.y;
      const width = Math.min(a.w * cam.scale, Math.max(GROUP_LABEL_MIN_W, ctx.measureText(a.text || '').width + 20));
      if (sx >= left && sx <= left + width && sy >= top && sy <= top + GROUP_LABEL_H) {
        ctx.restore();
        return a;
      }
    }
    ctx.restore();
    return null;
  }

  // The tables that belong to a group: those whose centre is inside its box.
  _tablesInGroup(a) {
    return this.model.tables.filter((t) => Number.isFinite(t.x)
      && inside({ x: t.x + t.w / 2, y: t.y + t.h / 2 }, a));
  }

  // select an annotation, bring it to front and start dragging it
  _grabAnno(a, sx, sy) {
    const w = this.screenToWorld(sx, sy);
    this.selectedAnno = a;
    this.pinned = null; this.pinnedKeys = null;
    const ai = this.annotations.indexOf(a);
    this.annotations.splice(ai, 1); this.annotations.push(a);
    const tables = a.type === 'group'
      ? this._tablesInGroup(a).map((t) => ({ t, x0: t.x, y0: t.y }))
      : [];
    this.annoDrag = { a, dx: w.x - a.x, dy: w.y - a.y, x0: a.x, y0: a.y, tables, moved: false };
    this.markDirty();
  }

  // hit-test the selected annotation's chrome; returns an action or null
  _annoChromeAt(sx, sy) {
    const a = this.selectedAnno;
    if (!a) return null;
    const w = this.screenToWorld(sx, sy);
    const rects = this._annoChromeRects(a);
    for (const d of rects.colors) {
      if ((w.x - d.cx) ** 2 + (w.y - d.cy) ** 2 <= (d.r * 1.4) ** 2) return { kind: 'color', value: d.key };
    }
    const custom = rects.custom;
    if (custom && (w.x - custom.cx) ** 2 + (w.y - custom.cy) ** 2 <= (custom.r * 1.4) ** 2) return { kind: 'custom' };
    const del = rects.delete;
    if ((w.x - del.cx) ** 2 + (w.y - del.cy) ** 2 <= (del.r * 1.4) ** 2) return { kind: 'delete' };
    const rz = rects.resize;
    if (w.x >= rz.x - 4 / this.cam.scale && w.x <= rz.x + rz.w + 4 / this.cam.scale &&
        w.y >= rz.y - 4 / this.cam.scale && w.y <= rz.y + rz.h + 4 / this.cam.scale) return { kind: 'resize' };
    return null;
  }

  _beginEditAnnotation(a) {
    this._cancelEdit();
    const { cam } = this;
    const multiline = a.type === 'note';
    const el = document.createElement(multiline ? 'textarea' : 'input');
    el.className = 'inline-edit anno-edit';
    el.value = a.text || '';
    el.style.left = (a.x * cam.scale + cam.x) + 'px';
    el.style.top = (a.y * cam.scale + cam.y) + 'px';
    el.style.width = Math.max(60, a.w * cam.scale) + 'px';
    el.style.height = (multiline ? a.h : 28) * cam.scale + 'px';
    el.style.fontSize = Math.max(9, 13 * cam.scale) + 'px';
    if (a.type === 'note') {
      // edit on the note's own colour so text stays readable in dark mode
      const c = NOTE_COLORS[a.color] || NOTE_COLORS.yellow;
      el.style.background = c.fill;
      el.style.color = c.text;
      el.style.caretColor = c.text;
    }

    this.canvas.parentElement.appendChild(el);
    el.focus();
    el.select();

    const commit = () => {
      if (!this.editing || this.editing.anno !== a) return;
      a.text = el.value;
      this.editing = null;
      el.remove();
      this.markDirty();
      this.onLayoutChange?.();
    };
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
      else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      e.stopPropagation();
    });
    el.addEventListener('blur', commit);
    this.editing = { anno: a, input: el };
  }

  _addRect(t) {
    return { x: t.x, y: t.y + t.h + 8, w: t.w, h: 24 };
  }

  _drawAddButton(t) {
    const { ctx, cam, theme } = this;
    const r = this._addRect(t);
    ctx.save();
    ctx.setLineDash([6 / cam.scale, 4 / cam.scale]);
    ctx.strokeStyle = theme.edgeHi;
    ctx.lineWidth = 1.5 / cam.scale;
    ctx.fillStyle = theme.tableBg;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 7);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.edgeHi;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${13 / cam.scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText('+ add column', r.x + r.w / 2, r.y + r.h / 2);
    ctx.restore();
  }

  _addButtonAt(sx, sy) {
    if (!this.editable || !this.pinned || !Number.isFinite(this.pinned.x)) return false;
    const w = this.screenToWorld(sx, sy);
    const r = this._addRect(this.pinned);
    return w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h;
  }

  _drawGrid() {
    const { ctx, cam, theme, dpr } = this;
    const step = 32 * cam.scale * dpr;
    if (step < 8) return;
    const W = this.canvas.width, H = this.canvas.height;
    const ox = (cam.x * dpr) % step;
    const oy = (cam.y * dpr) % step;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  // bezier segment between two table columns (or null if not drawable / off-screen)
  // FK relations + user-defined manual links (latter drawn dashed).
  // FK relations carry crow's-foot cardinality; manual links stay neutral.
  _routes() {
    const byKey = this._tableMap();
    const edges = [];
    for (const r of this.model.relations) {
      edges.push({
        fromKey: r.fromTable.toLowerCase(), toKey: r.toTable.toLowerCase(),
        fromCol: r.fromCols[0], toCol: r.toCols[0],
        manual: false, card: relationCardinality(r, byKey),
      });
    }
    for (const l of this.manualLinks) {
      edges.push({
        fromKey: l.from.table, toKey: l.to.table,
        fromCol: l.from.col, toCol: l.to.col,
        manual: true, card: null, link: l,
      });
    }
    // While tables are being dragged, their lines let go of their entry points
    // and bends, so each line follows the table and enters from the side that
    // faces the other table. In straight mode, entry points left over from the
    // curved "Arrange lines" don't apply at all.
    let anchors = this.edgeAnchors, bends = this.edgeBends, looseIds = null;
    if (this.isStraightMode()) {
      anchors = {};
      for (const [id, ends] of Object.entries(this.edgeAnchors)) { const hand = handEnds(ends); if (hand) anchors[id] = hand; }
      bends = {};
    }
    const moving = this._movingKeys();
    if (moving.size) {
      anchors = { ...anchors }; bends = { ...bends }; looseIds = new Set();
      for (const e of edges) {
        if (!moving.has(e.fromKey) && !moving.has(e.toKey)) continue;
        const id = `${e.fromKey}.${e.fromCol}>${e.toKey}.${e.toCol}`;
        looseIds.add(id);
        delete anchors[id];
        delete bends[id];
      }
    }
    const routes = routeEdges(edges, byKey, (key) => this.hidden.has(key), bends, anchors);
    // a straight path from "Arrange lines straight" replaces the curve while it
    // still fits its tables. In straight mode a line without one (its table is
    // being moved, or it waits to be re-routed) is drawn as a simple right angle.
    const straightMode = this.isStraightMode();
    const chosen = [];
    for (const seg of routes) {
      // lines of a table being dragged use the routes found while dragging
      let path = looseIds?.has(seg.id) ? (this._livePaths?.[seg.id] ?? null) : this.edgePaths[seg.id];
      if (!path || !pathStillFits(path, byKey.get(seg.fromKey), byKey.get(seg.toKey))) {
        if (!straightMode) continue;
        path = elbowPath(seg);
      }
      chosen.push({ seg, path });
    }
    // no two lines are drawn on top of each other or from one entry point
    const apart = separateOverlaps(chosen.map(({ seg, path }) => ({ id: seg.id, points: path.points })));
    const facing = { right: 1, bottom: 1, left: -1, top: -1 };
    for (const { seg, path } of chosen) {
      const points = apart[seg.id] || path.points;
      const first = points[0], last = points[points.length - 1];
      Object.assign(seg, {
        path: points,
        basePath: path.points,                       // the route before it was moved apart
        fx: first[0], fy: first[1], tx: last[0], ty: last[1],
        fromSide: path.fromSide, toSide: path.toSide,
        fromDir: facing[path.fromSide], toDir: facing[path.toSide],
        fromVertical: path.fromSide === 'top' || path.fromSide === 'bottom',
        toVertical: path.toSide === 'top' || path.toSide === 'bottom',
      });
    }
    return routes;
  }

  setEdgePaths(paths) {
    this._straightRun++;
    this.edgePaths = {};
    const sides = ['left', 'right', 'top', 'bottom'];
    for (const [id, p] of Object.entries(paths || {})) {
      const ok = Array.isArray(p?.points) && p.points.length >= 2
        && p.points.every((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
        && sides.includes(p.fromSide) && sides.includes(p.toSide);
      if (ok) this.edgePaths[id] = { points: p.points.map(([x, y]) => [x, y]), fromSide: p.fromSide, toSide: p.toSide };
    }
    this.markDirty();
  }

  // Lines are drawn straight once "Arrange lines straight" has run, until
  // "Arrange lines" turns them back into curves.
  isStraightMode() {
    for (const _ in this.edgePaths) return true;
    return false;
  }

  // What the straight router needs: tables, every line, and the ends the user
  // placed by hand.
  _straightInput() {
    const tables = this.model.tables
      .filter((t) => Number.isFinite(t.x))
      .map((t) => ({ key: t.key, x: t.x, y: t.y, w: t.w, h: t.h }));
    const edges = [];
    for (const r of this.model.relations) {
      const e = { fromKey: r.fromTable.toLowerCase(), toKey: r.toTable.toLowerCase(), fromCol: r.fromCols[0], toCol: r.toCols[0] };
      edges.push({ ...e, id: `${e.fromKey}.${e.fromCol}>${e.toKey}.${e.toCol}` });
    }
    for (const l of this.manualLinks) {
      edges.push({ fromKey: l.from.table, toKey: l.to.table, id: `${l.from.table}.${l.from.col}>${l.to.table}.${l.to.col}` });
    }
    const anchors = {};
    for (const [id, ends] of Object.entries(this.edgeAnchors)) {
      const hand = {};
      if (ends.from && !ends.from.arranged) hand.from = ends.from;
      if (ends.to && !ends.to.arranged) hand.to = ends.to;
      if (hand.from || hand.to) anchors[id] = hand;
    }
    // group boxes: lines keep out of groups that hold neither of their tables
    const groups = this.annotations.filter((a) => a.type === 'group').map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h }));
    return { tables, edges, anchors, groups };
  }

  _runStraightWorker(message) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./straight-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => { if (event.data.partial) return; worker.terminate(); resolve(event.data); };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage({ groups: this._straightInput().groups, ...message, hidden: [...this.hidden] });
    });
  }

  // Arrange lines straight: route every line as horizontal and vertical
  // segments around the tables (in a background worker), then show them.
  async arrangeLinesStraight() {
    const { tables, edges, anchors } = this._straightInput();
    const run = ++this._straightRun;
    const { paths, failed, overlapping, ms } = await this._runStraightWorker({ tables, edges, anchors, keep: {} });
    if (run === this._straightRun) {
      this.edgePaths = paths;
      // entry points and bends from the curved "Arrange lines" don't apply to
      // straight lines; ones placed by hand are kept
      const hand = {};
      for (const [id, ends] of Object.entries(this.edgeAnchors)) { const h = handEnds(ends); if (h) hand[id] = h; }
      this.edgeAnchors = hand;
      this.edgeBends = Object.fromEntries(Object.entries(this.edgeBends).filter(([, b]) => !b.arranged));
      this.pinnedEdge = null;
      this.markDirty();
      this.onLayoutChange?.();
    }
    return { routed: Object.keys(paths).length, failed: failed.length, sharing: overlapping.length, ms };
  }

  // Keys of the tables being dragged right now (one table, a selection, or a
  // group dragged by its name).
  _movingKeys() {
    const keys = new Set();
    if (this.drag?.moved) keys.add(this.drag.t.key);
    if (this.dragGroup?.moved) for (const i of this.dragGroup.items) if (i.t?.key) keys.add(i.t.key);
    if (this.annoDrag?.moved) for (const i of this.annoDrag.tables || []) keys.add(i.t.key);
    return keys;
  }

  // While tables are dragged in straight mode, their lines are routed around
  // the other tables, with the quick routing ("fast"). For a table with few
  // lines this runs in the page once per frame, so the lines always match the
  // table's spot; when that gets slow (a very connected table) it runs in a
  // background worker instead, one routing at a time, and until a route
  // matches the table's current spot the line is a simple right angle.
  _scheduleLiveRoute() {
    if (!this.isStraightMode()) return;
    if (!this._live) this._live = { worker: null, busy: false, pending: false, frame: 0, slowMs: 0 };
    const live = this._live;
    if (live.slowMs < LIVE_IN_PAGE_MS) {
      if (!live.frame) live.frame = requestAnimationFrame(() => { live.frame = 0; if (this._live === live) this._liveRouteInPage(); });
      return;
    }
    if (live.busy) { live.pending = true; return; }
    this._liveRouteInWorker();
  }

  // the lines of the dragged tables, and every other line that stays
  _liveInput() {
    const keys = this._movingKeys();
    if (!keys.size) return null;
    const { tables, edges, groups } = this._straightInput();
    const byKey = new Map(tables.map((t) => [t.key, t]));
    const todo = [], keep = {};
    for (const e of edges) {
      if (keys.has(e.fromKey) || keys.has(e.toKey)) { todo.push(e); continue; }
      const p = this.edgePaths[e.id];
      if (p && pathStillFits(p, byKey.get(e.fromKey), byKey.get(e.toKey))) keep[e.id] = p;
    }
    return todo.length ? { tables, byKey, todo, keep, groups } : null;
  }

  _liveRouteInPage() {
    const input = this._liveInput();
    if (!input) return;
    const started = performance.now();
    const { paths } = routeMoved(input.todo, input.byKey, { keep: input.keep, groups: input.groups, isHidden: (k) => this.hidden.has(k) });
    if (this._live) this._live.slowMs = performance.now() - started;
    this._livePaths = paths;
    this.markDirty();
  }

  _liveRouteInWorker() {
    const input = this._liveInput();
    if (!input) return;
    const live = this._live;
    if (!live.worker) live.worker = new Worker(new URL('./straight-worker.js', import.meta.url), { type: 'module' });
    live.busy = true;
    live.pending = false;
    live.worker.onmessage = (event) => {
      if (this._live !== live) return;               // the drag ended
      this._livePaths = event.data.paths;
      this.markDirty();
      if (event.data.partial) return;               // the careful pass follows
      live.busy = false;
      live.slowMs = event.data.ms;                  // fast again: back to routing in the page
      if (live.pending) this._liveRouteInWorker();
    };
    live.worker.onerror = (err) => { live.busy = false; console.error('live routing failed', err); };
    live.worker.postMessage({ tables: input.tables, edges: input.todo, anchors: {}, keep: input.keep, groups: input.groups, moved: true, hidden: [...this.hidden] });
  }

  _stopLiveRoute() {
    if (this._live?.worker) this._live.worker.terminate();
    if (this._live?.frame) cancelAnimationFrame(this._live.frame);
    this._live = null;
    this._livePaths = null;
  }

  // After tables were moved: their lines choose their sides again. Straight
  // lines are re-routed; arranged curved lines are re-arranged.
  _linesAfterMove(keys, livePaths = null) {
    if (!keys.size) return;
    // routes found while dragging that match where the tables were dropped
    // are kept on screen while the final routing runs, so nothing jumps
    const settled = new Set();         // lines whose route from the drag already fits
    if (livePaths && this.isStraightMode()) {
      const byKey = this._tableMap();
      for (const [id, p] of Object.entries(livePaths)) {
        const [f, t] = id.split('>').map((s) => s.slice(0, s.lastIndexOf('.')));
        if (pathStillFits(p, byKey.get(f), byKey.get(t))) { this.edgePaths[id] = p; settled.add(id); }
      }
    }
    // a moved table's lines start over: entry points and bends on them are
    // released, including ones placed by hand (drag an end again to fine-tune)
    for (const id of this._lineIdsOf(keys)) { delete this.edgeAnchors[id]; delete this.edgeBends[id]; }
    if (this.isStraightMode()) this.rerouteStraight(keys, settled);
    else this._rearrangeLinesOf(keys);
  }

  // Ids of every line attached to one of the tables.
  _lineIdsOf(keys) {
    const ids = [];
    for (const r of this.model.relations) {
      const f = r.fromTable.toLowerCase(), t = r.toTable.toLowerCase();
      if (keys.has(f) || keys.has(t)) ids.push(`${f}.${r.fromCols[0]}>${t}.${r.toCols[0]}`);
    }
    for (const l of this.manualLinks) {
      if (keys.has(l.from.table) || keys.has(l.to.table)) ids.push(`${l.from.table}.${l.from.col}>${l.to.table}.${l.to.col}`);
    }
    return ids;
  }

  // Curved mode: re-arrange only the lines of the moved tables, around every
  // other line's entry points. Nothing to do if "Arrange lines" was never used
  // (unarranged lines already follow their tables).
  _rearrangeLinesOf(keys) {
    const arranged = Object.values(this.edgeAnchors).some((a) => a.from?.arranged || a.to?.arranged);
    if (!arranged) return;
    const byKey = this._tableMap();
    const edges = [];
    for (const r of this.model.relations) {
      edges.push({ fromKey: r.fromTable.toLowerCase(), toKey: r.toTable.toLowerCase(), fromCol: r.fromCols[0], toCol: r.toCols[0] });
    }
    for (const l of this.manualLinks) edges.push({ fromKey: l.from.table, toKey: l.to.table, fromCol: l.from.col, toCol: l.to.col });
    const touching = new Set(edges
      .filter((e) => keys.has(e.fromKey) || keys.has(e.toKey))
      .map((e) => `${e.fromKey}.${e.fromCol}>${e.toKey}.${e.toCol}`));
    const anchors = {}, keepAnchors = {};
    for (const [id, ends] of Object.entries(this.edgeAnchors)) {
      if (!touching.has(id)) { anchors[id] = ends; keepAnchors[id] = ends; }
    }
    const bends = {};
    for (const [id, b] of Object.entries(this.edgeBends)) if (!touching.has(id)) bends[id] = b;
    const result = arrangeLines(edges, byKey, { keepAnchors, keepBends: bends, isHidden: (k) => this.hidden.has(k) });
    this.edgeAnchors = { ...anchors, ...result.anchors };
    this.edgeBends = { ...bends, ...result.bends };
    this.markDirty();
  }

  // After a table, group or line end moves in straight mode: re-route the
  // lines that need it (lines of moved tables, lines whose end left the table
  // edge or that a table now covers, and new lines), and keep every other line
  // exactly where it is.
  async rerouteStraight(movedKeys = null, settled = null) {
    if (!this.isStraightMode()) return null;
    const { tables, edges, anchors } = this._straightInput();
    const byKey = new Map(tables.map((t) => [t.key, t]));
    const visible = tables.filter((t) => !this.hidden.has(t.key));
    const shown = edges.filter((e) => !this.hidden.has(e.fromKey) && !this.hidden.has(e.toKey));
    const fits = (e, p) => !!p && pathStillFits(p, byKey.get(e.fromKey), byKey.get(e.toKey));
    const clear = (e, p) => !pathUnderTables(p.points, visible.filter((t) => t.key !== e.fromKey && t.key !== e.toKey));
    const touches = (e) => !!movedKeys && (movedKeys.has(e.fromKey) || movedKeys.has(e.toKey));
    settled = settled || new Set();

    // 1) lines of the moved tables, routed exactly as while they were dragged
    //    (same lines kept, same inputs), so letting go doesn't change them
    const todo1 = shown.filter((e) => touches(e) && !settled.has(e.id));
    const keep1 = {};
    for (const e of shown) if (!todo1.includes(e) && fits(e, this.edgePaths[e.id])) keep1[e.id] = this.edgePaths[e.id];

    // 2) then every other line that needs it, around those: lines whose end
    //    left the table edge, that a table now covers, that are new, or that
    //    lost the spot of an end the user placed by hand
    const handSpots = [];
    for (const e of shown) {
      if (fits(e, this.edgePaths[e.id]) && !touches(e)) continue;
      for (const end of ['from', 'to']) {
        const hand = anchors[e.id]?.[end];
        const t = byKey.get(end === 'from' ? e.fromKey : e.toKey);
        if (!hand || !t) continue;
        const x = hand.side === 'left' ? t.x : hand.side === 'right' ? t.x + t.w : t.x + t.w * hand.t;
        const y = hand.side === 'top' ? t.y : hand.side === 'bottom' ? t.y + t.h : t.y + t.h * hand.t;
        handSpots.push({ key: t.key, x, y });
      }
    }
    const takesHandSpot = (e, p) => [[e.fromKey, p.points[0]], [e.toKey, p.points.at(-1)]]
      .some(([k, [x, y]]) => handSpots.some((h) => h.key === k && Math.hypot(h.x - x, h.y - y) < 24));

    const run = ++this._straightRun;
    const route = async () => {
      const result = {};
      let failed = [];
      if (todo1.length) {
        const r1 = await this._runStraightWorker({ tables, edges: todo1, anchors, keep: keep1, moved: true });
        Object.assign(result, r1.paths);
        failed = r1.failed;
      }
      if (run !== this._straightRun) return { paths: result, routed: todo1 };
      // a moved table's line that found no free spot: the other lines of
      // that busy table make room by being routed again together with it
      const busy = new Set();
      for (const id of failed) { const e = todo1.find((x) => x.id === id); if (e) { busy.add(e.fromKey); busy.add(e.toKey); } }
      const todo2 = [], keep2 = {};
      for (const e of shown) {
        if (result[e.id]) { keep2[e.id] = result[e.id]; continue; }
        const p = this.edgePaths[e.id];
        const moved = touches(e);
        const ok = fits(e, p) && (moved ? settled.has(e.id) : clear(e, p) && !takesHandSpot(e, p)
          && !((busy.has(e.fromKey) || busy.has(e.toKey)) && p));
        if (ok) keep2[e.id] = p;
        else if (!moved || failed.includes(e.id)) todo2.push(e);
      }
      // a line that never fit anywhere stays as it is, instead of being tried
      // (and reshuffling its neighbours) on every move
      const retry = todo2.filter((e) => this.edgePaths[e.id] || touches(e) || !movedKeys);
      if (retry.length) {
        const r2 = await this._runStraightWorker({ tables, edges: retry, anchors, keep: keep2 });
        Object.assign(result, r2.paths);
      }
      return { paths: result, routed: [...todo1, ...retry] };
    };
    const job = route().then(({ paths, routed }) => {
      // a newer move, an undo, or a switch back to curves happened meanwhile
      if (run !== this._straightRun || !this.isStraightMode()) return null;
      for (const e of routed) delete this.edgePaths[e.id];
      Object.assign(this.edgePaths, paths);
      this.markDirty();
      if (this.onLinesRerouted) this.onLinesRerouted();
      else this.onLayoutChange?.();
      return { routed: Object.keys(paths).length };
    }).catch((err) => { console.error('re-routing straight lines failed', err); return null; });
    this.rerouting = job;                    // lets callers (and tests) wait for it
    job.finally(() => { if (this.rerouting === job) this.rerouting = null; });
    return job;
  }

  clearEdgePaths() {
    if (!Object.keys(this.edgePaths).length) return;
    this._straightRun++;
    this.edgePaths = {};
    this.markDirty();
  }

  setEdgeBends(bends) {
    this.edgeBends = {};
    for (const [id, bend] of Object.entries(bends || {})) {
      if (!Number.isFinite(bend?.x) || !Number.isFinite(bend?.y)) continue;
      this.edgeBends[id] = bend.arranged ? { x: bend.x, y: bend.y, arranged: true } : { x: bend.x, y: bend.y };
    }
    this.markDirty();
  }

  // Arrange lines: choose every line's sides, entry points and bend so lines
  // avoid tables and each other. Lines the user placed or bent by hand keep
  // that; lines from an earlier arrange are arranged again.
  arrangeAllLines() {
    const byKey = this._tableMap();
    const edges = [];
    for (const r of this.model.relations) {
      edges.push({ fromKey: r.fromTable.toLowerCase(), toKey: r.toTable.toLowerCase(), fromCol: r.fromCols[0], toCol: r.toCols[0] });
    }
    for (const l of this.manualLinks) {
      edges.push({ fromKey: l.from.table, toKey: l.to.table, fromCol: l.from.col, toCol: l.to.col });
    }
    // keep only what the user placed by hand, end by end
    const keepAnchors = {};
    for (const [id, ends] of Object.entries(this.edgeAnchors)) {
      const hand = {};
      if (ends.from && !ends.from.arranged) hand.from = ends.from;
      if (ends.to && !ends.to.arranged) hand.to = ends.to;
      if (hand.from || hand.to) keepAnchors[id] = hand;
    }
    const keepBends = Object.fromEntries(Object.entries(this.edgeBends).filter(([, b]) => !b.arranged));
    const result = arrangeLines(edges, byKey, { keepAnchors, keepBends, isHidden: (k) => this.hidden.has(k) });
    this.edgeAnchors = { ...result.anchors, ...keepAnchors };
    this.edgeBends = { ...result.bends, ...keepBends };
    this.edgePaths = {};                           // curved lines replace straight ones
    this._straightRun++;
    this.pinnedEdge = null;
    this.markDirty();
    this.onLayoutChange?.();
    return { arranged: result.arranged, keptByHand: Object.keys(keepAnchors).length };
  }

  // Brings a search result into view: centres on the table (or the column's row),
  // zooms in if it would be too small to read, and marks the column.
  focusSearchResult(key, column = null) {
    const t = this._tableMap().get(key);
    if (!t || !Number.isFinite(t.x)) return false;
    if (this.hidden.has(key)) this.setTableHidden(key, false);
    const scale = Math.max(this.cam.scale, SEARCH_MIN_SCALE);
    const y = column ? t.y + columnY(t, column) : t.y + t.h / 2;
    this.cam = { x: this.viewW / 2 - (t.x + t.w / 2) * scale, y: this.viewH / 2 - y * scale, scale };
    this._setPin(t);
    this.searchMark = { key, column };
    this.markDirty();
    this.onZoom?.(scale);
    return true;
  }

  clearSearchMark() {
    if (!this.searchMark) return;
    this.searchMark = null;
    this.markDirty();
  }

  _drawSearchMark() {
    const mark = this.searchMark;
    if (!mark?.column) return;
    const t = this._tableMap().get(mark.key);
    if (!t || !Number.isFinite(t.x) || this.hidden.has(t.key)) return;
    const { ctx, cam } = this;
    const top = t.y + columnY(t, mark.column) - ROW_H / 2;
    ctx.save();
    ctx.fillStyle = SEARCH_MARK_COLOR;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(t.x + 1, top, t.w - 2, ROW_H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = SEARCH_MARK_COLOR;
    ctx.lineWidth = 2 / cam.scale;
    ctx.strokeRect(t.x + 1, top, t.w - 2, ROW_H);
    ctx.restore();
  }

  setEdgeAnchors(anchors) {
    this.edgeAnchors = {};
    const valid = (a) => ['left', 'right', 'top', 'bottom'].includes(a?.side) && Number.isFinite(a?.t);
    const copy = (a) => (a.arranged ? { side: a.side, t: a.t, arranged: true } : { side: a.side, t: a.t });
    for (const [id, ends] of Object.entries(anchors || {})) {
      const kept = {};
      if (valid(ends?.from)) kept.from = copy(ends.from);
      if (valid(ends?.to)) kept.to = copy(ends.to);
      if (kept.from || kept.to) this.edgeAnchors[id] = kept;
    }
    this.markDirty();
  }

  _clearEdgeAnchor(id, end) {
    const ends = this.edgeAnchors[id];
    if (!ends) return;
    delete ends[end];
    if (!ends.from && !ends.to) delete this.edgeAnchors[id];
  }

  // Which end of the clicked line has its handle at the point.
  _edgeEndAt(sx, sy) {
    const seg = this._pinnedRoute();
    if (!seg) return null;
    const { scale, x: camX, y: camY } = this.cam;
    const near = (wx, wy) => Math.hypot(sx - (wx * scale + camX), sy - (wy * scale + camY)) <= EDGE_END_HIT;
    if (near(seg.fx, seg.fy)) return { seg, end: 'from', tableKey: seg.fromKey };
    if (near(seg.tx, seg.ty)) return { seg, end: 'to', tableKey: seg.toKey };
    return null;
  }

  _pinnedRoute() {
    return this.pinnedEdge ? this.highlightedRoutes.find(seg => seg.id === this.pinnedEdge.id) ?? null : null;
  }

  // The clicked line, when the point is on its bend handle.
  _edgeHandleAt(sx, sy) {
    const seg = this._pinnedRoute();
    if (!seg || seg.path) return null;                // straight lines have no bend handle
    const { x, y } = edgeMidpoint(seg);
    const hx = x * this.cam.scale + this.cam.x;
    const hy = y * this.cam.scale + this.cam.y;
    return Math.hypot(sx - hx, sy - hy) <= EDGE_HANDLE_HIT ? seg : null;
  }

  // The clicked manual link, when the point is on its delete button.
  _edgeDeleteAt(sx, sy) {
    const seg = this._pinnedRoute();
    if (!seg?.manual) return null;
    const { x, y } = routeMidpoint(seg);
    const bx = x * this.cam.scale + this.cam.x + EDGE_DELETE_OFFSET;
    const by = y * this.cam.scale + this.cam.y;
    return Math.hypot(sx - bx, sy - by) <= EDGE_DELETE_R + 2 ? seg : null;
  }

  _drawEdgeHandle() {
    const seg = this._pinnedRoute();
    if (!seg) return;
    const { ctx, cam, theme } = this;
    const s = 1 / cam.scale;
    const { x, y } = routeMidpoint(seg);
    ctx.save();
    for (const [ex, ey, pinned] of [[seg.fx, seg.fy, seg.fromPinned], [seg.tx, seg.ty, seg.toPinned]]) {
      ctx.beginPath();
      ctx.arc(ex, ey, EDGE_END_R * s, 0, Math.PI * 2);
      ctx.fillStyle = pinned ? theme.edgeHi : theme.tableBg;    // filled once moved by hand
      ctx.fill();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = pinned ? theme.tableBg : theme.edgeHi;
      ctx.stroke();
    }
    if (!seg.path) {                                 // bend handle, for curved lines
      ctx.beginPath();
      ctx.arc(x, y, EDGE_HANDLE_R * s, 0, Math.PI * 2);
      ctx.fillStyle = theme.edgeHi;
      ctx.fill();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = theme.tableBg;
      ctx.stroke();
    }
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = theme.tableBg;

    if (seg.manual) {
      const bx = x + EDGE_DELETE_OFFSET * s;
      const arm = 3.5 * s;
      ctx.beginPath();
      ctx.arc(bx, y, EDGE_DELETE_R * s, 0, Math.PI * 2);
      ctx.fillStyle = EDGE_DELETE_COLOR;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx - arm, y - arm); ctx.lineTo(bx + arm, y + arm);
      ctx.moveTo(bx + arm, y - arm); ctx.lineTo(bx - arm, y + arm);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6 * s;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawEdges(vx0, vy0, vx1, vy1) {
    const { theme } = this;
    const routes = this._routes();
    // where straight lines cross, the horizontal one jumps over the other
    const straight = routes.filter((seg) => seg.path).map((seg) => ({ id: seg.id, points: seg.path }));
    this._jumps = straight.length ? pathJumps(straight, JUMP_RADIUS + 1) : null;
    if (this.pinnedEdge && !routes.some(seg => seg.id === this.pinnedEdge.id)) this.pinnedEdge = null;

    const pinnedEdgeId = this.pinnedEdge?.id ?? null;
    const focus = pinnedEdgeId ? null : this.focus;
    const focusKey = focus ? focus.key : null;
    const hoverEdge = pinnedEdgeId ?? (focusKey ? null : this.hoverEdge);
    const fadeAlpha = this.pinned || pinnedEdgeId ? 0.05 : 0.16;   // pinned fades harder than transient hover
    const highlighted = [];

    for (const seg of routes) {
      const xs = seg.path ? seg.path.map((p) => p[0]) : [seg.fx, seg.c1x, seg.c2x, seg.tx];
      const ys = seg.path ? seg.path.map((p) => p[1]) : [seg.fy, seg.c1y, seg.c2y, seg.ty];
      if (Math.max(...xs) < vx0 || Math.min(...xs) > vx1 || Math.max(...ys) < vy0 || Math.min(...ys) > vy1) continue;
      const connected = focusKey
        ? seg.fromKey === focusKey || seg.toKey === focusKey
        : seg.id === hoverEdge;
      if (connected) {
        highlighted.push(seg);
      } else if (focusKey || hoverEdge) {
        this._stroke(seg, theme.edge, 1.2, fadeAlpha, seg.manual);
      } else {
        this._stroke(seg, theme.edge, 1.5, 0.5, seg.manual);
      }
    }
    for (const seg of highlighted) this._stroke(seg, theme.edgeHi, 2.2, 1, seg.manual);
    for (const seg of highlighted) this._drawEdgeLabel(seg);   // words, on top of the lines
    this.highlightedRoutes = highlighted;
  }

  // Marks the exact columns a highlighted line joins, since a line entering
  // through a top or bottom edge can't point at a row.
  _drawLinkedColumns() {
    const { ctx, theme } = this;
    const byKey = this._tableMap();
    const mark = (key, column) => {
      const t = byKey.get(key);
      if (!t || !column || !t.columns.some(c => c.name.toLowerCase() === String(column).toLowerCase())) return;
      ctx.fillRect(t.x + 1, t.y + columnY(t, column) - ROW_H / 2, t.w - 2, ROW_H);
    };
    ctx.save();
    ctx.fillStyle = theme.edgeHi;
    ctx.globalAlpha = 0.22;
    for (const seg of this.highlightedRoutes) {
      mark(seg.fromKey, seg.fromCol);
      mark(seg.toKey, seg.toCol);
    }
    ctx.restore();
  }

  // The line closest to the cursor, within reach, or null.
  _edgeAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    const tol = EDGE_HIT / this.cam.scale;
    let nearest = null;
    let nearestDistance = tol;
    for (const seg of this._routes()) {
      const distance = segDistance(seg, w.x, w.y);
      if (distance <= nearestDistance) {
        nearest = seg;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  _stroke(seg, color, width, alpha, dashed) {
    const { ctx, cam } = this;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width / cam.scale;
    if (dashed) ctx.setLineDash([6 / cam.scale, 5 / cam.scale]);
    ctx.beginPath();
    if (seg.path) {
      tracePath(ctx, seg.path, this._jumps?.[seg.id]);
    } else {
      ctx.moveTo(seg.fx, seg.fy);
      ctx.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.tx, seg.ty);
    }
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
    if (seg.card) {
      // markers sit just outside each table, pointing along the line
      const s = 1 / cam.scale;
      const mw = Math.max(width, 1.4) / cam.scale;
      drawMarker(ctx, seg.fx, seg.fy, seg.fromDir, seg.card.from, s, mw, seg.fromVertical);
      drawMarker(ctx, seg.tx, seg.ty, seg.toDir, seg.card.to, s, mw, seg.toVertical);
    } else {
      dot(ctx, seg.fx, seg.fy, 3 / cam.scale);
      dot(ctx, seg.tx, seg.ty, 3 / cam.scale);
    }
    ctx.globalAlpha = 1;
  }

  // A small "one-to-many" pill at a highlighted edge's midpoint.
  _drawEdgeLabel(seg) {
    if (!seg.card || !seg.card.label) return;
    const { ctx, cam } = this;
    const s = 1 / cam.scale;
    const middle = routeMidpoint(seg);
    const mx = middle.x;
    // leave room for the bend handle on a clicked line
    const my = middle.y - (seg.id === this.pinnedEdge?.id ? 24 * s : 0);
    ctx.save();
    ctx.font = `${11 * s}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = seg.card.label;
    const w = ctx.measureText(text).width + 10 * s;
    const h = 16 * s;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = this.theme.tableBg;
    roundRectPath(ctx, mx - w / 2, my - h / 2, w, h, 5 * s);
    ctx.fill();
    ctx.strokeStyle = this.theme.edgeHi;
    ctx.lineWidth = 1 * s;
    ctx.stroke();
    ctx.fillStyle = this.theme.edgeHi;
    ctx.fillText(text, mx, my);
    ctx.restore();
  }

  _tableMap() {
    if (!this._tmapDirty && this._tmap && this._tmap.size === this.model.tables.length) {
      return this._tmap;
    }
    this._tmap = new Map(this.model.tables.map(t => [t.key, t]));
    this._tmapDirty = false;
    return this._tmap;
  }

  // ---- hit testing ----
  tableAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    const tables = this.model.tables;
    for (let i = tables.length - 1; i >= 0; i--) {
      const t = tables[i];
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      if (w.x >= t.x && w.x <= t.x + t.w && w.y >= t.y && w.y <= t.y + t.h) return t;
    }
    return null;
  }

  // ---- input ----
  _bindInput() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;   // ignore right/middle click (right-click = context menu)
      const r = c.getBoundingClientRect();
      this._pointerDown(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
      c.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (this._pointerMove(sx, sy)) return;   // active drag/pan handled it
      // idle hover (mouse only)
      const t = this.tableAt(sx, sy);
      if (t !== this.hover) { this.hover = t; this.markDirty(); }
      const edgeId = t ? null : (this._edgeAt(sx, sy)?.id ?? null);
      if (edgeId !== this.hoverEdge) { this.hoverEdge = edgeId; this.markDirty(); }
      // connector dots on the hovered column row
      let conn = null;
      if (t) {
        const w = this.screenToWorld(sx, sy);
        const idx = Math.floor((w.y - t.y - HEADER_H) / ROW_H);
        if (idx >= 0 && idx < t.columns.length) conn = { t, colIndex: idx };
      }
      const changed = (conn?.t !== this.hoverConn?.t) || (conn?.colIndex !== this.hoverConn?.colIndex);
      if (changed) { this.hoverConn = conn; this.markDirty(); }
      if (this._connectorAt(sx, sy)) c.style.cursor = 'crosshair';
      else if (this._annoChromeAt(sx, sy) || this._addButtonAt(sx, sy)) c.style.cursor = 'pointer';
      else if (this._edgeDeleteAt(sx, sy)) c.style.cursor = 'pointer';
      else if (this._edgeHandleAt(sx, sy) || this._edgeEndAt(sx, sy) || this._noteAt(sx, sy)) c.style.cursor = 'grab';
      else if (this._groupLabelAt(sx, sy)) c.style.cursor = 'move';
      else if (t) c.style.cursor = 'grab';
      else if (edgeId) c.style.cursor = 'pointer';
      else c.style.cursor = 'default';
    });

    window.addEventListener('mouseup', () => {
      this._pointerUp();
      c.style.cursor = this.hover ? 'grab' : 'default';
    });

    // ---- touch (mobile): 1 finger = drag/pan, 2 fingers = pinch-zoom + pan ----
    let pinch = null;
    let tap = null;
    let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
    const tpos = (t) => { const r = c.getBoundingClientRect(); return { sx: t.clientX - r.left, sy: t.clientY - r.top }; };

    c.addEventListener('touchstart', (e) => {
      this._cancelEdit();
      if (e.touches.length === 1) {
        pinch = null;
        const p = tpos(e.touches[0]);
        tap = { sx: p.sx, sy: p.sy, moved: false };
        this._pointerDown(p.sx, p.sy, false, false);
      } else if (e.touches.length === 2) {
        this.drag = this.pan = this.annoDrag = this.annoResize = this.edgeDrag = this.edgeEndDrag = null;   // cancel single-finger
        tap = null;
        const a = tpos(e.touches[0]), b = tpos(e.touches[1]);
        pinch = { dist: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
      }
      e.preventDefault();
    }, { passive: false });

    c.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length >= 2) {
        const a = tpos(e.touches[0]), b = tpos(e.touches[1]);
        const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
        const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
        const newScale = clamp(this.cam.scale * (dist / pinch.dist), 0.08, 4);
        const k = newScale / this.cam.scale;
        this.cam.x = mx - (mx - this.cam.x) * k;          // zoom around the pinch midpoint
        this.cam.y = my - (my - this.cam.y) * k;
        this.cam.x += mx - pinch.mx;                       // + two-finger pan
        this.cam.y += my - pinch.my;
        this.cam.scale = newScale;
        pinch.dist = dist; pinch.mx = mx; pinch.my = my;
        this.markDirty();
        this.onZoom?.(newScale);
      } else if (tap && e.touches.length === 1) {
        const p = tpos(e.touches[0]);
        if (Math.abs(p.sx - tap.sx) + Math.abs(p.sy - tap.sy) > 8) tap.moved = true;
        this._pointerMove(p.sx, p.sy);
      }
      e.preventDefault();
    }, { passive: false });

    c.addEventListener('touchend', (e) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        this.onLayoutChange?.();
        if (e.touches.length === 1) {                      // dropped to one finger -> resume pan
          const p = tpos(e.touches[0]);
          tap = { sx: p.sx, sy: p.sy, moved: true };
          this._pointerDown(p.sx, p.sy, false, false);
        }
        return;
      }
      if (e.touches.length > 0) return;
      // double-tap (no drag) => edit
      if (tap && !tap.moved) {
        const now = performance.now();
        if (now - lastTapAt < 320 && Math.abs(tap.sx - lastTapX) + Math.abs(tap.sy - lastTapY) < 28) {
          this.drag = this.pan = null;     // don't also pin
          this._editAt(tap.sx, tap.sy);
          lastTapAt = 0; tap = null;
          return;
        }
        lastTapAt = now; lastTapX = tap.sx; lastTapY = tap.sy;
      }
      this._pointerUp();
      tap = null;
    }, { passive: false });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._cancelEdit();
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      // ctrl/cmd or pinch => zoom; otherwise treat as zoom too (diagram tool)
      const factor = Math.exp(-e.deltaY * 0.0015);
      this._zoomAt(sx, sy, factor);
    }, { passive: false });

    // double-click: edit annotation text, else a table/column, else zoom in
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      this._editAt(e.clientX - r.left, e.clientY - r.top);
    });
  }

  // ---- shared pointer logic (used by both mouse and touch) ----
  // `additive` (Shift) drives multi-select: Shift+click toggles a table,
  // Shift+drag on empty draws a marquee box.
  _pointerDown(sx, sy, additive = false, allowConnect = true) {
    this.pressEdge = null;
    // 0) the delete button and bend handle of the clicked line
    const deleteSeg = this._edgeDeleteAt(sx, sy);
    if (deleteSeg) { this.removeManualLink(deleteSeg.link); return; }
    const handleSeg = this._edgeHandleAt(sx, sy);
    if (handleSeg) {
      const w = this.screenToWorld(sx, sy);
      const middle = edgeMidpoint(handleSeg);
      this.edgeDrag = {
        id: handleSeg.id,
        baseX: middle.x - handleSeg.bendX,
        baseY: middle.y - handleSeg.bendY,
        grabX: w.x - middle.x,
        grabY: w.y - middle.y,
        moved: false,
      };
      return;
    }
    const endHit = this._edgeEndAt(sx, sy);
    if (endHit) {
      // a straight line is drawn as a simple right angle while its end moves,
      // then re-routed when it's dropped
      const savedPath = this.edgePaths[endHit.seg.id];
      delete this.edgePaths[endHit.seg.id];
      this.edgeEndDrag = { id: endHit.seg.id, end: endHit.end, tableKey: endHit.tableKey, moved: false, savedPath };
      return;
    }
    // 1) chrome of the selected annotation (colour dots / delete / resize)
    const chrome = this._annoChromeAt(sx, sy);
    if (chrome) {
      const a = this.selectedAnno;
      if (chrome.kind === 'color') { a.color = chrome.value; this.markDirty(); this.onLayoutChange?.(); }
      else if (chrome.kind === 'custom') { this.onPickColor?.(a, sx, sy); }
      else if (chrome.kind === 'delete') { this.deleteSelectedAnnotation(); }
      else if (chrome.kind === 'resize') {
        const w = this.screenToWorld(sx, sy);
        this.annoResize = { a, ox: w.x - (a.x + a.w), oy: w.y - (a.y + a.h), moved: false };
      }
      return;
    }
    // 1b) a column connector dot -> start drawing a manual link
    if (allowConnect) {
      const conn = this._connectorAt(sx, sy);
      if (conn) {
        this.linking = { fromKey: conn.tableKey, fromCol: conn.col, side: conn.side, wx: conn.wx, wy: conn.wy, cx: conn.wx, cy: conn.wy };
        this.markDirty();
        return;
      }
    }
    // 2) "+ add column" button under the pinned table
    if (this._addButtonAt(sx, sy)) { this.onAddColumn?.(this.pinned.key); return; }
    // 3) a sticky note (notes sit on top, grabbable anywhere)
    const note = this._noteAt(sx, sy);
    if (note) { this._grabAnno(note, sx, sy); return; }
    // 3b) a group's name is the only handle that moves the group, and it is
    // drawn above the tables, so it is checked first
    if (!additive) {
      const groupLabel = this._groupLabelAt(sx, sy);
      if (groupLabel) { this._grabAnno(groupLabel, sx, sy); return; }
    }
    // 4) a table
    const t = this.tableAt(sx, sy);
    if (t) {
      if (this.selectedAnno) this.selectedAnno = null;
      if (additive) {                                   // Shift+click toggles selection
        if (this.selected.has(t)) this.selected.delete(t);
        else this.selected.add(t);
        this.pinned = null; this.pinnedKeys = null;
        this.markDirty();
        this.onSelectionChange?.();
        return;
      }
      const idx = this.model.tables.indexOf(t);
      this.model.tables.splice(idx, 1);
      this.model.tables.push(t);
      const w = this.screenToWorld(sx, sy);
      if (this.selected.has(t) && this.selected.size > 1) {
        // drag the whole current selection together
        const items = [...this.selected].filter(x => Number.isFinite(x.x))
          .map(x => ({ t: x, sx0: x.x, sy0: x.y }));
        this.dragGroup = { items, ax: w.x, ay: w.y, moved: false };
      } else {
        this.selected = new Set([t]);
        this.drag = { t, dx: w.x - t.x, dy: w.y - t.y, moved: false };
        this.onSelectionChange?.();
      }
      this.markDirty();
      return;
    }
    // 4b) a relation line: a click pins it, a drag pans
    if (!additive) {
      const edge = this._edgeAt(sx, sy);
      if (edge) {
        if (this.selectedAnno) { this.selectedAnno = null; this.markDirty(); }
        this.pressEdge = edge;
        this.pan = { sx, sy, camx: this.cam.x, camy: this.cam.y, moved: false };
        return;
      }
    }
    // 5) empty space or a group's body -> Shift+drag marquee-selects; otherwise pan
    if (this.selectedAnno) { this.selectedAnno = null; this.markDirty(); }
    const w = this.screenToWorld(sx, sy);
    if (additive) {
      this.marquee = { ax: w.x, ay: w.y, x: w.x, y: w.y };
    } else {
      this.pan = { sx, sy, camx: this.cam.x, camy: this.cam.y, moved: false };
    }
  }

  _columnAtWorld(wx, wy) {
    for (let i = this.model.tables.length - 1; i >= 0; i--) {
      const t = this.model.tables[i];
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      if (wx >= t.x && wx <= t.x + t.w && wy >= t.y && wy <= t.y + t.h) {
        const idx = Math.floor((wy - t.y - HEADER_H) / ROW_H);
        if (idx >= 0 && idx < t.columns.length) return { tableKey: t.key, col: t.columns[idx].name };
        return null;
      }
    }
    return null;
  }

  // returns true if an active drag/pan/resize consumed the move
  _pointerMove(sx, sy) {
    if (this.edgeEndDrag) {
      const drag = this.edgeEndDrag;
      const table = this._tableMap().get(drag.tableKey);
      if (table) {
        const w = this.screenToWorld(sx, sy);
        this.edgeAnchors[drag.id] = { ...this.edgeAnchors[drag.id], [drag.end]: anchorForPoint(table, w.x, w.y) };
        drag.moved = true;
        this.markDirty();
      }
      return true;
    }
    if (this.edgeDrag) {
      const w = this.screenToWorld(sx, sy);
      const drag = this.edgeDrag;
      this.edgeBends[drag.id] = { x: w.x - drag.grabX - drag.baseX, y: w.y - drag.grabY - drag.baseY };
      drag.moved = true;
      this.markDirty();
      return true;
    }
    if (this.linking) {
      const w = this.screenToWorld(sx, sy);
      this.linking.cx = w.x; this.linking.cy = w.y;
      this.markDirty();
      return true;
    }
    if (this.dragGroup) {
      const w = this.screenToWorld(sx, sy);
      const dx = w.x - this.dragGroup.ax, dy = w.y - this.dragGroup.ay;
      for (const it of this.dragGroup.items) { it.t.x = it.sx0 + dx; it.t.y = it.sy0 + dy; }
      this.dragGroup.moved = true;
      this.markDirty();
      this._scheduleLiveRoute();
      return true;
    }
    if (this.marquee) {
      const w = this.screenToWorld(sx, sy);
      this.marquee.x = w.x; this.marquee.y = w.y;
      this.markDirty();
      return true;
    }
    if (this.annoResize) {
      const w = this.screenToWorld(sx, sy);
      const a = this.annoResize.a;
      a.w = Math.max(a.type === 'group' ? 120 : 80, w.x - this.annoResize.ox - a.x);
      a.h = Math.max(a.type === 'group' ? 90 : 50, w.y - this.annoResize.oy - a.y);
      this.annoResize.moved = true;
      this.markDirty();
      return true;
    }
    if (this.annoDrag) {
      const w = this.screenToWorld(sx, sy);
      this.annoDrag.a.x = w.x - this.annoDrag.dx;
      this.annoDrag.a.y = w.y - this.annoDrag.dy;
      const moveX = this.annoDrag.a.x - this.annoDrag.x0;
      const moveY = this.annoDrag.a.y - this.annoDrag.y0;
      for (const item of this.annoDrag.tables) {
        item.t.x = item.x0 + moveX;
        item.t.y = item.y0 + moveY;
      }
      this.annoDrag.moved = true;
      this.markDirty();
      if (this.annoDrag.tables.length) this._scheduleLiveRoute();
      return true;
    }
    if (this.drag) {
      const w = this.screenToWorld(sx, sy);
      this.drag.t.x = w.x - this.drag.dx;
      this.drag.t.y = w.y - this.drag.dy;
      this.drag.moved = true;
      this.markDirty();
      this._scheduleLiveRoute();
      return true;
    }
    if (this.pan) {
      this.cam.x = this.pan.camx + (sx - this.pan.sx);
      this.cam.y = this.pan.camy + (sy - this.pan.sy);
      if (Math.abs(sx - this.pan.sx) + Math.abs(sy - this.pan.sy) > 3) this.pan.moved = true;
      this.markDirty();
      return true;
    }
    return false;
  }

  _pointerUp() {
    const movedKeys = this._movingKeys();     // before the drag state is cleared
    const livePaths = this._livePaths;
    this._stopLiveRoute();
    if (this.edgeEndDrag) {
      const { moved, id, savedPath } = this.edgeEndDrag;
      this.edgeEndDrag = null;
      if (moved) { this.onLayoutChange?.(); this.rerouteStraight(); }
      else if (savedPath) { this.edgePaths[id] = savedPath; this.markDirty(); }
      return;
    }
    if (this.edgeDrag) {
      const moved = this.edgeDrag.moved;
      this.edgeDrag = null;
      if (moved) this.onLayoutChange?.();
      return;
    }
    // finishing a link drag -> create the link if dropped on a column
    if (this.linking) {
      const k = this.linking;
      this.linking = null;
      const tgt = this._columnAtWorld(k.cx, k.cy);
      if (tgt) this.addManualLink(k.fromKey, k.fromCol, tgt.tableKey, tgt.col);
      this.markDirty();
      return;
    }
    // marquee end -> select tables intersecting the box (union with current)
    if (this.marquee) {
      const m = this.marquee;
      const x0 = Math.min(m.ax, m.x), x1 = Math.max(m.ax, m.x);
      const y0 = Math.min(m.ay, m.y), y1 = Math.max(m.ay, m.y);
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        for (const t of this.model.tables) {
          if (Number.isFinite(t.x) && t.x < x1 && t.x + t.w > x0 && t.y < y1 && t.y + t.h > y0) {
            this.selected.add(t);
          }
        }
        this.pinned = null; this.pinnedKeys = null;
      }
      this.marquee = null;
      this.markDirty();
      this.onSelectionChange?.();
      return;
    }
    if (this.dragGroup) {
      if (this.dragGroup.moved) { this._linesAfterMove(movedKeys, livePaths); this.onLayoutChange?.(); }
      this.dragGroup = null;
      return;
    }
    // a click (no drag) on a table or line pins focus; a click elsewhere clears it
    if (this.drag && !this.drag.moved) this._pin(this.drag.t);
    else if (this.pan && !this.pan.moved) {
      if (this.selected.size) { this.selected = new Set(); this.markDirty(); this.onSelectionChange?.(); }
      if (this.pressEdge) this._pinEdge(this.pressEdge);
      else {
        if (this.pinned) this._pin(this.pinned);
        this._clearPinnedEdge();
      }
    } else if (this.annoDrag && !this.annoDrag.moved) {
      this._clearPinnedEdge();
    }
    this.pressEdge = null;
    const changed = (this.drag && this.drag.moved) || (this.pan && this.pan.moved) ||
                    (this.annoDrag && this.annoDrag.moved) || (this.annoResize && this.annoResize.moved);
    // tables moved (one table, or a group dragged by its name): re-route lines
    this._linesAfterMove(movedKeys, livePaths);
    this.drag = null;
    this.pan = null;
    this.annoDrag = null;
    this.annoResize = null;
    if (changed) this.onLayoutChange?.();
  }

  clearSelection() {
    if (this.selected.size) { this.selected = new Set(); this.markDirty(); this.onSelectionChange?.(); }
  }

  // ---- hide / show tables ----
  // Hide a table; if it's part of a multi-selection, hide the whole selection.
  hideTable(t) {
    let keys;
    if (t && this.selected.has(t) && this.selected.size > 1) keys = [...this.selected].map(x => x.key);
    else if (t) keys = [t.key];
    else keys = [...this.selected].map(x => x.key);
    if (!keys.length) return;
    for (const k of keys) this.hidden.add(k);
    this.selected = new Set();
    this.pinned = null; this.pinnedKeys = null;
    this.markDirty();
    this.onHiddenChange?.();
    this.onSelectionChange?.();
    this.onLayoutChange?.();
  }

  showAllHidden() {
    if (!this.hidden.size) return;
    this.hidden = new Set();
    this.markDirty();
    this.onHiddenChange?.();
    this.onLayoutChange?.();
  }

  setHidden(keys) {
    this.hidden = new Set(Array.isArray(keys) ? keys : []);
    this.markDirty();
    this.onHiddenChange?.();
  }

  hiddenCount() { return this.hidden.size; }

  // bulk hide/show a list of keys (used by the Tables panel "Hide all"/"Show all")
  setTablesHidden(keys, hidden) {
    let changed = false;
    for (const k of keys) {
      if (hidden) { if (!this.hidden.has(k)) { this.hidden.add(k); changed = true; } }
      else if (this.hidden.delete(k)) changed = true;
    }
    if (!changed) return;
    this.markDirty();
    this.onHiddenChange?.();
    this.onLayoutChange?.();
  }

  // ---- driven by the Tables panel ----
  setTableHidden(key, hidden) {
    if (hidden) this.hidden.add(key); else this.hidden.delete(key);
    this.markDirty();
    this.onHiddenChange?.();
    this.onLayoutChange?.();
  }

  selectByKey(key, on) {
    const t = this.model.tables.find(x => x.key === key);
    if (!t) return;
    if (on) this.selected.add(t); else this.selected.delete(t);
    this.markDirty();
    this.onSelectionChange?.();
  }

  isSelected(key) {
    for (const t of this.selected) if (t.key === key) return true;
    return false;
  }

  // centre the camera on a table (and pin it for focus)
  centerOn(key) {
    const t = this.model.tables.find(x => x.key === key);
    if (!t || !Number.isFinite(t.x)) return;
    if (this.hidden.has(key)) this.setTableHidden(key, false);
    const s = this.cam.scale;
    this.cam.x = this.viewW / 2 - (t.x + t.w / 2) * s;
    this.cam.y = this.viewH / 2 - (t.y + t.h / 2) * s;
    this._setPin(t);
    this.markDirty();
  }

  // ---- manual links ----
  // a connector dot under the cursor (to start a link), or null
  _connectorAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    const r = 7 / this.cam.scale;
    for (let i = this.model.tables.length - 1; i >= 0; i--) {
      const t = this.model.tables[i];
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      const ly = w.y - t.y;
      if (ly < HEADER_H) continue;
      const idx = Math.floor((ly - HEADER_H) / ROW_H);
      if (idx < 0 || idx >= t.columns.length) continue;
      for (const p of this._connDots(t, idx)) {
        if (Math.hypot(w.x - p.x, w.y - p.y) <= r * 1.5) {
          return { tableKey: t.key, col: t.columns[idx].name, side: p.side, wx: p.x, wy: p.y };
        }
      }
    }
    return null;
  }

  // the table + column under the cursor (link target), or null
  _columnAt(sx, sy) {
    const t = this.tableAt(sx, sy);
    if (!t) return null;
    const w = this.screenToWorld(sx, sy);
    const idx = Math.floor((w.y - t.y - HEADER_H) / ROW_H);
    if (idx < 0 || idx >= t.columns.length) return null;
    return { tableKey: t.key, col: t.columns[idx].name };
  }

  _linkExists(fk, fc, tk, tc) {
    const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
    const has = (l) => (eq(l.from.table, fk) && eq(l.from.col, fc) && eq(l.to.table, tk) && eq(l.to.col, tc)) ||
                       (eq(l.from.table, tk) && eq(l.from.col, tc) && eq(l.to.table, fk) && eq(l.to.col, fc));
    return this.manualLinks.some(has);
  }

  addManualLink(fk, fc, tk, tc) {
    if (fk === tk) return false;                  // a drag within one table is a slip, not a relation
    if (this._linkExists(fk, fc, tk, tc)) return false;
    this.manualLinks.push({ from: { table: fk, col: fc }, to: { table: tk, col: tc } });
    this.markDirty();
    this.onLayoutChange?.();
    this.rerouteStraight();
    return true;
  }

  setManualLinks(arr) {
    this.manualLinks = Array.isArray(arr) ? arr.filter(l => l && l.from && l.to) : [];
    this.markDirty();
  }

  // manual link whose curve passes near the point (for right-click delete)
  linkAt(sx, sy) {
    const w = this.screenToWorld(sx, sy);
    const tol = 7 / this.cam.scale;
    for (const seg of this._routes()) {
      if (seg.manual && segNear(seg, w.x, w.y, tol)) return seg.link;
    }
    return null;
  }

  removeManualLink(link) {
    const i = this.manualLinks.indexOf(link);
    if (i < 0) return;
    this.manualLinks.splice(i, 1);
    const id = `${link.from.table}.${link.from.col}>${link.to.table}.${link.to.col}`;
    delete this.edgeBends[id];
    delete this.edgeAnchors[id];
    delete this.edgePaths[id];
    if (this.pinnedEdge?.id === id) this.pinnedEdge = null;
    this.markDirty();
    this.onLayoutChange?.();
  }

  // Manual links touching a table, for the table's right-click menu.
  manualLinksOf(key) {
    return this.manualLinks.filter(l => l.from.table === key || l.to.table === key);
  }

  // Removes the clicked line if it is a manual link. Returns whether it did.
  removePinnedLink() {
    const seg = this._pinnedRoute();
    if (!seg?.manual) return false;
    this.removeManualLink(seg.link);
    return true;
  }

  clearManualLinks() {
    if (!this.manualLinks.length) return;
    this.manualLinks = [];
    this.markDirty();
    this.onLayoutChange?.();
  }

  manualLinkCount() { return this.manualLinks.length; }

  // heuristic auto-linking by column name; returns count added
  inferLinks() {
    // Shared heuristic (see infer-links.js). It dedupes against model.relations
    // and our manual links, and returns new links in relation shape; adapt them
    // to the manual-link shape this diagram stores.
    const added = inferLinksCore(this.model, this.manualLinks).map(r => ({
      from: { table: r.fromTable, col: r.fromCols[0] },
      to: { table: r.toTable, col: r.toCols[0] },
    }));
    this.manualLinks.push(...added);
    if (added.length) { this.markDirty(); this.onLayoutChange?.(); }
    return added.length;
  }

  // edit whatever is under the point: annotation text, a table/column, else zoom in
  _editAt(sx, sy) {
    const bent = this._edgeHandleAt(sx, sy);
    if (bent) {                                   // double-click the handle to straighten the line
      delete this.edgeBends[bent.id];
      this.markDirty();
      this.onLayoutChange?.();
      return;
    }
    const endHit = this._edgeEndAt(sx, sy);
    if (endHit) {                                 // double-click an end to make it automatic again
      this._clearEdgeAnchor(endHit.seg.id, endHit.end);
      this.markDirty();
      this.onLayoutChange?.();
      return;
    }
    const t = this.tableAt(sx, sy);
    const anno = (!t && this._noteAt(sx, sy)) || this._groupLabelAt(sx, sy);
    if (anno) { this.selectedAnno = anno; this._beginEditAnnotation(anno); this.markDirty(); return; }
    const target = this._editTargetAt(sx, sy);
    if (target) { this._beginEdit(target); return; }
    this._zoomAt(sx, sy, 1.6);
  }

  // What's under the cursor for editing: the table name (header), a column
  // name (left of a row) or a column type (right of a row).
  _editTargetAt(sx, sy) {
    if (!this.editable) return null;   // parse-only formats: no edit-back
    const t = this.tableAt(sx, sy);
    if (!t) return null;
    const w = this.screenToWorld(sx, sy);
    const ly = w.y - t.y;
    if (ly < HEADER_H) {
      return { table: t, kind: 'table', rect: { x: t.x, y: t.y, w: t.w, h: HEADER_H }, align: 'left', weight: 600 };
    }
    const idx = Math.floor((ly - HEADER_H) / ROW_H);
    if (idx < 0 || idx >= t.columns.length) return null;
    const col = t.columns[idx];
    const rowY = t.y + HEADER_H + idx * ROW_H;
    const split = t.x + t.w * 0.58;
    if (w.x >= split && col.type) {
      return { table: t, kind: 'column-type', colName: col.name, value: col.typeRaw || col.type,
               rect: { x: split, y: rowY, w: t.x + t.w - split, h: ROW_H }, align: 'right', weight: 400 };
    }
    return { table: t, kind: 'column-name', colName: col.name, value: col.name,
             rect: { x: t.x + 30, y: rowY, w: split - (t.x + 30), h: ROW_H }, align: 'left', weight: 400 };
  }

  _beginEdit(target) {
    this._cancelEdit();
    const { rect } = target;
    const { cam } = this;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.value = target.kind === 'table' ? target.table.name : (target.value ?? '');
    // position over the cell in screen pixels
    const sx = rect.x * cam.scale + cam.x;
    const sy = rect.y * cam.scale + cam.y;
    input.style.left = sx + 'px';
    input.style.top = sy + 'px';
    input.style.width = Math.max(40, rect.w * cam.scale) + 'px';
    input.style.height = rect.h * cam.scale + 'px';
    input.style.fontSize = Math.max(9, 13 * cam.scale) + 'px';
    input.style.textAlign = target.align;
    input.style.fontWeight = target.weight;

    const parent = this.canvas.parentElement;
    // dialect-aware type suggestions
    let datalist = null;
    if (target.kind === 'column-type' && this.typeSuggestions.length) {
      datalist = document.createElement('datalist');
      datalist.id = 'type-suggestions';
      for (const ty of this.typeSuggestions) {
        const opt = document.createElement('option');
        opt.value = ty;
        datalist.appendChild(opt);
      }
      parent.appendChild(datalist);
      input.setAttribute('list', 'type-suggestions');
    }
    parent.appendChild(input);
    input.focus();
    input.select();

    const commit = () => this._commitEdit();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    this.editing = { target, input, datalist };
  }

  _commitEdit() {
    if (!this.editing) return;
    const { target, input, datalist } = this.editing;
    const value = input.value.trim();
    this.editing = null;
    input.remove();
    datalist?.remove();
    const old = target.kind === 'table' ? target.table.name : target.value;
    if (value && value !== old && this.onEdit) {
      this.onEdit({ kind: target.kind, tableKey: target.table.key, colName: target.colName, value });
    }
  }

  _cancelEdit() {
    if (!this.editing) return;
    const { input, datalist } = this.editing;
    this.editing = null;
    input.remove();
    datalist?.remove();
  }

  _zoomAt(sx, sy, factor) {
    const newScale = clamp(this.cam.scale * factor, 0.08, 4);
    const k = newScale / this.cam.scale;
    this.cam.x = sx - (sx - this.cam.x) * k;
    this.cam.y = sy - (sy - this.cam.y) * k;
    this.cam.scale = newScale;
    this.markDirty();
    this.onZoom?.(newScale);
    this.onLayoutChange?.();
  }

  // restore a saved camera ({x, y, scale})
  setCamera(cam) {
    if (!cam) return;
    this.cam = { x: cam.x, y: cam.y, scale: cam.scale };
    this.markDirty();
    this.onZoom?.(cam.scale);
  }

  zoomBy(factor) {
    this._zoomAt(this.viewW / 2, this.viewH / 2, factor);
  }

  resetZoom() {
    this._zoomAt(this.viewW / 2, this.viewH / 2, 1 / this.cam.scale);
  }

  // fit all tables into view
  fit(padding = 60) {
    const ts = this.model.tables.filter(t => Number.isFinite(t.x));
    if (!ts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of ts) {
      x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
    }
    const bw = x1 - x0, bh = y1 - y0;
    const scale = clamp(Math.min(
      (this.viewW - padding * 2) / bw,
      (this.viewH - padding * 2) / bh,
    ), 0.08, 1.5);
    this.cam.scale = scale;
    this.cam.x = (this.viewW - bw * scale) / 2 - x0 * scale;
    this.cam.y = (this.viewH - bh * scale) / 2 - y0 * scale;
    this.markDirty();
    this.onZoom?.(scale);
  }

  // ---- export ----
  bounds(padding = 40) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of this.model.tables) {
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
    }
    for (const a of this.annotations) {
      x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
      x1 = Math.max(x1, a.x + a.w); y1 = Math.max(y1, a.y + a.h);
    }
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
    return {
      x0: x0 - padding, y0: y0 - padding,
      x1: x1 + padding, y1: y1 + padding,
      w: x1 - x0 + padding * 2, h: y1 - y0 + padding * 2,
    };
  }

  exportPNG(scale = 2) {
    const b = this.bounds();
    if (b.w === 0) return null;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(b.w * scale);
    cv.height = Math.ceil(b.h * scale);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(scale, 0, 0, scale, -b.x0 * scale, -b.y0 * scale);

    // edges
    const saved = this.ctx;
    this.ctx = ctx;
    const savedCam = this.cam;
    this.cam = { x: 0, y: 0, scale: 1 };
    const all = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
    for (const a of this.annotations) if (a.type === 'group') this._drawGroup(a, all);
    this._drawEdges(-1e9, -1e9, 1e9, 1e9);
    for (const t of this.model.tables) {
      if (!Number.isFinite(t.x) || this.hidden.has(t.key)) continue;
      ctx.drawImage(this._bitmap(t), t.x, t.y, t.w, t.h);
    }
    for (const a of this.annotations) if (a.type === 'group') this._drawGroupLabel(a, all);
    for (const a of this.annotations) if (a.type === 'note') this._drawNote(a, all);
    this.ctx = saved;
    this.cam = savedCam;
    return cv.toDataURL('image/png');
  }
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Crow's-foot cardinality marker at a line endpoint on a table edge.
//   (x,y) = the point on the table edge; dir = +1 if the line extends in +x
//   from here, -1 if -x. `s` = world-units-per-screen-pixel (1/scale).
//   kind ∈ 'one' | 'many' | 'zero-or-one' | 'zero-or-many'. lw = line width.
function drawMarker(ctx, x, y, dir, kind, s, lw, vertical = false) {
  if (vertical) {                                    // same marker, turned to face up or down
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 2);
    drawMarker(ctx, 0, 0, dir, kind, s, lw);
    ctx.restore();
    return;
  }
  const foot = 11 * s;     // distance from edge to crow's-foot apex / bar tick
  const spread = 5.5 * s;  // half-height of the foot / bar
  const r = 3.2 * s;       // optionality ("zero") ring radius
  const many = kind === 'many' || kind === 'zero-or-many';
  const optional = kind === 'zero-or-one' || kind === 'zero-or-many';
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (many) {
    const ax = x + dir * foot;                       // apex out along the line
    ctx.moveTo(ax, y); ctx.lineTo(x, y - spread);    // three prongs back to edge
    ctx.moveTo(ax, y); ctx.lineTo(x, y + spread);
    ctx.moveTo(ax, y); ctx.lineTo(x, y);
  } else {
    const bx = x + dir * foot;                        // single bar ("one")
    ctx.moveTo(bx, y - spread); ctx.lineTo(bx, y + spread);
  }
  ctx.stroke();
  if (optional) {
    const cx = x + dir * (foot + r + 2 * s);          // hollow "zero" ring, outermost
    ctx.beginPath();
    ctx.arc(cx, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
// Distance from a point to a routed line, measured to the curve itself
// (a fine polyline), so long lines have no gaps between sample points.
function segDistance(seg, x, y) {
  if (seg.path) return pathDistance(seg.path, x, y);
  const pad = Math.max(Math.abs(seg.c1x - seg.fx), Math.abs(seg.c1y - seg.fy), 0);
  const x0 = Math.min(seg.fx, seg.tx, seg.c1x, seg.c2x) - pad, x1 = Math.max(seg.fx, seg.tx, seg.c1x, seg.c2x) + pad;
  const y0 = Math.min(seg.fy, seg.ty, seg.c1y, seg.c2y) - pad, y1 = Math.max(seg.fy, seg.ty, seg.c1y, seg.c2y) + pad;
  if (x < x0 || x > x1 || y < y0 || y > y1) return Infinity;
  let best = Infinity;
  let px = seg.fx, py = seg.fy;
  const steps = 48;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps, iu = 1 - u;
    const a = iu * iu * iu, b = 3 * iu * iu * u, c = 3 * iu * u * u, d = u * u * u;
    const qx = a * seg.fx + b * seg.c1x + c * seg.c2x + d * seg.tx;
    const qy = a * seg.fy + b * seg.c1y + c * seg.c2y + d * seg.ty;
    const dx = qx - px, dy = qy - py;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (px + t * dx), y - (py + t * dy)));
    px = qx; py = qy;
  }
  return best;
}

function segNear(seg, x, y, tol) {
  return segDistance(seg, x, y) <= tol;
}

function routeMidpoint(seg) {
  return seg.path ? pathMidpoint(seg.path) : edgeMidpoint(seg);
}

// Traces a straight path; jumps ([segmentIndex, x]) become small semicircles
// over the line being crossed.
function tracePath(ctx, points, jumps) {
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const here = jumps ? jumps.filter(([seg]) => seg === i).map(([, x]) => x) : [];
    if (here.length && y1 === y2) {
      const dir = Math.sign(x2 - x1);
      here.sort((a, b) => (a - b) * dir);
      for (const x of here) {
        ctx.lineTo(x - dir * JUMP_RADIUS, y1);
        if (dir > 0) ctx.arc(x, y1, JUMP_RADIUS, Math.PI, 0, false);
        else ctx.arc(x, y1, JUMP_RADIUS, 0, Math.PI, true);
      }
    }
    ctx.lineTo(x2, y2);
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// point-in-rect test for annotations ({x,y,w,h})
function inside(w, a) { return w.x >= a.x && w.x <= a.x + a.w && w.y >= a.y && w.y <= a.y + a.h; }

// #rrggbb -> rgba() with alpha
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// single-line truncate to width
function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
// word-wrap (honours explicit newlines)
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = test;
    }
    if (line) out.push(line.trimEnd());
  }
  return out;
}

// The ends of a line the user placed by hand (not by "Arrange lines"), or null.
function handEnds(ends) {
  if (!ends) return null;
  const hand = {};
  if (ends.from && !ends.from.arranged) hand.from = ends.from;
  if (ends.to && !ends.to.arranged) hand.to = ends.to;
  return hand.from || hand.to ? hand : null;
}
