// "Arrange lines straight": routes every relation line as horizontal and
// vertical segments on a grid.
//
//  - Tables (plus a margin) are walls, so lines go around them, never behind.
//  - Each grid segment carries at most one line, so lines never lie on top of
//    each other; they may cross, and a crossing is drawn as a small jump.
//  - Every line end gets its own point on its table's edge. The line chooses
//    it while it is routed: any free point on the three sides that don't face
//    away from the other table, whichever gives the fewest turns and
//    crossings, keeping some space from other lines' points.
//  - Afterwards parallel lines move apart, as far as the room around them
//    allows (spreadParallel).
//
//  - A table's line to itself is a small loop at a top corner (self-loop.js),
//    and other lines keep out of the corner it takes.
//
// Pure functions: no DOM, so the router can be tested in Node.
import { selfLoopPaths, selfLoopArea, selfLoopCorner } from './self-loop.js';

export const GRID = 16;

// Working arrays, kept between runs: allocating tens of megabytes on every
// run was most of the cost of re-routing a few lines.
const scratchArrays = new Map();
let searchId = 0;
function scratch(name, Type, length, clear) {
  let a = scratchArrays.get(name);
  if (!a || a.length < length) {
    a = new Type(Math.ceil(length * 1.25));
    scratchArrays.set(name, a);
    if (name === 'stamp') searchId = 0;
    return a.subarray(0, length);
  }
  const view = a.subarray(0, length);
  if (clear) view.fill(0);
  return view;
}
const CLEARANCE = GRID;        // space kept free around every table (option: clearance)
const GROUP_MARGIN = 24;       // lines keep this far from group box edges they run along (option: groupMargin)
const GROUP_EDGE_COST = 4;     // each step along a group box edge, closer than groupMargin
export const MIN_LINE_GAP = 24;  // parallel lines keep at least this far apart where there is room (option: lineGap)
const PAD_CELLS = 24;          // free border around the whole diagram
const BEND_COST = 16;            // a turn costs as much as this many extra steps
const GROUP_COST = 6;           // each step inside a group the line doesn't belong to
const CROSS_COST = 30;            // crossing another line: worth a detour of this many steps
const FAST_CROSS_COST = 3;     // while tables move: crossings matter less than speed
const CORRIDOR_CELLS = 16;     // a line routed again stays this close to its old route
const SOFT_OVERLAP_COST = 60;  // last resort when no clean path exists
const SECOND_TRY_LINES = 200;  // "Arrange lines straight" tries twice on diagrams with this many lines or fewer
const SLOT_NEAR_COST = 4;      // an entry point next to another line's, per grid line of closeness
const WINDOW_CELLS = 40;       // first search stays near the two tables
const MAX_EXPANSIONS = 1500000;    // a search gives up after this many steps
// fast mode (lines of a table being moved): trust the distance estimate more,
// so a search looks at far fewer cells; routes get a few more bends
const FAST_WEIGHT = 2;
const FAST_EXPANSIONS = 150000;
const SIDES = ['top', 'right', 'bottom', 'left'];
const OUT = { right: [1, 0], left: [-1, 0], top: [0, -1], bottom: [0, 1] };
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // index: 0 right, 1 down, 2 left, 3 up

const centerOf = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
const sideMiddle = (t, side) => ({
  x: side === 'left' ? t.x : side === 'right' ? t.x + t.w : t.x + t.w / 2,
  y: side === 'top' ? t.y : side === 'bottom' ? t.y + t.h : t.y + t.h / 2,
});

// The space to keep between parallel lines: a third of the usual space between
// tables (180 apart -> lines 60 apart). Tables packed tight (the app's default
// layouts) give less than a grid step, so lines may run side by side as before.
// The usual space is the median, over the tables, of the gap to the nearest
// table beside, above or below it.
export function autoLineGap(tables) {
  const list = tables.filter((t) => Number.isFinite(t.x));
  const gaps = [];
  for (const a of list) {
    let best = Infinity;
    for (const b of list) {
      if (a === b) continue;
      const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      // beside (rows overlap) or above/below (columns overlap)
      if (dy < 0 && dx >= 0) best = Math.min(best, dx);
      else if (dx < 0 && dy >= 0) best = Math.min(best, dy);
    }
    if (best < Infinity) gaps.push(best);
  }
  if (!gaps.length) return 0;
  gaps.sort((p, q) => p - q);
  return gaps[gaps.length >> 1] / 3;
}

// The usable rectangles of a list ({x, y, w, h} with finite numbers, w, h > 0).
const validRects = (list) => (Array.isArray(list) ? list : []).filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);

// A spacing option (px): the given number, or the default when it is missing.
const spacingOr = (value, fallback) => (value != null && value !== '' && Number.isFinite(+value) ? Math.max(0, +value) : fallback);

// The space to keep between parallel lines: the given one, or else a third of
// the usual space between tables (autoLineGap), but at least MIN_LINE_GAP.
export function lineGapFor(tables, lineGap = null) {
  return spacingOr(lineGap, null) ?? Math.max(MIN_LINE_GAP, autoLineGap(tables));
}

// Sides of a table ranked by how directly they face the other table.
function rankedSides(table, other) {
  const a = centerOf(table), b = centerOf(other);
  const dx = b.x - a.x, dy = b.y - a.y;
  return [...SIDES].sort((p, q) => (OUT[q][0] * dx + OUT[q][1] * dy) - (OUT[p][0] * dx + OUT[p][1] * dy));
}

class MinHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(key, val) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.keys, v = this.vals;
    const top = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lastK;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m];
        i = m;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

// A priority queue for whole-number keys: one bucket per key. Every cost in the
// search is a whole number, so this does the heap's work without its sorting.
// Within a bucket the newest state comes out first, which favours states further
// along when estimates tie. Keys may be lower than the current minimum (the
// distance estimate can drop by more than one step costs).
class BucketQueue {
  constructor() { this.buckets = []; this.cur = Infinity; this.size = 0; this.used = []; }
  push(key, val) {
    let b = this.buckets[key];
    if (!b) { b = this.buckets[key] = []; }
    if (!b.length) this.used.push(key);
    b.push(val);
    if (key < this.cur) this.cur = key;
    this.size++;
  }
  pop() {
    let b = this.buckets[this.cur];
    while (!b || !b.length) b = this.buckets[++this.cur];
    this.size--;
    return b.pop();
  }
  clear() {
    for (const k of this.used) if (this.buckets[k]) this.buckets[k].length = 0;
    this.used.length = 0; this.cur = Infinity; this.size = 0;
  }
}
const bucketQueue = new BucketQueue();

// edges: [{ id, fromKey, toKey }]; tables: Map key -> {key, x, y, w, h}.
// anchors: hand-placed ends ({id: {from?: {side, t}, to?: {side, t}}}), kept.
// keep: straight paths of other lines that stay as they are ({id: {points}});
//   their lanes and entry points are reserved, so new lines avoid them.
// Returns { paths: {id: {points, fromSide, toSide}}, failed: [id], overlapping: [id] }.
// area: optional {x0, y0, x1, y1}; only tables there (and the lines' own
//   tables) are considered, which keeps the grid small and routing fast.
// fast: quicker, slightly less tidy routes (used while tables are moved).
// groups: [{x, y, w, h}] group boxes; a line avoids crossing a group that
//   holds neither of its two tables (it can, when there is no other way).
// lineGap: space (px) to keep between parallel lines where there is room;
//   by default a third of the usual space between tables, at least
//   MIN_LINE_GAP (lineGapFor).
// groupMargin: lines avoid running along a group box edge closer than this
//   (px); crossing the edge straight across costs nothing extra.
// clearance: space (px) kept free around every table.
// loopCorners: {tableKey: 'left' | 'right'} the top corner a table's loop to
//   itself takes; by default the one the other lines are expected to leave free.
// obstacles: [{x, y, w, h}] other things lines go around, like tables (sticky
//   notes); they keep the same clearance but have no entry points.
export function routeStraight(edges, byKey, { anchors = {}, isHidden = () => false, keep = {}, area = null, fast = false, groups = [], crossCost = fast ? FAST_CROSS_COST : CROSS_COST, bendCost = BEND_COST, passes = 0, hint = null, lineGap = null, endSides = 3, groupMargin = GROUP_MARGIN, clearance = CLEARANCE, loopCorners = null, obstacles = [] } = {}) {
  let tables = [...byKey.values()].filter((t) => Number.isFinite(t.x) && !isHidden(t.key));
  const walls = validRects(obstacles);
  clearance = spacingOr(clearance, CLEARANCE);
  groupMargin = spacingOr(groupMargin, GROUP_MARGIN);
  // entry points closer than this many grid lines on a table edge cost extra.
  // (Lines are not kept apart while routed: that cost crossings and turns on
  // busy diagrams. routeStraightTidy moves them apart afterwards instead.)
  const NEAR = Math.max(2, Math.round(lineGapFor(tables, lineGap) / GRID) - 1);
  if (area) {
    const own = new Set(edges.flatMap((e) => [e.fromKey, e.toKey]));
    tables = tables.filter((t) => own.has(t.key)
      || (t.x < area.x1 && t.x + t.w > area.x0 && t.y < area.y1 && t.y + t.h > area.y0));
  }
  if (!tables.length) return { paths: {}, failed: [], overlapping: [] };

  // ---- grid ----
  const extent = [...tables, ...walls];
  const minX = Math.min(...extent.map((t) => t.x)), minY = Math.min(...extent.map((t) => t.y));
  const maxX = Math.max(...extent.map((t) => t.x + t.w)), maxY = Math.max(...extent.map((t) => t.y + t.h));
  const ox = Math.floor(minX / GRID) * GRID - PAD_CELLS * GRID;
  const oy = Math.floor(minY / GRID) * GRID - PAD_CELLS * GRID;
  const cols = Math.ceil((maxX - ox) / GRID) + PAD_CELLS + 1;
  const rows = Math.ceil((maxY - oy) / GRID) + PAD_CELLS + 1;
  const size = cols * rows;
  const wx = (c) => ox + c * GRID, wy = (r) => oy + r * GRID;
  const at = (c, r) => r * cols + c;

  const blocked = scratch('blocked', Uint8Array, size, true);
  const box = new Map();   // table key -> its blocked cell range
  for (const t of tables) {
    const c0 = Math.max(0, Math.ceil((t.x - clearance - ox) / GRID));
    const c1 = Math.min(cols - 1, Math.floor((t.x + t.w + clearance - ox) / GRID));
    const r0 = Math.max(0, Math.ceil((t.y - clearance - oy) / GRID));
    const r1 = Math.min(rows - 1, Math.floor((t.y + t.h + clearance - oy) / GRID));
    box.set(t.key, { c0, c1, r0, r1 });
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[at(c, r)] = 1;
  }
  // obstacles (sticky notes): walls like tables, with the same clearance
  for (const o of walls) {
    const c0 = Math.max(0, Math.ceil((o.x - clearance - ox) / GRID));
    const c1 = Math.min(cols - 1, Math.floor((o.x + o.w + clearance - ox) / GRID));
    const r0 = Math.max(0, Math.ceil((o.y - clearance - oy) / GRID));
    const r1 = Math.min(rows - 1, Math.floor((o.y + o.h + clearance - oy) / GRID));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[at(c, r)] = 1;
  }

  // ---- groups: which group box each cell is in (the innermost one) ----
  const boxes = groups.filter((g) => [g.x, g.y, g.w, g.h].every(Number.isFinite) && g.w > 0 && g.h > 0)
    .map((g, i) => ({ ...g, id: i + 1 }))
    .sort((a, b) => b.w * b.h - a.w * a.h);
  const groupAt = scratch('groupAt', Uint16Array, size, true);
  for (const g of boxes) {
    const c0 = Math.max(0, Math.ceil((g.x - ox) / GRID)), c1 = Math.min(cols - 1, Math.floor((g.x + g.w - ox) / GRID));
    const r0 = Math.max(0, Math.ceil((g.y - oy) / GRID)), r1 = Math.min(rows - 1, Math.floor((g.y + g.h - oy) / GRID));
    for (let r = r0; r <= r1; r++) groupAt.fill(g.id, at(c0, r), at(c1, r) + 1);
  }
  // group box edges: a line running along one, closer than groupMargin, pays
  // for each step (alongH: sideways near a top or bottom edge, alongV: up or
  // down near a left or right edge). Crossing an edge straight across is free.
  const alongH = scratch('alongH', Uint8Array, size, true);
  const alongV = scratch('alongV', Uint8Array, size, true);
  const mark = (cells, x0, x1, y0, y1) => {
    const c0 = Math.max(0, Math.ceil((x0 - ox) / GRID)), c1 = Math.min(cols - 1, Math.floor((x1 - ox) / GRID));
    const r0 = Math.max(0, Math.ceil((y0 - oy) / GRID)), r1 = Math.min(rows - 1, Math.floor((y1 - oy) / GRID));
    if (c0 <= c1) for (let r = r0; r <= r1; r++) cells.fill(1, at(c0, r), at(c1, r) + 1);
  };
  if (groupMargin > 0) {
    const m = groupMargin - 0.5;                     // closer than groupMargin
    for (const g of boxes) {
      mark(alongH, g.x - m, g.x + g.w + m, g.y - m, g.y + m);
      mark(alongH, g.x - m, g.x + g.w + m, g.y + g.h - m, g.y + g.h + m);
      mark(alongV, g.x - m, g.x + m, g.y - m, g.y + g.h + m);
      mark(alongV, g.x + g.w - m, g.x + g.w + m, g.y - m, g.y + g.h + m);
    }
  }
  // the groups a table belongs to (its centre is inside the box)
  const groupsOf = (t) => {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    return boxes.filter((g) => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h).map((g) => g.id);
  };

  // ---- ports: every end gets its own grid line on a side ----
  const work = [];
  const loopIds = new Map();     // table -> ids of its lines to itself
  for (const edge of edges) {
    const from = byKey.get(edge.fromKey), to = byKey.get(edge.toKey);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x) || isHidden(from.key) || isHidden(to.key)) continue;
    if (from === to) { loopIds.set(from, [...(loopIds.get(from) || []), edge.id]); continue; }
    work.push({ edge, id: edge.id, from, to, ends: {}, home: boxes.length ? new Set([...groupsOf(from), ...groupsOf(to)]) : null });
  }

  // ---- a table's line to itself: a small loop at a top corner ----
  // The corner is the one on the side fewer of the table's other lines are
  // expected to use (lines routed here: the side facing the other table; lines
  // that stay: their side). The loop and a margin around it become a wall, so
  // other lines and entry points keep clear of it.
  const loopPaths = {};
  const tableKeyOf = (id, end) => { const part = id.split('>')[end === 'from' ? 0 : 1] || ''; return part.slice(0, part.lastIndexOf('.')); };
  for (const [t, ids] of loopIds) {
    const ends = [];
    for (const item of work) {
      for (const [end, mine, other] of [['from', item.from, item.to], ['to', item.to, item.from]]) {
        if (mine !== t) continue;
        const hand = anchors[item.id]?.[end];
        ends.push({ side: hand && OUT[hand.side] ? hand.side : rankedSides(t, other)[0], other });
      }
    }
    for (const [id, p] of Object.entries(keep)) {
      if (!p?.fromSide) continue;
      const f = tableKeyOf(id, 'from'), g = tableKeyOf(id, 'to');
      if (f === g) continue;
      if (f === t.key) ends.push({ side: p.fromSide, other: byKey.get(g) });
      if (g === t.key) ends.push({ side: p.toSide, other: byKey.get(f) });
    }
    for (const [id, path] of Object.entries(selfLoopPaths(t, ids, ends, loopCorners?.[t.key]))) {
      loopPaths[id] = path;
      const a = selfLoopArea(path, GRID);
      mark(blocked, a.x0, a.x1, a.y0, a.y1);
    }
  }
  // loops that stay keep their corner too (one shaped by hand only claims its lanes)
  for (const [id, p] of Object.entries(keep)) {
    if (p?.hand || !Array.isArray(p?.points) || p.points.length < 2 || tableKeyOf(id, 'from') !== tableKeyOf(id, 'to')) continue;
    const a = selfLoopArea(p, GRID);
    mark(blocked, a.x0, a.x1, a.y0, a.y1);
  }

  const hOwner = scratch('hOwner', Int32Array, size, true);      // edge (c,r)-(c+1,r)
  const vOwner = scratch('vOwner', Int32Array, size, true);      // edge (c,r)-(c,r+1)
  const stubOwner = scratch('stubOwner', Int32Array, size, true);   // stub cells belong to one line

  // lines that stay: claim their segments and the cells next to their ends.
  // The grid origin is a multiple of GRID, so their corners sit on grid lines.
  const inGrid = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
  Object.values(keep).forEach((path, i) => {
    const pts = path?.points;
    if (!Array.isArray(pts) || pts.length < 2) return;
    const owner = work.length + i + 1;
    for (let k = 1; k < pts.length; k++) {
      const [x1, y1] = pts[k - 1], [x2, y2] = pts[k];
      if (y1 === y2) {
        const r = Math.round((y1 - oy) / GRID);      // lines moved apart sit between grid lines
        const c0 = Math.ceil((Math.min(x1, x2) - ox) / GRID), c1 = Math.floor((Math.max(x1, x2) - ox) / GRID);
        for (let c = c0; c < c1; c++) if (inGrid(c, r) && !hOwner[at(c, r)]) hOwner[at(c, r)] = owner;
      } else if (x1 === x2) {
        const c = Math.round((x1 - ox) / GRID);
        const r0 = Math.ceil((Math.min(y1, y2) - oy) / GRID), r1 = Math.floor((Math.max(y1, y2) - oy) / GRID);
        for (let r = r0; r < r1; r++) if (inGrid(c, r) && !vOwner[at(c, r)]) vOwner[at(c, r)] = owner;
      }
    }
    // the first free grid cell outside each table edge, along the first and
    // last segment: that's where the line's entry point sits on the grid
    for (const [[ex, ey], [nx, ny]] of [[pts[0], pts[1]], [pts.at(-1), pts.at(-2)]]) {
      const sx = Math.sign(nx - ex), sy = Math.sign(ny - ey);
      const fx = (ex - ox) / GRID, fy = (ey - oy) / GRID;
      let c = sx > 0 ? Math.ceil(fx) : sx < 0 ? Math.floor(fx) : Math.round(fx);
      let r = sy > 0 ? Math.ceil(fy) : sy < 0 ? Math.floor(fy) : Math.round(fy);
      for (let step = 0; step < 4 && inGrid(c, r) && blocked[at(c, r)]; step++) { c += sx; r += sy; }
      if (inGrid(c, r) && !blocked[at(c, r)]) stubOwner[at(c, r)] = owner;
    }
  });

  // slots on a side: grid lines along it whose stub cell (just outside the
  // margin) is free
  const slotsOf = (table, side) => {
    const b = box.get(table.key);
    const out = [];
    const free = (c, r) => !blocked[at(c, r)] && stubOwner[at(c, r)] <= work.length;   // not a kept line's end
    if (side === 'left' || side === 'right') {
      const c = side === 'right' ? b.c1 + 1 : b.c0 - 1;
      if (c < 0 || c >= cols) return out;
      for (let r = Math.ceil((table.y + 6 - oy) / GRID); wy(r) <= table.y + table.h - 6; r++) {
        if (r >= 0 && r < rows && free(c, r)) out.push({ c, r, px: side === 'right' ? table.x + table.w : table.x, py: wy(r) });
      }
    } else {
      const r = side === 'bottom' ? b.r1 + 1 : b.r0 - 1;
      if (r < 0 || r >= rows) return out;
      for (let c = Math.ceil((table.x + 6 - ox) / GRID); wx(c) <= table.x + table.w - 6; c++) {
        if (c >= 0 && c < cols && free(c, r)) out.push({ c, r, px: wx(c), py: side === 'bottom' ? table.y + table.h : table.y });
      }
    }
    return out;
  };

  const sideLists = new Map();   // key|side -> [{item, end, other, prefer}]
  const listFor = (table, side) => {
    const k = table.key + '|' + side;
    if (!sideLists.has(k)) sideLists.set(k, { table, side, ends: [] });
    return sideLists.get(k);
  };
  for (const item of work) {
    for (const end of ['from', 'to']) {
      const table = end === 'from' ? item.from : item.to;
      const other = end === 'from' ? item.to : item.from;
      const hand = anchors[item.id]?.[end];
      const ranking = hand && OUT[hand.side] ? [hand.side, ...rankedSides(table, other).filter((s) => s !== hand.side)] : rankedSides(table, other);
      const entry = { item, end, table, other, ranking, rank: 0, hand };
      item.ends[end] = { side: ranking[0], entry };
      listFor(table, ranking[0]).ends.push(entry);
    }
  }
  // move ends off sides that have more ends than slots
  for (let guard = 0; guard < 6; guard++) {
    let moved = false;
    for (const list of [...sideLists.values()]) {
      const slots = slotsOf(list.table, list.side).length;
      while (list.ends.length > slots) {
        // the end that cares least about this side moves to its next choice
        list.ends.sort((a, b) => a.rank - b.rank);
        const entry = list.ends.find((e) => !e.hand && e.rank < 3) || list.ends.find((e) => e.rank < 3);
        if (!entry) break;
        list.ends.splice(list.ends.indexOf(entry), 1);
        entry.rank++;
        const side = entry.ranking[entry.rank];
        entry.item.ends[entry.end].side = side;
        listFor(entry.table, side).ends.push(entry);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // ---- straight lines first ----
  // When two ends face each other and one clear grid line joins them, both
  // ends take that grid line, so the line needs no turn. Spreading each side
  // on its own put them at different heights and forced a step in the line.
  const OPPOSITE = { right: 'left', left: 'right', bottom: 'top', top: 'bottom' };
  const fixedSlot = new Map();   // end entry -> its slot on the straight line
  const reserved = new Set();    // cells the straight lines run through
  const taken = new Set();       // slots already given to a straight line
  const slotKey = (table, s) => table.key + '|' + s.c + '|' + s.r;
  // a straight line may pass the side of another table, over the cells its
  // ends would use; it does so only while that side keeps enough of them
  const sideAt = new Map();      // stub cell -> side list with ends
  const lost = new Map();        // side list -> slots taken by straight lines
  const room = new Map();        // side list -> slots it has
  for (const list of sideLists.values()) {
    if (!list.ends.length) continue;
    const slots = slotsOf(list.table, list.side);
    room.set(list, slots.length);
    for (const s of slots) sideAt.set(at(s.c, s.r), list);
  }
  const straightRun = (a, b, runsVertically, item) => {
    const cells = [];
    if (runsVertically) for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) cells.push(at(a.c, r));
    else for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) cells.push(at(c, a.r));
    const owners = runsVertically ? vOwner : hOwner;
    for (let i = 0; i < cells.length; i++) {
      const k = cells[i];
      if (blocked[k] || reserved.has(k) || stubOwner[k] > work.length) return null;   // a table, or a kept line's end
      if (groupAt[k] && !item.home?.has(groupAt[k])) return null;                     // a group the line doesn't belong to
      if (i < cells.length - 1 && owners[k]) return null;                             // a kept line runs along it
    }
    const passes = new Map();
    for (const k of cells.slice(1, -1)) {
      const list = sideAt.get(k);
      if (list) passes.set(list, (passes.get(list) || 0) + 1);
    }
    for (const [list, n] of passes) if (room.get(list) - (lost.get(list) || 0) - n < list.ends.length + 1) return null;
    for (const [list, n] of passes) lost.set(list, (lost.get(list) || 0) + n);
    return cells;
  };
  const span = (item) => Math.abs(centerOf(item.from).x - centerOf(item.to).x) + Math.abs(centerOf(item.from).y - centerOf(item.to).y);
  for (const item of [...work].sort((p, q) => span(p) - span(q) || p.id.localeCompare(q.id))) {
    const ea = item.ends.from.entry, eb = item.ends.to.entry;
    const sa = item.ends.from.side, sb = item.ends.to.side;
    if (!ea || !eb || OPPOSITE[sa] !== sb || (ea.hand && eb.hand)) continue;
    const runsVertically = sa === 'top' || sa === 'bottom';
    const along = (s) => (runsVertically ? s.c : s.r);
    const SA = slotsOf(item.from, sa), SB = slotsOf(item.to, sb);
    const onB = new Map(SB.map((s) => [along(s), s]));
    const forward = runsVertically ? OUT[sa][1] : OUT[sa][0];
    let pairs = SA.filter((s) => onB.has(along(s))).map((s) => [s, onB.get(along(s))])
      .filter(([a, b]) => (runsVertically ? b.r - a.r : b.c - a.c) * forward > 0
        && !taken.has(slotKey(item.from, a)) && !taken.has(slotKey(item.to, b)));
    if (!pairs.length) continue;
    // a hand-placed end decides where the line sits; otherwise the middle of
    // the stretch the two sides share
    let want = (along(pairs[0][0]) + along(pairs[pairs.length - 1][0])) / 2;
    const handEnd = ea.hand?.side === sa ? [ea, item.from, SA] : eb.hand?.side === sb ? [eb, item.to, SB] : null;
    if (handEnd) {
      const [e, t, slots] = handEnd;
      const spot = runsVertically ? t.x + t.w * e.hand.t : t.y + t.h * e.hand.t;
      const nearest = slots.reduce((best, s) => (Math.abs((runsVertically ? s.px : s.py) - spot) < Math.abs((runsVertically ? best.px : best.py) - spot) ? s : best), slots[0]);
      want = along(nearest);
      pairs = pairs.filter(([a]) => along(a) === want);
    }
    pairs.sort((p, q) => Math.abs(along(p[0]) - want) - Math.abs(along(q[0]) - want));
    for (const [a, b] of pairs.slice(0, 32)) {
      const cells = straightRun(a, b, runsVertically, item);
      if (!cells) continue;
      fixedSlot.set(ea, a); fixedSlot.set(eb, b);
      taken.add(slotKey(item.from, a)); taken.add(slotKey(item.to, b));
      for (const k of cells) reserved.add(k);
      item.straight = true;
      break;
    }
  }

  // Free ends: every end except a straight line's and a hand-placed one. Its
  // line may enter anywhere along the side facing the other table, or the next
  // best side, wherever that saves turns and crossings (fast mode keeps the
  // spread-out entry points, for speed).
  const isFree = (entry) => !fast && !fixedSlot.has(entry) && !entry.hand;
  for (const list of sideLists.values()) {
    // other ends keep off the straight lines' cells
    const mine = new Set(list.ends.filter((e) => fixedSlot.has(e)).map((e) => at(fixedSlot.get(e).c, fixedSlot.get(e).r)));
    const slots = slotsOf(list.table, list.side).filter((s) => !reserved.has(at(s.c, s.r)) || mine.has(at(s.c, s.r)));
    const vertical = list.side === 'top' || list.side === 'bottom';
    // order the ends by the direction their line leaves in, seen from the
    // middle of the side: a nearby table just above comes in more steeply than
    // a far one higher up, so it takes the upper spot and the lines don't cross
    const t = list.table, mid = sideMiddle(t, list.side);
    const along = (e) => {
      const o = centerOf(e.other), dx = o.x - mid.x, dy = o.y - mid.y;
      if (list.side === 'right') return Math.atan2(dy, dx);
      if (list.side === 'left') return Math.atan2(dy, -dx);
      if (list.side === 'bottom') return Math.atan2(dx, dy);
      return Math.atan2(dx, -dy);
    };
    // a first routing showed how each line actually arrives (hint): that order wins
    const hinted = (e) => hint?.[e.item.id + '|' + e.end + '|' + list.side];
    list.ends.sort((a, b) => {
      const ha = hinted(a), hb = hinted(b);
      if (ha && hb) return ha[0] - hb[0] || ha[1] - hb[1] || a.item.id.localeCompare(b.item.id);
      return along(a) - along(b) || a.item.id.localeCompare(b.item.id);
    });
    const n = list.ends.length;
    const used = new Set();
    // straight lines and ends placed by hand choose their slot first, the
    // rest spread in order
    const rankOf = (e) => (fixedSlot.has(e) ? 2 : e.hand ? 1 : 0);
    const handFirst = list.ends.map((entry, i) => ({ entry, i })).sort((p, q) => rankOf(q.entry) - rankOf(p.entry));
    handFirst.forEach(({ entry, i }) => {
      // a free end chooses its entry point while its line is routed
      if (isFree(entry)) { entry.item.ends[entry.end] = { side: list.side, free: true, entry }; return; }
      let pick = Math.min(slots.length - 1, Math.round(((i + 0.5) * slots.length) / n - 0.5));
      const fixed = fixedSlot.get(entry);
      const fixedAt = fixed ? slots.findIndex((s) => s.c === fixed.c && s.r === fixed.r) : -1;
      if (fixedAt >= 0) pick = fixedAt;
      else if (entry.hand && entry.hand.side === list.side) {
        const want = vertical ? list.table.x + list.table.w * entry.hand.t : list.table.y + list.table.h * entry.hand.t;
        pick = slots.reduce((best, s, j) => (Math.abs((vertical ? s.px : s.py) - want) < Math.abs((vertical ? slots[best].px : slots[best].py) - want) ? j : best), 0);
      }
      // taken: the nearest free slot on either side
      for (let d = 1; used.has(pick) && d < slots.length; d++) {
        if (pick + d < slots.length && !used.has(pick + d)) pick += d;
        else if (pick - d >= 0 && !used.has(pick - d)) pick -= d;
      }
      if (!slots.length || used.has(pick)) { entry.item.failed = true; return; }
      used.add(pick);
      const slot = slots[pick];
      entry.item.ends[entry.end] = { side: list.side, ...slot };
      stubOwner[at(slot.c, slot.r)] = work.indexOf(entry.item) + 1;
    });
  }

  // ---- routing ----
  // search state is reused between runs; stamps tell this search's entries
  // from older ones, so nothing needs clearing
  const stamp = scratch('stamp', Int32Array, size * 4, false);
  const gScore = scratch('gScore', Float64Array, size * 4, false);
  const parent = scratch('parent', Int32Array, size * 4, false);

  const closed = scratch('closed', Int32Array, size * 4, false);
  const STEP = [1, cols, -1, -cols];                 // cell offset for each direction
  let lastCost = 0;   // cost of the path the last search found
  const goalMark = scratch('goalMark', Int32Array, size, false);
  const goalDir = scratch('goalDir', Int8Array, size, false);
  const goalPen = scratch('goalPen', Int32Array, size, false);
  // starts / goals: [{c, r, dir, pen}] entry points the line may leave from or
  // arrive at (dir: the way it leaves, or must arrive; pen: extra cost of
  // using that point). Goal cells end the search.
  function search(item, owner, starts, goals, window, soft, limit = MAX_EXPANSIONS, w = 1) {
    searchId = (searchId + 1) | 0 || 1;
    const heap = Number.isInteger(w) ? bucketQueue : new MinHeap();
    if (heap === bucketQueue) heap.clear();
    // the goals lie on one or two table sides: a column (left, right) or a row
    // (top, bottom) each. Distance to the nearest, plus one turn when it isn't
    // straight ahead.
    const lines = [];
    for (const g of goals) {
      goalMark[at(g.c, g.r)] = searchId; goalDir[at(g.c, g.r)] = g.dir; goalPen[at(g.c, g.r)] = g.pen;
      const vertical = (g.dir & 1) === 0;            // arrives moving left or right: the goals share a column
      let l = lines.find((x) => x.vertical === vertical && x.at === (vertical ? g.c : g.r));
      if (!l) lines.push(l = { vertical, at: vertical ? g.c : g.r, lo: Infinity, hi: -Infinity });
      const along = vertical ? g.r : g.c;
      l.lo = Math.min(l.lo, along); l.hi = Math.max(l.hi, along);
    }
    const h = (c, r) => {
      let best = Infinity;
      for (const l of lines) {
        const across = Math.abs((l.vertical ? c : r) - l.at);
        const v = l.vertical ? r : c;
        const along = v < l.lo ? l.lo - v : v > l.hi ? v - l.hi : 0;
        const d = across + along + (across && along ? bendCost : 0);
        if (d < best) best = d;
      }
      return best;
    };
    // groups this line doesn't belong to (ids are small, so a lookup table)
    const foreign = new Uint8Array(boxes.length + 1);
    for (const g of boxes) foreign[g.id] = item.home?.has(g.id) ? 0 : 1;
    const { c0: wc0, c1: wc1, r0: wr0, r1: wr1 } = window;
    for (const st of starts) {
      if (st.c < wc0 || st.c > wc1 || st.r < wr0 || st.r > wr1) continue;
      const s0 = at(st.c, st.r) * 4 + st.dir;
      if (stamp[s0] === searchId && gScore[s0] <= st.pen) continue;
      stamp[s0] = searchId; gScore[s0] = st.pen; parent[s0] = -1;
      heap.push(st.pen + w * h(st.c, st.r), s0);
    }
    let best = -1;
    let expansions = 0;
    while (heap.size) {
      const state = heap.pop();
      if (closed[state] === searchId) continue;          // reached already, more cheaply
      closed[state] = searchId;
      const cell = state >> 2, dir = state & 3;
      const g = gScore[state];
      if (goalMark[cell] === searchId) { best = state; break; }
      if (++expansions > limit) break;
      const c = cell % cols, r = (cell / cols) | 0;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((dir + 2) & 3)) continue;              // no U-turns
        const horizontal = (nd & 1) === 0;
        const nc = nd === 0 ? c + 1 : nd === 2 ? c - 1 : c;
        const nr = nd === 1 ? r + 1 : nd === 3 ? r - 1 : r;
        if (nc < wc0 || nc > wc1 || nr < wr0 || nr > wr1) continue;
        const ncell = cell + STEP[nd];
        if (blocked[ncell]) continue;
        const so = stubOwner[ncell];
        if (so && so !== owner) continue;
        // the segment between the two cells
        const eo = horizontal ? hOwner[nd === 0 ? cell : ncell] : vOwner[nd === 1 ? cell : ncell];
        let cost = 1;
        if (eo && eo !== owner) { if (!soft) continue; cost += SOFT_OVERLAP_COST; }
        if (nd !== dir) cost += bendCost;
        // crossing a line that runs across this cell the other way
        const crossOwners = horizontal
          ? (vOwner[ncell] || (nr > 0 && vOwner[ncell - cols]))
          : (hOwner[ncell] || (nc > 0 && hOwner[ncell - 1]));
        if (crossOwners && crossOwners !== owner) cost += crossCost;
        if (foreign[groupAt[ncell]]) cost += GROUP_COST;
        if (horizontal ? alongH[ncell] : alongV[ncell]) cost += GROUP_EDGE_COST;
        if (goalMark[ncell] === searchId) cost += (nd !== goalDir[ncell] ? bendCost : 0) + goalPen[ncell];
        const next = ncell * 4 + nd;
        const ng = g + cost;
        if (stamp[next] === searchId && gScore[next] <= ng) continue;
        stamp[next] = searchId; gScore[next] = ng; parent[next] = state;
        heap.push(ng + w * h(nc, nr), next);
      }
    }
    for (const g of goals) goalMark[at(g.c, g.r)] = 0;
    if (best < 0) return null;
    lastCost = gScore[best];
    const cells = [];
    for (let s = best; s >= 0; s = stamp[s] === searchId ? parent[s] : -1) cells.push(s >> 2);
    return cells.reverse();
  }

  // the entry points a line end may use: its own slot, or for a free end every
  // free slot on the side facing the other table and the next best side
  const dirIndex = (dx, dy) => DIRS.findIndex(([x, y]) => x === dx && y === dy);
  const NEAR_SLOTS = NEAR;
  const usedBy = (k, owner) => {                     // another line already runs through this cell
    const o = [hOwner[k], vOwner[k], k % cols ? hOwner[k - 1] : 0, k >= cols ? vOwner[k - cols] : 0];
    return o.some((x) => x && x !== owner);
  };
  function slotPen(k, side, owner) {                 // close to other lines' entry points
    const step = side === 'left' || side === 'right' ? cols : 1;
    let pen = 0;
    for (let d = 1; d <= NEAR_SLOTS; d++) {
      for (const n of [k - d * step, k + d * step]) {
        if (n >= 0 && n < size && stubOwner[n] && stubOwner[n] !== owner) pen += (NEAR_SLOTS + 1 - d) * SLOT_NEAR_COST;
      }
    }
    return pen;
  }
  function endChoices(item, which, owner) {
    const e = item.ends[which];
    const dirFor = (side) => (which === 'from' ? dirIndex(OUT[side][0], OUT[side][1]) : dirIndex(-OUT[side][0], -OUT[side][1]));
    if (!e.free) return e.c === undefined ? [] : [{ c: e.c, r: e.r, px: e.px, py: e.py, side: e.side, dir: dirFor(e.side), pen: 0 }];
    const entry = e.entry, table = which === 'from' ? item.from : item.to;
    const out = [];
    entry.ranking.slice(entry.rank, entry.rank + endSides).forEach((side, rank) => {
      for (const sl of slotsOf(table, side)) {
        const k = at(sl.c, sl.r);
        if (reserved.has(k) || (stubOwner[k] && stubOwner[k] !== owner) || usedBy(k, owner)) continue;
        out.push({ ...sl, side, dir: dirFor(side), pen: rank + slotPen(k, side, owner) });
      }
    });
    return out;
  }
  // after a search: the entry points the route uses become the line's own
  function takeEnds(item, cells, starts, goals, owner) {
    const s = starts.find((x) => at(x.c, x.r) === cells[0]);
    const g = goals.find((x) => at(x.c, x.r) === cells[cells.length - 1]);
    for (const [which, slot] of [['from', s], ['to', g]]) {
      const e = item.ends[which];
      if (!e.free && !e.chosen) continue;
      item.ends[which] = { side: slot.side, c: slot.c, r: slot.r, px: slot.px, py: slot.py, chosen: true, entry: e.entry };
      stubOwner[at(slot.c, slot.r)] = owner;
    }
  }
  // the entry points a line chose go back to the pool (it is routed again)
  function freeEnds(item) {
    for (const which of ['from', 'to']) {
      const e = item.ends[which];
      if (e.chosen) { stubOwner[at(e.c, e.r)] = 0; item.ends[which] = { side: e.side, free: true, entry: e.entry, was: e }; }
    }
  }
  function keepEnds(item, owner) {                   // undo freeEnds
    for (const which of ['from', 'to']) {
      const e = item.ends[which];
      if (e.free && e.was) { item.ends[which] = e.was; stubOwner[at(e.was.c, e.was.r)] = owner; }
    }
  }

  const paths = { ...loopPaths };
  const failed = [];
  const overlapping = [];
  const manhattan = (item) => Math.abs(centerOf(item.from).x - centerOf(item.to).x) + Math.abs(centerOf(item.from).y - centerOf(item.to).y);
  // straight lines go first, so no other line takes their grid line
  const order = [...work].sort((a, b) => (b.straight ? 1 : 0) - (a.straight ? 1 : 0) || manhattan(a) - manhattan(b) || a.id.localeCompare(b.id));
  for (const item of order) {
    const owner = work.indexOf(item) + 1;
    const a = endChoices(item, 'from', owner), b = endChoices(item, 'to', owner);
    if (item.failed || !a.length || !b.length) { failed.push(item.id); continue; }
    const ba = box.get(item.from.key), bb = box.get(item.to.key);
    const near = {
      c0: Math.max(0, Math.min(ba.c0, bb.c0) - 1 - WINDOW_CELLS), c1: Math.min(cols - 1, Math.max(ba.c1, bb.c1) + 1 + WINDOW_CELLS),
      r0: Math.max(0, Math.min(ba.r0, bb.r0) - 1 - WINDOW_CELLS), r1: Math.min(rows - 1, Math.max(ba.r1, bb.r1) + 1 + WINDOW_CELLS),
    };
    const all = { c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 };
    // a clean path near the two tables; failing that, the cheapest path that
    // shares as few segments as possible
    const cells = fast
      ? search(item, owner, a, b, near, true, FAST_EXPANSIONS, FAST_WEIGHT) || search(item, owner, a, b, all, true, FAST_EXPANSIONS * 2, FAST_WEIGHT)
      : search(item, owner, a, b, near, false) || search(item, owner, a, b, near, true) || search(item, owner, a, b, all, true);
    if (!cells) { failed.push(item.id); continue; }
    takeEnds(item, cells, a, b, owner);
    if (claim(cells, owner)) overlapping.push(item.id);
    item.cells = cells;
    item.near = near;
    paths[item.id] = pathOf(item, cells);
  }

  // ---- fewer crossings ----
  // Lines routed early could not see the lines routed after them. Each pass
  // takes up the lines that cross others, one at a time, and routes each again
  // around all the rest; the new route is kept only when it is cheaper (fewer
  // crossings, unless they cost more turns or length than they save).
  for (let pass = 0; pass < passes && !fast; pass++) {
    const crossing = order.filter((item) => item.cells && !overlapping.includes(item.id) && crossesOthers(item.cells, work.indexOf(item) + 1));
    if (!crossing.length) break;
    let improved = false;
    for (const item of crossing) {
      const owner = work.indexOf(item) + 1;
      release(item.cells, owner);
      freeEnds(item);
      const old = costOf(item, owner, item.cells);
      const a = endChoices(item, 'from', owner), b = endChoices(item, 'to', owner);
      const cells = a.length && b.length ? search(item, owner, a, b, corridor(item.cells, item.near), false) : null;
      if (cells && lastCost < old - 0.5) {
        takeEnds(item, cells, a, b, owner);
        claim(cells, owner);
        item.cells = cells;
        paths[item.id] = pathOf(item, cells);
        improved = true;
      } else {
        keepEnds(item, owner);
        claim(item.cells, owner);
      }
    }
    if (!improved) break;
  }
  return { paths, failed, overlapping };

  // the area a line is routed again in: around its current route (so that
  // route is always still possible), which keeps each search small
  function corridor(cells, near) {
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const k of cells) {
      const c = k % cols, r = (k / cols) | 0;
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
    }
    const m = CORRIDOR_CELLS;
    return { c0: Math.max(near.c0, c0 - m), c1: Math.min(near.c1, c1 + m), r0: Math.max(near.r0, r0 - m), r1: Math.min(near.r1, r1 + m) };
  }
  // marks a route's segments as the line's own; true when one was taken already
  function claim(cells, owner) {
    let shares = false;
    for (let i = 1; i < cells.length; i++) {
      const k = segmentAt(cells[i - 1], cells[i]);
      if (k.owners[k.at] && k.owners[k.at] !== owner) shares = true;
      else k.owners[k.at] = owner;
    }
    return shares;
  }
  function release(cells, owner) {
    for (let i = 1; i < cells.length; i++) {
      const k = segmentAt(cells[i - 1], cells[i]);
      if (k.owners[k.at] === owner) k.owners[k.at] = 0;
    }
  }
  function segmentAt(p, q) {
    const pc = p % cols, pr = (p / cols) | 0, qc = q % cols, qr = (q / cols) | 0;
    return pr === qr ? { owners: hOwner, at: at(Math.min(pc, qc), pr) } : { owners: vOwner, at: at(pc, Math.min(pr, qr)) };
  }
  // another line running across the cell the other way
  function crossAt(cell, horizontal) {
    const c = cell % cols, r = (cell / cols) | 0;
    return horizontal ? (vOwner[cell] || (r > 0 && vOwner[at(c, r - 1)])) : (hOwner[cell] || (c > 0 && hOwner[at(c - 1, r)]));
  }
  function crossesOthers(cells, owner) {
    for (let i = 1; i < cells.length; i++) {
      const o = crossAt(cells[i], cells[i] - cells[i - 1] === 1 || cells[i - 1] - cells[i] === 1);
      if (o && o !== owner) return true;
    }
    return false;
  }
  // what search() would charge for this route, as the grid is now
  function costOf(item, owner, cells) {
    const dirOf = (p, q) => (q - p === 1 ? 0 : q - p === cols ? 1 : p - q === 1 ? 2 : 3);
    const from = item.ends.from.was || item.ends.from, to = item.ends.to.was || item.ends.to;
    let dir = DIRS.findIndex(([dx, dy]) => dx === OUT[from.side][0] && dy === OUT[from.side][1]);
    const inDir = DIRS.findIndex(([dx, dy]) => dx === -OUT[to.side][0] && dy === -OUT[to.side][1]);
    let cost = 0;
    // the same extra cost the search charges for these entry points
    for (const [e, which] of [[from, 'from'], [to, 'to']]) {
      if (!item.ends[which].free) continue;
      const rank = e.entry.ranking.indexOf(e.side) - e.entry.rank;
      cost += Math.max(0, rank) + slotPen(at(e.c, e.r), e.side, owner);
    }
    for (let i = 1; i < cells.length; i++) {
      const nd = dirOf(cells[i - 1], cells[i]);
      cost += 1;
      if (nd !== dir) cost += bendCost;
      const o = crossAt(cells[i], nd === 0 || nd === 2);
      if (o && o !== owner) cost += crossCost;
      const grp = groupAt[cells[i]];
      if (grp && !item.home?.has(grp)) cost += GROUP_COST;
      if (nd === 0 || nd === 2 ? alongH[cells[i]] : alongV[cells[i]]) cost += GROUP_EDGE_COST;
      if (i === cells.length - 1 && nd !== inDir) cost += bendCost;
      dir = nd;
    }
    return cost;
  }
  // corners only, from the table edge out and back to the other table edge
  function pathOf(item, cells) {
    const a = item.ends.from, b = item.ends.to;
    const pts = [[a.px, a.py]];
    const push = (x, y) => {
      const n = pts.length;
      if (n >= 2) {
        const [x1, y1] = pts[n - 2], [x2, y2] = pts[n - 1];
        if ((x1 === x2 && x2 === x) || (y1 === y2 && y2 === y)) { pts[n - 1] = [x, y]; return; }
      }
      if (n && pts[n - 1][0] === x && pts[n - 1][1] === y) return;
      pts.push([x, y]);
    };
    for (const cell of cells) push(wx(cell % cols), wy((cell / cols) | 0));
    push(b.px, b.py);
    return { points: pts, fromSide: a.side, toSide: b.side };
  }
}

// The tidy routing used by "Arrange lines straight". Every line chooses its
// side and entry point as it is routed (the one giving the fewest turns and
// crossings); the lines that still cross others are routed again around the
// rest (passes); then parallel lines move apart where there is room
// (spreadParallel). In fast mode, entry points are spread evenly instead, so
// it routes twice: the first routing shows from which way each line reaches
// its table, and the second orders the entry points to match.
export function routeStraightTidy(edges, byKey, opts = {}) {
  let best;
  if (opts.fast) {
    // fast mode spreads entry points evenly: a first routing tells the order
    const first = routeStraight(edges, byKey, { ...opts, passes: 0 });
    const second = routeStraight(edges, byKey, { ...opts, hint: arrivalOrder(first.paths) });
    const trouble = (r) => r.failed.length * 1000 + r.overlapping.length;
    best = trouble(second) <= trouble(first) ? second : first;
  } else {
    // each line chooses its own entry points as it is routed
    best = routeStraight(edges, byKey, opts);
    // a diagram that routes quickly gets a second try, with more passes and
    // the first try's arrival order for the ends that don't choose (straight
    // lines, ends placed by hand); the one with fewer crossings, then turns, wins
    const score = (r) => {
      const list = Object.values(r.paths);
      return r.failed.length * 1e9 + r.overlapping.length * 1e6 + countCrossings(list) * 1e3 + list.reduce((n, p) => n + p.points.length - 2, 0);
    };
    const passes = edges.length <= SECOND_TRY_LINES ? Math.max(opts.passes ?? 0, 3) : opts.passes;
    if (edges.length <= SECOND_TRY_LINES) {
      const again = routeStraight(edges, byKey, { ...opts, passes, hint: arrivalOrder(best.paths) });
      if (score(again) < score(best)) best = again;
    }
    // a table's loop to itself took its corner before the other lines chose
    // their sides. When the lines as routed leave the other top corner freer,
    // route again with the loop there, and keep that unless it fails or shares
    // more lines, or adds more than a crossing or two.
    // When moving them all at once is worse, a few tables try on their own.
    const trouble = (r) => r.failed.length * 1e6 + r.overlapping.length;
    const attempt = (loopCorners) => {
      const moved = routeStraight(edges, byKey, { ...opts, passes, hint: arrivalOrder(best.paths), loopCorners });
      const crossings = countCrossings(Object.values(best.paths));
      if (trouble(moved) > trouble(best) || countCrossings(Object.values(moved.paths)) > crossings + Math.max(1, Math.round(crossings * 0.02))) return false;
      best = moved;
      return true;
    };
    for (let tries = 0; tries < 2; tries++) {
      const corners = loopCornersFor(edges, byKey, best.paths, opts.keep);
      if (!corners) break;
      if (attempt(corners.wanted)) continue;
      for (const key of corners.off.slice(0, 3)) {
        const now = loopCornersFor(edges, byKey, best.paths, opts.keep);
        if (now?.off.includes(key)) attempt({ ...now.current, [key]: now.wanted[key] });
      }
      break;
    }
  }
  // then parallel lines move apart where there is room, and away from the
  // group box edges they run along. A table's loop to itself stays as it is;
  // the other lines keep their distance from it.
  const tables = [...byKey.values()].filter((t) => Number.isFinite(t.x) && !opts.isHidden?.(t.key));
  const gap = lineGapFor(tables, opts.lineGap);
  if (!opts.fast && opts.spread !== false) {
    const selfIds = new Set(edges.filter((e) => e.fromKey === e.toKey).map((e) => e.id));
    const loops = {}, rest = {};
    for (const [id, p] of Object.entries(best.paths)) (selfIds.has(id) ? loops : rest)[id] = p;
    const spread = spreadParallel(rest, { tables: [...tables, ...validRects(opts.obstacles)], gap, fixed: { ...opts.keep, ...loops }, groups: opts.groups, groupMargin: opts.groupMargin, clearance: opts.clearance });
    best.paths = { ...spread, ...loops };
  }
  return best;
}

// For tables with a loop to themselves: the top corner the rule in
// selfLoopCorner picks from the sides their other lines actually use (paths,
// plus lines that stay: keep). Returns null when every table's first loop sits
// at that corner, else { wanted: {tableKey: corner}, current: {tableKey:
// corner} (where the loops are now), off: [tableKey] (the ones that differ) }.
function loopCornersFor(edges, byKey, paths, keep = {}) {
  const loopIds = new Map();
  for (const e of edges) if (e.fromKey === e.toKey && paths[e.id]) loopIds.set(e.fromKey, [...(loopIds.get(e.fromKey) || []), e.id]);
  if (!loopIds.size) return null;
  const ends = new Map([...loopIds.keys()].map((k) => [k, []]));
  const add = (key, side, otherKey) => ends.get(key)?.push({ side, other: byKey.get(otherKey) });
  const keyOf = (id, end) => { const part = id.split('>')[end === 'from' ? 0 : 1] || ''; return part.slice(0, part.lastIndexOf('.')); };
  const all = { ...keep, ...paths };
  for (const [id, p] of Object.entries(all)) {
    if (!p?.fromSide) continue;
    const f = keyOf(id, 'from'), t = keyOf(id, 'to');
    if (f === t) continue;
    add(f, p.fromSide, t);
    add(t, p.toSide, f);
  }
  const wanted = {}, current = {}, off = [];
  for (const [key, ids] of loopIds) {
    wanted[key] = selfLoopCorner(byKey.get(key), ends.get(key));
    current[key] = paths[[...ids].sort()[0]].fromSide;
    if (current[key] !== wanted[key]) off.push(key);
  }
  return off.length ? { wanted, current, off } : null;
}

// Moves parallel lines apart, up to `gap` (px), without changing any route:
// a segment in the middle of a line (not the first or last, which hold the
// line's entry points) slides across its direction. It stays clear of tables
// and on the same side of the line's own neighbouring corners, so turns stay
// the same. Lines close together push each other apart a little at a time,
// never swapping places, so a crowded spot keeps them as far apart as it has
// room for. A line whose moves would add crossings keeps its old route.
// paths: {id: {points, fromSide, toSide}}; fixed: {id: {points}} lines that
// stay where they are (others keep their distance from them). groups: group
// boxes ({x, y, w, h}); a segment running along one of their edges moves to
// groupMargin from it, where there is room. clearance: the space kept free
// around every table.
export function spreadParallel(paths, { tables = [], gap = 0, fixed = {}, groups = [], groupMargin = GROUP_MARGIN, clearance = CLEARANCE } = {}) {
  groupMargin = spacingOr(groupMargin, GROUP_MARGIN);
  clearance = spacingOr(clearance, CLEARANCE);
  const borders = (groups || []).filter((g) => [g.x, g.y, g.w, g.h].every(Number.isFinite) && g.w > 0 && g.h > 0);
  if (!(gap > GRID) && !(borders.length && groupMargin > 0)) return paths;
  const MIN = GRID;                                  // closest a segment comes to its own corners
  const out = {};
  for (const [id, p] of Object.entries(paths)) out[id] = { ...p, points: simplifyPath(p.points).map(([x, y]) => [x, y]) };

  const segs = [];       // every segment: {id, axis, pos, a, b, move?}
  const addSegs = (id, pts, movable) => {
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      const horizontal = y1 === y2;
      if (horizontal && x1 === x2) continue;
      const axis = horizontal ? 1 : 0;              // the coordinate a move changes
      const s = { id, axis, pos: pts[i][axis], a: Math.min(pts[i - 1][1 - axis], pts[i][1 - axis]), b: Math.max(pts[i - 1][1 - axis], pts[i][1 - axis]) };
      if (movable && i >= 2 && i <= pts.length - 2) {
        let lo = -Infinity, hi = Infinity;
        for (const other of [pts[i - 2][axis], pts[i + 1][axis]]) {
          if (other < s.pos) lo = Math.max(lo, other + MIN); else hi = Math.min(hi, other - MIN);
        }
        for (const t of tables) {
          const t0 = (axis ? t.y : t.x) - clearance, t1 = (axis ? t.y + t.h : t.x + t.w) + clearance;
          const u0 = (axis ? t.x : t.y) - clearance, u1 = (axis ? t.x + t.w : t.y + t.h) + clearance;
          if (u1 <= s.a || u0 >= s.b) continue;      // the table is beside the segment's span
          if (t1 <= s.pos) lo = Math.max(lo, t1); else if (t0 >= s.pos) hi = Math.min(hi, t0);
        }
        if (lo <= s.pos && s.pos <= hi && hi > lo) s.move = { i, lo, hi, orig: s.pos };
      }
      segs.push(s);
    }
  };
  for (const [id, p] of Object.entries(out)) addSegs(id, p.points, true);
  for (const [id, p] of Object.entries(fixed || {})) if (!out[id] && Array.isArray(p?.points)) addSegs(id, p.points, false);
  if (!segs.some((s) => s.move)) return paths;
  // group box edges: segments that don't move, kept groupMargin away from
  if (groupMargin > 0) {
    borders.forEach((g, i) => {
      const id = 'group box ' + i;
      segs.push({ id, border: true, axis: 1, pos: g.y, a: g.x, b: g.x + g.w });
      segs.push({ id, border: true, axis: 1, pos: g.y + g.h, a: g.x, b: g.x + g.w });
      segs.push({ id, border: true, axis: 0, pos: g.x, a: g.y, b: g.y + g.h });
      segs.push({ id, border: true, axis: 0, pos: g.x + g.w, a: g.y, b: g.y + g.h });
    });
  }
  const reach = Math.max(gap, groupMargin);

  // push close parallel segments apart, a little each round
  for (const axis of [0, 1]) {
    const list = segs.filter((s) => s.axis === axis);
    for (let round = 0; round < 40; round++) {
      list.sort((p, q) => p.pos - q.pos || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
      let pushed = false;
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        for (let k = j + 1; k < list.length && list[k].pos - s.pos < reach; k++) {
          const t = list[k];
          if (t.id === s.id || (s.border && t.border) || Math.min(s.b, t.b) - Math.max(s.a, t.a) <= 0) continue;
          const need = (s.border || t.border ? groupMargin : gap) - (t.pos - s.pos);
          if (need <= 0.5) continue;
          // each side takes half; a segment that can't move leaves it to the other
          const sRoom = s.move ? s.pos - s.move.lo : 0, tRoom = t.move ? t.move.hi - t.pos : 0;
          let ds = Math.min(sRoom, need / 2), dt = Math.min(tRoom, need / 2);
          if (ds < need / 2) dt = Math.min(tRoom, need - ds);
          if (dt < need / 2) ds = Math.min(sRoom, need - dt);
          if (ds > 0.01) { s.pos -= ds; pushed = true; }
          if (dt > 0.01) { t.pos += dt; pushed = true; }
        }
      }
      if (!pushed) break;
    }
  }

  const apply = (s, pos) => {
    const pts = out[s.id].points;
    pts[s.move.i - 1][s.axis] = pos;
    pts[s.move.i][s.axis] = pos;
  };
  const movedLines = new Set();
  for (const s of segs) {
    if (!s.move) continue;
    const pos = Math.round(s.pos);
    if (pos !== s.move.orig) { apply(s, pos); movedLines.add(s.id); }
  }
  if (!movedLines.size) return paths;

  // a line whose moves add crossings goes back to its old route
  const fixedList = Object.entries(fixed || {}).filter(([id, p]) => !out[id] && Array.isArray(p?.points)).map(([, p]) => p);
  const total = (set) => countCrossings([...Object.values(set), ...fixedList]);
  if (total(out) > total(paths)) {
    const perLine = (set, id) => {
      const mine = set[id];
      let n = 0;
      for (const [other, p] of Object.entries(set)) if (other !== id) n += countCrossings([mine, p]);
      for (const p of fixedList) n += countCrossings([mine, p]);
      return n;
    };
    for (const id of movedLines) {
      if (perLine(out, id) > perLine(paths, id)) out[id] = paths[id];
    }
  }
  return out;
}

// For each line end, where it belongs on its side, from the way its path
// leaves: lines that turn towards the start of the side come first (the one
// turning nearest the table first), then lines that go straight out, then
// lines that turn towards the end of the side (the one turning nearest last).
// Returns {"id|from|side": [group, key]}.
export function arrivalOrder(paths) {
  const hint = {};
  for (const [id, p] of Object.entries(paths)) {
    const pts = p?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    for (const [end, side, seq] of [['from', p.fromSide, pts], ['to', p.toSide, [...pts].reverse()]]) {
      const [x0, y0] = seq[0];
      const acrossSide = side === 'left' || side === 'right';       // the side runs up and down
      const out = acrossSide ? Math.abs(seq[1][0] - x0) : Math.abs(seq[1][1] - y0);
      const turn = seq.length > 2 ? Math.sign(acrossSide ? seq[2][1] - seq[1][1] : seq[2][0] - seq[1][0]) : 0;
      hint[id + '|' + end + '|' + side] = turn < 0 ? [0, out] : turn > 0 ? [2, -out] : [1, 0];
    }
  }
  return hint;
}

// How many times the lines cross each other.
export function countCrossings(paths) {
  const horizontals = [], verticals = [];
  paths.forEach(({ points }, id) => {
    for (let i = 1; i < (points?.length || 0); i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      if (y1 === y2 && x1 !== x2) horizontals.push({ id, y: y1, x0: Math.min(x1, x2), x1: Math.max(x1, x2) });
      else if (x1 === x2 && y1 !== y2) verticals.push({ id, x: x1, y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
    }
  });
  verticals.sort((a, b) => a.x - b.x);
  let n = 0;
  for (const h of horizontals) {
    let lo = 0, hi = verticals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (verticals[m].x <= h.x0) lo = m + 1; else hi = m; }
    for (let k = lo; k < verticals.length && verticals[k].x < h.x1; k++) {
      const v = verticals[k];
      if (v.id !== h.id && h.y > v.y0 && h.y < v.y1) n++;
    }
  }
  return n;
}

// Whether a stored path still starts and ends on its tables' edges (it stops
// fitting when a table is moved; the line then falls back to a curve).
export function pathFits(path, from, to) {
  const onSide = ([x, y], t, side) => {
    const e = 0.5;
    if (side === 'left') return Math.abs(x - t.x) < e && y >= t.y - e && y <= t.y + t.h + e;
    if (side === 'right') return Math.abs(x - (t.x + t.w)) < e && y >= t.y - e && y <= t.y + t.h + e;
    if (side === 'top') return Math.abs(y - t.y) < e && x >= t.x - e && x <= t.x + t.w + e;
    if (side === 'bottom') return Math.abs(y - (t.y + t.h)) < e && x >= t.x - e && x <= t.x + t.w + e;
    return false;
  };
  const pts = path?.points;
  return Array.isArray(pts) && pts.length >= 2 && onSide(pts[0], from, path.fromSide) && onSide(pts[pts.length - 1], to, path.toSide);
}

// A quick right-angle line between two table edges, used while a table or end
// is being dragged (it doesn't avoid tables; the line is re-routed on drop).
// seg: {fx, fy, tx, ty, fromSide, toSide}.
export function elbowPath(seg) {
  const stub = GRID;
  const a = [seg.fx + OUT[seg.fromSide][0] * stub, seg.fy + OUT[seg.fromSide][1] * stub];
  const b = [seg.tx + OUT[seg.toSide][0] * stub, seg.ty + OUT[seg.toSide][1] * stub];
  const fromVertical = seg.fromSide === 'top' || seg.fromSide === 'bottom';
  const toVertical = seg.toSide === 'top' || seg.toSide === 'bottom';
  const middle = [];
  if (fromVertical === toVertical) {
    // leave and arrive the same way: a step in the middle
    if (fromVertical) { const y = (a[1] + b[1]) / 2; middle.push([a[0], y], [b[0], y]); }
    else { const x = (a[0] + b[0]) / 2; middle.push([x, a[1]], [x, b[1]]); }
  } else {
    middle.push(fromVertical ? [a[0], b[1]] : [b[0], a[1]]);
  }
  const points = [];
  for (const p of [[seg.fx, seg.fy], a, ...middle, b, [seg.tx, seg.ty]]) {
    const last = points.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
  }
  return { points, fromSide: seg.fromSide, toSide: seg.toSide };
}

// Whether a path passes over any of the tables. Touching a table's edge (where
// a line enters) doesn't count, so a line's own tables can be included: a
// line crosses its own table only after that table was moved.
export function pathUnderTables(points, tables) {
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const lx = Math.min(x1, x2), hx = Math.max(x1, x2), ly = Math.min(y1, y2), hy = Math.max(y1, y2);
    for (const t of tables) {
      if (hx > t.x && lx < t.x + t.w && hy > t.y && ly < t.y + t.h) return true;
    }
  }
  return false;
}

// A stored path is still usable when it starts and ends on its tables' edges
// and doesn't cross either of them.
export function pathStillFits(path, from, to) {
  return pathFits(path, from, to) && !pathUnderTables(path.points, from === to ? [from] : [from, to]);
}

// The point halfway along a path.
export function pathMidpoint(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (left <= len && len > 0) return { x: x1 + ((x2 - x1) * left) / len, y: y1 + ((y2 - y1) * left) / len };
    left -= len;
  }
  return { x: points[0][0], y: points[0][1] };
}

// Distance from a point to a path.
export function pathDistance(points, x, y) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

export const JUMP_RADIUS = 5;

// Where lines cross: the horizontal segment jumps over the vertical one.
// paths: [{id, points}]. Returns {id: [[segmentIndex, x], ...]}.
export function pathJumps(paths, minGap = 6) {
  const horizontals = [], verticals = [];
  for (const { id, points } of paths) {
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      if (y1 === y2 && x1 !== x2) horizontals.push({ id, i, y: y1, x0: Math.min(x1, x2), x1: Math.max(x1, x2) });
      else if (x1 === x2 && y1 !== y2) verticals.push({ id, x: x1, y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
    }
  }
  verticals.sort((a, b) => a.x - b.x);
  const jumps = {};
  for (const h of horizontals) {
    // binary search the first vertical inside the horizontal's span
    let lo = 0, hi = verticals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (verticals[m].x <= h.x0 + minGap) lo = m + 1; else hi = m; }
    for (let k = lo; k < verticals.length && verticals[k].x < h.x1 - minGap; k++) {
      const v = verticals[k];
      if (v.id === h.id || h.y <= v.y0 + minGap || h.y >= v.y1 - minGap) continue;
      (jumps[h.id] ||= []).push([h.i, v.x]);
    }
  }
  return jumps;
}

// Lines that would lie on top of each other (sharing part of a lane, or
// leaving one entry point the same way) are drawn side by side instead: each
// overlapping segment is moved a few units across its direction. Corners stay
// right angles, because a horizontal segment only changes y and a vertical
// one only changes x. paths: [{id, points}]. Returns {id: points} for the
// lines that moved.
export const SEPARATION = 4;
export function separateOverlaps(paths, step = SEPARATION) {
  // moving a line aside can put it on yet another line, so repeat until
  // nothing overlaps (a few passes are enough in practice)
  // merge straight runs first (a corner-free point would tilt when moved)
  let current = paths.map((p) => ({ id: p.id, points: simplifyPath(p.points) })), moved = {};
  for (let pass = 0; pass < 6; pass++) {
    const next = separateOnce(current, step);
    if (!Object.keys(next).length) break;
    Object.assign(moved, next);
    current = current.map((p) => (next[p.id] ? { id: p.id, points: next[p.id] } : p));
  }
  return moved;
}

function separateOnce(paths, step) {
  const groups = new Map();   // "h|y" or "v|x" -> segments on that line
  for (const { id, points } of paths) {
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1], [x2, y2] = points[i];
      let key, lo, hi;
      if (y1 === y2 && x1 !== x2) { key = 'h|' + y1; lo = Math.min(x1, x2); hi = Math.max(x1, x2); }
      else if (x1 === x2 && y1 !== y2) { key = 'v|' + x1; lo = Math.min(y1, y2); hi = Math.max(y1, y2); }
      else continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ id, i, lo, hi, color: 0 });
    }
  }
  const offsetOf = (c) => (c % 2 ? 1 : -1) * Math.ceil(c / 2) * step;   // 0, +s, -s, +2s, -2s …
  const moves = new Map();    // id -> [{i, axis, d}]
  for (const [key, segs] of groups) {
    if (segs.length < 2) continue;
    segs.sort((a, b) => a.lo - b.lo || a.id.localeCompare(b.id) || a.i - b.i);
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      const taken = new Set();
      for (let j = 0; j < k; j++) {
        const o = segs[j];
        if (o.id !== s.id && Math.min(o.hi, s.hi) - Math.max(o.lo, s.lo) > 1) taken.add(o.color);
      }
      while (taken.has(s.color)) s.color++;
      if (s.color) {
        if (!moves.has(s.id)) moves.set(s.id, []);
        moves.get(s.id).push({ i: s.i, axis: key[0] === 'h' ? 1 : 0, d: offsetOf(s.color) });
      }
    }
  }
  const out = {};
  for (const { id, points } of paths) {
    const m = moves.get(id);
    if (!m) continue;
    const pts = points.map((p) => [p[0], p[1]]);
    for (const { i, axis, d } of m) { pts[i - 1][axis] += d; pts[i][axis] += d; }
    out[id] = pts;
  }
  return out;
}

// Drops repeated points and points in the middle of a straight run.
function simplifyPath(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((a[0] === last[0] && last[0] === p[0]) || (a[1] === last[1] && last[1] === p[1])) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

// Moves one segment of a straight path sideways, the way the user drags it:
// segment i joins points i-1 and i; value is the new y of a horizontal segment
// or the new x of a vertical one, snapped to the grid. A segment that touches a
// table slides that end along the table's side and stays on it; the segments
// next to a table keep leaving it outwards. Returns the new path (marked as
// placed by hand), or null when the segment can't be moved.
export function moveSegment(path, i, value, from, to) {
  const pts = path?.points;
  if (!Array.isArray(pts) || i < 1 || i >= pts.length) return null;
  const [a, b] = [pts[i - 1], pts[i]];
  const horizontal = a[1] === b[1];
  if (!horizontal && a[0] !== b[0]) return null;
  const k = horizontal ? 1 : 0;                      // the coordinate that changes
  let lo = -Infinity, hi = Infinity;
  const last = pts.length - 1;
  // an end on a table stays on its side, away from the corners
  const along = (t) => {
    const start = horizontal ? t.y : t.x, size = horizontal ? t.h : t.w;
    lo = Math.max(lo, Math.ceil((start + 6) / GRID) * GRID);
    hi = Math.min(hi, Math.floor((start + size - 6) / GRID) * GRID);
  };
  if (i === 1) along(from);
  if (i === last) along(to);
  // a segment next to the table's stub stays at least one grid step outside it
  const outside = (t, side) => {
    if (side === 'right') lo = Math.max(lo, t.x + t.w + GRID);
    if (side === 'left') hi = Math.min(hi, t.x - GRID);
    if (side === 'bottom') lo = Math.max(lo, t.y + t.h + GRID);
    if (side === 'top') hi = Math.min(hi, t.y - GRID);
  };
  const vertical = (side) => side === 'top' || side === 'bottom';
  if (i === 2 && horizontal === vertical(path.fromSide)) outside(from, path.fromSide);
  if (i === last - 1 && horizontal === vertical(path.toSide)) outside(to, path.toSide);
  if (lo > hi) return null;
  const v = Math.min(hi, Math.max(lo, Math.round(value / GRID) * GRID));
  const next = pts.map((p) => [p[0], p[1]]);
  next[i - 1][k] = v;
  next[i][k] = v;
  return { points: simplifyPath(next), fromSide: path.fromSide, toSide: path.toSide, hand: true };
}

// Whether a table's side looks away from another table: the other table lies
// entirely behind it (a line leaving that side would have to turn back).
export function sideFacesAway(table, side, other) {
  if (!table || !other || table === other) return false;
  if (side === 'right') return other.x + other.w <= table.x;
  if (side === 'left') return other.x >= table.x + table.w;
  if (side === 'bottom') return other.y + other.h <= table.y;
  if (side === 'top') return other.y >= table.y + table.h;
  return false;
}

// A line shaped by hand, after its tables moved by fromDelta / toDelta
// ([dx, dy], the tables' new spots are from / to). When both tables moved the
// same way the whole line moves with them. Otherwise each end moves with its
// table and the segment touching it stretches, while every other bend stays.
// Returns the new path (still marked as shaped by hand), or null when the shape
// no longer works: it would cross a table (tables: every visible table) or turn
// back into its own table.
export function followMove(path, from, to, fromDelta, toDelta, tables = []) {
  const pts = path?.points;
  if (!Array.isArray(pts) || pts.length < 2 || !from || !to) return null;
  const snap = (v) => Math.round(v / GRID) * GRID;
  const together = fromDelta[0] === toDelta[0] && fromDelta[1] === toDelta[1];
  const shift = together ? [snap(fromDelta[0]), snap(fromDelta[1])] : [0, 0];
  const next = pts.map(([x, y]) => [x + shift[0], y + shift[1]]);
  const last = next.length - 1;
  // an end: on its table's side, at its old spot along the side (moved with the
  // table and kept on the grid, away from the corners)
  const place = (i, table, side, delta, old) => {
    const across = side === 'left' || side === 'right';       // the side runs up and down
    const k = across ? 1 : 0;                                  // the coordinate along the side
    const start = across ? table.y : table.x, size = across ? table.h : table.w;
    const lo = Math.ceil((start + 6) / GRID) * GRID, hi = Math.floor((start + size - 6) / GRID) * GRID;
    if (lo > hi) return false;
    next[i][k] = Math.min(hi, Math.max(lo, together ? old[k] + shift[k] : snap(old[k] + delta[k])));
    next[i][1 - k] = side === 'left' ? table.x : side === 'right' ? table.x + table.w : side === 'top' ? table.y : table.y + table.h;
    // the point next to it keeps the segment square to the side
    const j = i === 0 ? 1 : last - 1;
    if (j !== i && j > 0 && j < last) next[j][k] = next[i][k];
    return true;
  };
  if (!place(0, from, path.fromSide, fromDelta, pts[0]) || !place(last, to, path.toSide, toDelta, pts[last])) return null;
  const out = simplifyPath(next);
  // still square, still leaving each table outwards, and clear of every table
  for (let i = 1; i < out.length; i++) if (out[i - 1][0] !== out[i][0] && out[i - 1][1] !== out[i][1]) return null;
  if (out.length < 2) return null;
  const leaves = (a, b, side) => (b[0] - a[0]) * OUT[side][0] + (b[1] - a[1]) * OUT[side][1] > 0;
  if (!leaves(out[0], out[1], path.fromSide) || !leaves(out[out.length - 1], out[out.length - 2], path.toSide)) return null;
  const result = { points: out, fromSide: path.fromSide, toSide: path.toSide, hand: true };
  if (!pathStillFits(result, from, to) || pathUnderTables(out, tables)) return null;
  return result;
}

// The segment of a path nearest to a point: { index, distance }.
export function nearestSegment(points, x, y) {
  let best = { index: -1, distance: Infinity };
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    const cx = Math.max(Math.min(x1, x2), Math.min(Math.max(x1, x2), x));
    const cy = Math.max(Math.min(y1, y2), Math.min(Math.max(y1, y2), y));
    const d = Math.hypot(x - cx, y - cy);
    if (d < best.distance) best = { index: i, distance: d };
  }
  return best;
}

// Routing for the lines of a table being moved: a quick pass for every line
// (reported through onQuick, so they can be shown at once), then the careful
// search for the few lines the quick pass couldn't route, around the others.
// Holding a table and letting it go both use this, so they give the same lines.
// spacing: lineGap, groupMargin and clearance, as for routeStraight.
export function routeMoved(edges, byKey, { anchors = {}, isHidden = () => false, keep = {}, groups = [], ...spacing } = {}, onQuick = null) {
  const quick = routeStraight(edges, byKey, { ...spacing, anchors, isHidden, keep, groups, fast: true });
  if (!quick.failed.length) return quick;
  onQuick?.(quick);
  const rest = edges.filter((e) => quick.failed.includes(e.id));
  const careful = routeStraight(rest, byKey, { ...spacing, anchors, isHidden, groups, keep: { ...keep, ...quick.paths } });
  return {
    paths: { ...quick.paths, ...careful.paths },
    failed: careful.failed,
    overlapping: [...quick.overlapping, ...careful.overlapping],
  };
}
