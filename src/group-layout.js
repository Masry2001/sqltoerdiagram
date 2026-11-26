// Tables inside group boxes, for the MCP "organize groups" command
// (mcp/bridge.js): how a box packs its tables, how many relation lines cross,
// and the table order inside each box that makes them cross least.
//
// Pure functions: no DOM, so they can be tested in Node.
import { autoLineGap } from './orthogonal-router.js';

// Packs tables into columns, each new table going to the shortest column.
export function packGroup(tables, gap) {
  const columnWidth = Math.max(...tables.map((t) => t.w));
  const area = tables.reduce((sum, t) => sum + (columnWidth + gap) * (t.h + gap), 0);
  const count = Math.max(1, Math.min(tables.length, Math.round(Math.sqrt(area * 1.6) / (columnWidth + gap))));
  const heights = new Array(count).fill(0);
  const placed = [];
  for (const t of tables) {
    const column = heights.indexOf(Math.min(...heights));
    placed.push({ table: t, x: column * (columnWidth + gap), y: heights[column] });
    heights[column] += t.h + gap;
  }
  return {
    placed,
    w: count * columnWidth + (count - 1) * gap,
    h: Math.max(...heights) - gap,
  };
}

const turn = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));

// Whether the straight lines p1-p2 and p3-p4 cross (touching doesn't count).
export function segmentsCross(p1, p2, p3, p4) {
  return turn(p1, p2, p3) * turn(p1, p2, p4) < 0 && turn(p3, p4, p1) * turn(p3, p4, p2) < 0;
}

// How many pairs of lines cross, each line judged on the straight line between
// its two tables' centres. Lines that share a table don't count.
// lines: [[keyA, keyB]]; centre: key -> [x, y].
export function countCentreCrossings(lines, centre) {
  const segs = lines.map(([a, b]) => ({ a, b, p: centre(a), q: centre(b) }));
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j];
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) continue;
      if (segmentsCross(s.p, s.q, t.p, t.q)) n++;
    }
  }
  return n;
}

// Chooses the order of the tables inside each group box (which decides where
// packGroup puts them) so that relation lines cross as little as possible,
// lines to tables in other boxes included; among orders with as many
// crossings, shorter lines win.
//   1. Barycentric: each table goes to the spot nearest the middle of the
//      tables it is joined to.
//   2. Swaps: two tables of a box trade places while that lowers the count.
// A change is kept only when it is better, so the result never has more
// crossings than the order given. Stops after `timeLimit` ms.
//
// boxes: [{ x, y, order: [{key, w, h}] }]; a table's centre is
//   (box.x + box.inset + its packed x + w/2, box.y + header + its packed y + h/2).
//   A box may bring its own padding and header, and minW (it never gets
//   narrower; the tables are centred in it). Sets box.order, box.pack, box.w,
//   box.h and box.inset.
// lines: [[keyA, keyB]] (lines to tables outside the boxes are ignored).
// place(boxes): optional; sets box.x / box.y again after a box changed size.
// Returns { before, after } crossings.
export function orderTablesInGroups(boxes, lines, { gap, padding, header, place = null, timeLimit = 1500, now = () => Date.now() }) {
  const started = now();
  const boxOf = new Map();
  for (const box of boxes) for (const t of box.order) boxOf.set(t.key, box);
  lines = lines.filter(([a, b]) => a !== b && boxOf.has(a) && boxOf.has(b));
  const pos = new Map();
  const centre = (key) => pos.get(key);
  const repack = (box) => {
    const pad = box.padding ?? padding;
    box.pack = packGroup(box.order, gap);
    box.w = Math.max(box.minW ?? 0, box.pack.w + pad * 2);
    box.h = box.pack.h + pad + (box.header ?? header);
    box.inset = (box.w - box.pack.w) / 2;
  };
  const settle = () => {
    place?.(boxes);
    for (const box of boxes) {
      const top = box.y + (box.header ?? header);
      for (const p of box.pack.placed) pos.set(p.table.key, [box.x + box.inset + p.x + p.table.w / 2, top + p.y + p.table.h / 2]);
    }
  };
  const score = () => {
    settle();
    let length = 0;
    for (const [a, b] of lines) length += Math.hypot(centre(a)[0] - centre(b)[0], centre(a)[1] - centre(b)[1]);
    return { crossings: countCentreCrossings(lines, centre), length };
  };
  const better = (a, b) => a.crossings < b.crossings || (a.crossings === b.crossings && a.length < b.length - 0.5);
  const overTime = () => now() - started > timeLimit;

  boxes.forEach(repack);
  let current = score();
  const before = current.crossings;
  if (!lines.length) return { before, after: before };

  // keeps a box's new order when the whole layout gets better
  const tryOrder = (box, next) => {
    const old = box.order;
    box.order = next;
    repack(box);
    const s = score();
    if (better(s, current)) { current = s; return true; }
    box.order = old;
    repack(box);
    settle();
    return false;
  };

  const neighbours = new Map();
  for (const [a, b] of lines) {
    neighbours.set(a, [...(neighbours.get(a) || []), b]);
    neighbours.set(b, [...(neighbours.get(b) || []), a]);
  }
  // each joined table to the free spot nearest the middle of its neighbours,
  // closest pairs first; tables without lines fill the rest in their order
  const barycentric = (box) => {
    const n = box.order.length;
    const spots = box.pack.placed.map((p) => centre(p.table.key));
    const pairs = [];
    box.order.forEach((t, i) => {
      const others = neighbours.get(t.key);
      if (!others) return;
      const mx = others.reduce((s, k) => s + centre(k)[0], 0) / others.length;
      const my = others.reduce((s, k) => s + centre(k)[1], 0) / others.length;
      spots.forEach(([x, y], j) => pairs.push([Math.hypot(mx - x, my - y), i, j]));
    });
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const spotOf = new Array(n).fill(-1), taken = new Array(n).fill(false);
    for (const [, i, j] of pairs) if (spotOf[i] < 0 && !taken[j]) { spotOf[i] = j; taken[j] = true; }
    let free = 0;
    for (let i = 0; i < n; i++) {
      if (spotOf[i] >= 0) continue;
      while (taken[free]) free++;
      spotOf[i] = free;
      taken[free] = true;
    }
    const next = new Array(n);
    box.order.forEach((t, i) => { next[spotOf[i]] = t; });
    return next;
  };

  for (let round = 0; round < 3 && !overTime(); round++) {
    let changed = false;
    for (const box of boxes) if (box.order.length > 1 && tryOrder(box, barycentric(box))) changed = true;
    if (!changed) break;
  }
  for (let round = 0; round < 20 && !overTime(); round++) {
    let improved = false;
    for (const box of boxes) {
      const n = box.order.length;
      for (let i = 0; i < n - 1 && !overTime(); i++) {
        for (let j = i + 1; j < n; j++) {
          const next = [...box.order];
          [next[i], next[j]] = [next[j], next[i]];
          if (tryOrder(box, next)) improved = true;
        }
      }
    }
    if (!improved) break;
  }
  settle();
  return { before, after: current.crossings };
}

// "Arrange inside groups": re-packs the tables of every group box, in the
// order that makes relation lines cross least (orderTablesInGroups), and keeps
// the groups where they are. A table belongs to the smallest box holding its
// centre; tables outside every box stay put. Each box keeps its padding, the
// space above its tables (its name) and at least its width; a box that grows
// or shrinks pushes or pulls the boxes below and beside it, so the space
// between boxes stays as it was.
// Without group boxes, every table is in one group (with no box drawn): the
// tables are packed from the diagram's top-left corner.
// frames: group boxes [{x, y, w, h, ...}]; tables: visible tables [{key, x, y, w, h}];
// lines: [[keyA, keyB]]; gap: space between tables (default: the usual space
// between tables inside the groups now).
// Returns { positions: {key: {x, y}}, frames: [frame with new x, y, w, h], before, after }
// (before / after: crossings of the lines between table centres).
export function arrangeInGroups(frames, tables, lines, { gap = null, timeLimit = 1500 } = {}) {
  const contains = (f, t) => {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
  };
  const whole = !frames.length && tables.length > 0;
  if (whole) {
    const x0 = Math.min(...tables.map((t) => t.x)), y0 = Math.min(...tables.map((t) => t.y));
    const x1 = Math.max(...tables.map((t) => t.x + t.w)), y1 = Math.max(...tables.map((t) => t.y + t.h));
    frames = [{ x: x0 - 36, y: y0 - 44, w: x1 - x0 + 72, h: y1 - y0 + 80 }];
  }
  const boxes = frames.map((frame) => ({ frame, x: frame.x, y: frame.y, w: frame.w, h: frame.h, order: [] }));
  for (const t of tables) {
    const holders = boxes.filter((b) => contains(b.frame, t));
    if (holders.length) holders.reduce((a, b) => (b.frame.w * b.frame.h < a.frame.w * a.frame.h ? b : a)).order.push(t);
  }
  const filled = boxes.filter((b) => b.order.length);
  const grouped = filled.flatMap((b) => b.order);
  const start = new Map(tables.map((t) => [t.key, [t.x + t.w / 2, t.y + t.h / 2]]));
  const known = new Set(tables.map((t) => t.key));
  const shown = lines.filter(([a, b]) => a !== b && known.has(a) && known.has(b));
  const before = countCentreCrossings(shown, (k) => start.get(k));
  if (!filled.length) return { positions: {}, frames: frames.map((f) => ({ ...f })), before, after: before };

  const usual = Math.round(autoLineGap(grouped) * 3);
  gap = Math.max(16, Number.isFinite(+gap) && gap != null ? +gap : usual || 36);
  for (const box of filled) {
    // reading order to start from: columns left to right, each top to bottom
    box.order.sort((a, b) => (Math.abs(a.x - b.x) > 10 ? a.x - b.x : a.y - b.y));
    box.padding = Math.max(16, Math.min(...box.order.map((t) => t.x - box.frame.x)));
    box.header = Math.max(32, Math.min(...box.order.map((t) => t.y - box.frame.y)));
    box.minW = whole ? 0 : box.frame.w;
  }

  // boxes push the ones below and beside them, keeping the old spaces
  const all = boxes;
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
  const above = new Map(all.map((b) => [b, all.filter((a) => a !== b && a.frame.y + a.frame.h <= b.frame.y + 1
    && overlaps(a.frame.x, a.frame.x + a.frame.w, b.frame.x, b.frame.x + b.frame.w))]));
  const left = new Map(all.map((b) => [b, all.filter((a) => a !== b && a.frame.x + a.frame.w <= b.frame.x + 1
    && overlaps(a.frame.y, a.frame.y + a.frame.h, b.frame.y, b.frame.y + b.frame.h))]));
  const byY = [...all].sort((a, b) => a.frame.y - b.frame.y);
  const byX = [...all].sort((a, b) => a.frame.x - b.frame.x);
  const place = () => {
    for (const b of byX) {
      const l = left.get(b);
      b.x = l.length ? Math.max(...l.map((a) => a.x + a.w + (b.frame.x - (a.frame.x + a.frame.w)))) : b.frame.x;
    }
    for (const b of byY) {
      const u = above.get(b);
      b.y = u.length ? Math.max(...u.map((a) => a.y + a.h + (b.frame.y - (a.frame.y + a.frame.h)))) : b.frame.y;
    }
  };

  const result = orderTablesInGroups(filled, shown, { gap, padding: 36, header: 44, place, timeLimit });
  const positions = {};
  for (const box of filled) {
    for (const p of box.pack.placed) positions[p.table.key] = { x: Math.round(box.x + box.inset + p.x), y: Math.round(box.y + box.header + p.y) };
  }
  const end = new Map(start);
  for (const t of tables) if (positions[t.key]) end.set(t.key, [positions[t.key].x + t.w / 2, positions[t.key].y + t.h / 2]);
  return {
    positions,
    frames: whole ? [] : boxes.map((b) => ({ ...b.frame, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })),
    before,
    after: countCentreCrossings(shown, (k) => end.get(k)),
    gap,
    reordered: result,
  };
}
