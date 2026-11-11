// "Arrange lines straight": routes every relation line as horizontal and
// vertical segments on a grid.
//
//  - Tables (plus a margin) are walls, so lines go around them, never behind.
//  - Each grid segment carries at most one line, so lines never lie on top of
//    each other; they may cross, and a crossing is drawn as a small jump.
//  - Every line end gets its own point on its table's edge, ordered by where
//    the line goes; a full side passes ends on to the next side.
//
// Pure functions: no DOM, so the router can be tested in Node.
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
const CLEARANCE = GRID;        // space kept free around every table
const PAD_CELLS = 24;          // free border around the whole diagram
const BEND_COST = 16;            // a turn costs as much as this many extra steps
const GROUP_COST = 6;           // each step inside a group the line doesn't belong to
const CROSS_COST = 3;
const SOFT_OVERLAP_COST = 60;  // last resort when no clean path exists
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
export function routeStraight(edges, byKey, { anchors = {}, isHidden = () => false, keep = {}, area = null, fast = false, groups = [] } = {}) {
  let tables = [...byKey.values()].filter((t) => Number.isFinite(t.x) && !isHidden(t.key));
  if (area) {
    const own = new Set(edges.flatMap((e) => [e.fromKey, e.toKey]));
    tables = tables.filter((t) => own.has(t.key)
      || (t.x < area.x1 && t.x + t.w > area.x0 && t.y < area.y1 && t.y + t.h > area.y0));
  }
  if (!tables.length) return { paths: {}, failed: [], overlapping: [] };

  // ---- grid ----
  const minX = Math.min(...tables.map((t) => t.x)), minY = Math.min(...tables.map((t) => t.y));
  const maxX = Math.max(...tables.map((t) => t.x + t.w)), maxY = Math.max(...tables.map((t) => t.y + t.h));
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
    const c0 = Math.max(0, Math.ceil((t.x - CLEARANCE - ox) / GRID));
    const c1 = Math.min(cols - 1, Math.floor((t.x + t.w + CLEARANCE - ox) / GRID));
    const r0 = Math.max(0, Math.ceil((t.y - CLEARANCE - oy) / GRID));
    const r1 = Math.min(rows - 1, Math.floor((t.y + t.h + CLEARANCE - oy) / GRID));
    box.set(t.key, { c0, c1, r0, r1 });
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
  // the groups a table belongs to (its centre is inside the box)
  const groupsOf = (t) => {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    return boxes.filter((g) => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h).map((g) => g.id);
  };

  // ---- ports: every end gets its own grid line on a side ----
  const work = [];
  for (const edge of edges) {
    const from = byKey.get(edge.fromKey), to = byKey.get(edge.toKey);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x) || isHidden(from.key) || isHidden(to.key)) continue;
    work.push({ edge, id: edge.id, from, to, ends: {}, home: boxes.length ? new Set([...groupsOf(from), ...groupsOf(to)]) : null });
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
        const r = (y1 - oy) / GRID;
        if (!Number.isInteger(r)) continue;
        const c0 = Math.ceil((Math.min(x1, x2) - ox) / GRID), c1 = Math.floor((Math.max(x1, x2) - ox) / GRID);
        for (let c = c0; c < c1; c++) if (inGrid(c, r) && !hOwner[at(c, r)]) hOwner[at(c, r)] = owner;
      } else if (x1 === x2) {
        const c = (x1 - ox) / GRID;
        if (!Number.isInteger(c)) continue;
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
      // a table referring to itself leaves and returns on different sides
      if (item.from === item.to && end === 'to') ranking.push(ranking.splice(ranking.indexOf(item.ends.from?.side ?? ranking[0]), 1)[0]);
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
    if (item.from === item.to) continue;
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

  for (const list of sideLists.values()) {
    // other ends keep off the straight lines' cells
    const mine = new Set(list.ends.filter((e) => fixedSlot.has(e)).map((e) => at(fixedSlot.get(e).c, fixedSlot.get(e).r)));
    const slots = slotsOf(list.table, list.side).filter((s) => !reserved.has(at(s.c, s.r)) || mine.has(at(s.c, s.r)));
    const vertical = list.side === 'top' || list.side === 'bottom';
    const along = (e) => (vertical ? centerOf(e.other).x : centerOf(e.other).y);
    list.ends.sort((a, b) => along(a) - along(b) || a.item.id.localeCompare(b.item.id));
    const n = list.ends.length;
    const used = new Set();
    // straight lines and ends placed by hand choose their slot first, the
    // rest spread in order
    const rankOf = (e) => (fixedSlot.has(e) ? 2 : e.hand ? 1 : 0);
    const handFirst = list.ends.map((entry, i) => ({ entry, i })).sort((p, q) => rankOf(q.entry) - rankOf(p.entry));
    handFirst.forEach(({ entry, i }) => {
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

  function search(item, owner, start, goal, window, soft, limit = MAX_EXPANSIONS, w = 1) {
    searchId = (searchId + 1) | 0 || 1;
    const heap = new MinHeap();
    // distance, plus one turn when the goal isn't straight ahead on a line
    const h = (c, r) => Math.abs(c - goal.c) + Math.abs(r - goal.r) + (c !== goal.c && r !== goal.r ? BEND_COST : 0);
    const home = item.home;
    const startDir = DIRS.findIndex(([dx, dy]) => dx === OUT[item.ends.from.side][0] && dy === OUT[item.ends.from.side][1]);
    const s0 = at(start.c, start.r) * 4 + startDir;
    stamp[s0] = searchId; gScore[s0] = 0; parent[s0] = -1;
    heap.push(h(start.c, start.r), s0);
    const goalCell = at(goal.c, goal.r);
    const inDir = DIRS.findIndex(([dx, dy]) => dx === -OUT[item.ends.to.side][0] && dy === -OUT[item.ends.to.side][1]);
    let best = -1;
    let expansions = 0;
    while (heap.size) {
      const state = heap.pop();
      const cell = state >> 2, dir = state & 3;
      const g = gScore[state];
      if (cell === goalCell) { best = state; break; }
      if (++expansions > limit) break;
      const c = cell % cols, r = (cell / cols) | 0;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((dir + 2) & 3)) continue;              // no U-turns
        const [dx, dy] = DIRS[nd];
        const nc = c + dx, nr = r + dy;
        if (nc < window.c0 || nc > window.c1 || nr < window.r0 || nr > window.r1) continue;
        const ncell = at(nc, nr);
        if (blocked[ncell]) continue;
        const so = stubOwner[ncell];
        if (so && so !== owner) continue;
        // the segment between the two cells
        const horizontal = dy === 0;
        const ek = horizontal ? at(Math.min(c, nc), r) : at(c, Math.min(r, nr));
        const eo = horizontal ? hOwner[ek] : vOwner[ek];
        let cost = 1;
        if (eo && eo !== owner) { if (!soft) continue; cost += SOFT_OVERLAP_COST; }
        if (nd !== dir) cost += BEND_COST;
        // crossing a line that runs across this cell the other way
        const crossOwners = horizontal
          ? (vOwner[ncell] || (nr > 0 && vOwner[at(nc, nr - 1)]))
          : (hOwner[ncell] || (nc > 0 && hOwner[at(nc - 1, nr)]));
        if (crossOwners && crossOwners !== owner) cost += CROSS_COST;
        const grp = groupAt[ncell];
        if (grp && !home?.has(grp)) cost += GROUP_COST;
        if (ncell === goalCell && nd !== inDir) cost += BEND_COST;
        const next = ncell * 4 + nd;
        const ng = g + cost;
        if (stamp[next] === searchId && gScore[next] <= ng) continue;
        stamp[next] = searchId; gScore[next] = ng; parent[next] = state;
        heap.push(ng + w * h(nc, nr), next);
      }
    }
    if (best < 0) return null;
    const cells = [];
    for (let s = best; s >= 0; s = stamp[s] === searchId ? parent[s] : -1) cells.push(s >> 2);
    return cells.reverse();
  }

  const paths = {};
  const failed = [];
  const overlapping = [];
  const manhattan = (item) => Math.abs(centerOf(item.from).x - centerOf(item.to).x) + Math.abs(centerOf(item.from).y - centerOf(item.to).y);
  // straight lines go first, so no other line takes their grid line
  const order = [...work].sort((a, b) => (b.straight ? 1 : 0) - (a.straight ? 1 : 0) || manhattan(a) - manhattan(b) || a.id.localeCompare(b.id));
  for (const item of order) {
    const a = item.ends.from, b = item.ends.to;
    if (item.failed || a?.c === undefined || b?.c === undefined) { failed.push(item.id); continue; }
    const owner = work.indexOf(item) + 1;
    const near = {
      c0: Math.max(0, Math.min(a.c, b.c) - WINDOW_CELLS), c1: Math.min(cols - 1, Math.max(a.c, b.c) + WINDOW_CELLS),
      r0: Math.max(0, Math.min(a.r, b.r) - WINDOW_CELLS), r1: Math.min(rows - 1, Math.max(a.r, b.r) + WINDOW_CELLS),
    };
    const all = { c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 };
    // a clean path near the two tables; failing that, the cheapest path that
    // shares as few segments as possible
    const cells = fast
      ? search(item, owner, a, b, near, true, FAST_EXPANSIONS, FAST_WEIGHT) || search(item, owner, a, b, all, true, FAST_EXPANSIONS * 2, FAST_WEIGHT)
      : search(item, owner, a, b, near, false) || search(item, owner, a, b, near, true) || search(item, owner, a, b, all, true);
    if (!cells) { failed.push(item.id); continue; }
    let shares = false;
    for (let i = 1; i < cells.length; i++) {
      const p = cells[i - 1], q = cells[i];
      const pc = p % cols, pr = (p / cols) | 0, qc = q % cols, qr = (q / cols) | 0;
      const owners = pr === qr ? hOwner : vOwner;
      const k = pr === qr ? at(Math.min(pc, qc), pr) : at(pc, Math.min(pr, qr));
      if (owners[k] && owners[k] !== owner) shares = true;
      else owners[k] = owner;
    }
    if (shares) overlapping.push(item.id);
    // corners only, from the table edge out and back to the other table edge
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
    paths[item.id] = { points: pts, fromSide: a.side, toSide: b.side };
  }
  return { paths, failed, overlapping };
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
export function routeMoved(edges, byKey, { anchors = {}, isHidden = () => false, keep = {}, groups = [] } = {}, onQuick = null) {
  const quick = routeStraight(edges, byKey, { anchors, isHidden, keep, groups, fast: true });
  if (!quick.failed.length) return quick;
  onQuick?.(quick);
  const rest = edges.filter((e) => quick.failed.includes(e.id));
  const careful = routeStraight(rest, byKey, { anchors, isHidden, groups, keep: { ...keep, ...quick.paths } });
  return {
    paths: { ...quick.paths, ...careful.paths },
    failed: careful.failed,
    overlapping: [...quick.overlapping, ...careful.overlapping],
  };
}
