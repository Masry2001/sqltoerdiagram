// "Arrange lines": picks, for every relation line, the sides it leaves and
// enters its tables and how much it bends, so that lines avoid other tables and
// cross each other as little as possible. Then every line gets its own entry
// point: no two lines share a spot on a table's edge.
//
// The result is stored like hand-placed lines (end anchors and bends), so each
// line can still be adjusted, or reset with a double-click.
import { curveBetween, anchorPoint, isVerticalSide, OUTWARD } from './edge-routing.js';
import { columnY } from './renderer.js';

const SAMPLES = 16;
const BEND_FRACTIONS = [0, 0.2, -0.2, 0.45, -0.45];
const SIDE_GAP = 24;            // preferred space between entry points on a side
const MIN_GAP = 12;             // entry points never closer than this
const CELL = 400;
export const DEFAULT_WEIGHTS = {
  table: 1000,                  // a line passing under another table
  crossing: 150,                // a line crossing an already placed line
  crowd: 400,                   // each line beyond what a table side has room for
};

const centerOf = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });

function samplePoints(curve) {
  const pts = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES, v = 1 - u;
    const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    pts.push([
      a * curve.fx + b * curve.c1x + c * curve.c2x + d * curve.tx,
      a * curve.fy + b * curve.c1y + c * curve.c2y + d * curve.ty,
    ]);
  }
  return pts;
}

function boundsOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function segmentsCross(p, q, r, s) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return o(r, s, p) * o(r, s, q) < 0 && o(p, q, r) * o(p, q, s) < 0;
}

function countCrossings(a, b) {
  if (a.box.x1 < b.box.x0 || b.box.x1 < a.box.x0 || a.box.y1 < b.box.y0 || b.box.y1 < a.box.y0) return 0;
  let n = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      if (segmentsCross(a.pts[i], a.pts[i + 1], b.pts[j], b.pts[j + 1])) n++;
    }
  }
  return n;
}

// Spatial index of table rectangles, to find the tables a line passes under.
function tableIndex(tables) {
  const cells = new Map();
  for (const t of tables) {
    for (let cx = Math.floor(t.x / CELL); cx <= Math.floor((t.x + t.w) / CELL); cx++) {
      for (let cy = Math.floor(t.y / CELL); cy <= Math.floor((t.y + t.h) / CELL); cy++) {
        const k = cx + ',' + cy;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(t);
      }
    }
  }
  return (x, y) => cells.get(Math.floor(x / CELL) + ',' + Math.floor(y / CELL)) || [];
}

function tablesUnder(pts, tablesAt, skip) {
  const hit = new Set();
  for (const [x, y] of pts) {
    for (const t of tablesAt(x, y)) {
      if (skip.has(t.key) || hit.has(t.key)) continue;
      if (x > t.x + 2 && x < t.x + t.w - 2 && y > t.y + 2 && y < t.y + t.h - 2) hit.add(t.key);
    }
  }
  return hit.size;
}

// Sides of a table that face the other table (at most two).
function facingSides(table, other) {
  const a = centerOf(table), b = centerOf(other);
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return Object.entries(OUTWARD)
    .filter(([, [ox, oy]]) => (ox * dx + oy * dy) / length > -0.15)
    .map(([side]) => side);
}

function candidatesFor(from, to) {
  const out = [];
  const a = centerOf(from), b = centerOf(to);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
  for (const fromSide of facingSides(from, to)) {
    for (const toSide of facingSides(to, from)) {
      for (const k of BEND_FRACTIONS) {
        const bend = k ? { x: nx * length * k, y: ny * length * k } : null;
        out.push({ fromSide, toSide, bend });
      }
    }
  }
  return out;
}

function curveFor(from, to, choice, fromT = 0.5, toT = 0.5) {
  const fromEnd = { ...anchorPoint(from, { side: choice.fromSide, t: fromT }), side: choice.fromSide };
  const toEnd = { ...anchorPoint(to, { side: choice.toSide, t: toT }), side: choice.toSide };
  return curveBetween(fromEnd, toEnd, choice.bend);
}

function makeLine(curve) {
  const pts = samplePoints(curve);
  return { pts, box: boundsOf(pts), length: pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) };
}

const sideLength = (table, side) => (isVerticalSide(side) ? table.w : table.h);
const sideCapacity = (table, side) => Math.max(1, Math.floor(sideLength(table, side) / SIDE_GAP));

// Places points along one side, at least `gap` apart and inside [lo, hi], each
// as close to where it wants to be as possible. Locked points don't move.
function spreadPoints(points, gap, lo, hi) {
  points.sort((p, q) => p.want - q.want || (p.locked ? -1 : 0) || String(p.id).localeCompare(String(q.id)));
  for (const p of points) p.pos = p.locked ? p.want : Math.min(hi, Math.max(lo, p.want));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (!p.locked && p.pos < points[i - 1].pos + gap) p.pos = Math.min(hi, points[i - 1].pos + gap);
    }
    for (let i = points.length - 2; i >= 0; i--) {
      const p = points[i];
      if (!p.locked && p.pos > points[i + 1].pos - gap) p.pos = Math.max(lo, points[i + 1].pos - gap);
    }
  }
}

// Gives every end on one side of a table its own point. Ends on the top or
// bottom are spread evenly, in the order of where they go. Ends on the left or
// right stay as close as possible to their column row. Hand-placed ends stay.
function spreadSide(table, side, ends, lockedTs) {
  const vertical = isVerticalSide(side);
  const length = sideLength(table, side);
  const inset = 6;
  const count = ends.length + lockedTs.length;
  const gap = Math.max(Math.min(SIDE_GAP, (length - inset * 2) / Math.max(1, count)), Math.min(MIN_GAP, length / (count + 1)));
  const start = vertical ? table.x : table.y;
  const order = (p) => (vertical ? centerOf(p.other).x : centerOf(p.other).y);
  ends.sort((p, q) => order(p) - order(q) || p.id.localeCompare(q.id));
  const points = ends.map((end, i) => ({
    end,
    id: end.id,
    want: vertical
      ? start + (length * (i + 1)) / (ends.length + 1)
      : table.y + columnY(table, end.column),
  }));
  for (const t of lockedTs) points.push({ id: 'locked' + t, want: start + length * t, locked: true });
  spreadPoints(points, gap, start + inset, start + length - inset);
  for (const p of points) if (p.end) p.end.t = Math.min(1, Math.max(0, (p.pos - start) / length));
}

// edges: [{ fromKey, fromCol, toKey, toCol }]. keepAnchors: ends the user
// placed by hand ({id: {from?, to?}}); those lines are left as they are, and
// other lines keep clear of their ends. keepBends: bends the user made; those
// lines keep their bend but still get their sides and entry points arranged.
// Returns { anchors, bends } for the arranged lines.
export function arrangeLines(edges, byKey, {
  keepAnchors = {}, keepBends = {}, isHidden = () => false, weights = DEFAULT_WEIGHTS,
} = {}) {
  const visible = [...byKey.values()].filter((t) => Number.isFinite(t.x) && !isHidden(t.key));
  const tablesAt = tableIndex(visible);

  const lockedBySide = new Map();
  const work = [];
  for (const edge of edges) {
    const id = `${edge.fromKey}.${edge.fromCol}>${edge.toKey}.${edge.toCol}`;
    const from = byKey.get(edge.fromKey), to = byKey.get(edge.toKey);
    if (!from || !to || from === to) continue;
    if (!Number.isFinite(from.x) || !Number.isFinite(to.x) || isHidden(from.key) || isHidden(to.key)) continue;
    if (keepAnchors[id]) {
      for (const [table, anchor] of [[from, keepAnchors[id].from], [to, keepAnchors[id].to]]) {
        if (!anchor) continue;
        const k = table.key + '|' + anchor.side;
        if (!lockedBySide.has(k)) lockedBySide.set(k, []);
        lockedBySide.get(k).push(anchor.t);
      }
      continue;
    }
    const candidates = keepBends[id]
      ? candidatesFor(from, to).filter((c) => !c.bend).map((c) => ({ ...c, bend: keepBends[id] }))
      : candidatesFor(from, to);
    work.push({ id, edge, from, to, skip: new Set([from.key, to.key]), candidates, choice: null, line: null });
  }
  // long lines have the fewest good routes, so they choose first
  work.sort((a, b) => {
    const la = Math.hypot(centerOf(a.from).x - centerOf(a.to).x, centerOf(a.from).y - centerOf(a.to).y);
    const lb = Math.hypot(centerOf(b.from).x - centerOf(b.to).x, centerOf(b.from).y - centerOf(b.to).y);
    return lb - la || a.id.localeCompare(b.id);
  });

  // how many line ends each table side already has
  const used = new Map();
  for (const [k, ts] of lockedBySide) used.set(k, ts.length);
  const useSides = (item, delta) => {
    for (const k of [item.from.key + '|' + item.choice.fromSide, item.to.key + '|' + item.choice.toSide]) {
      used.set(k, (used.get(k) || 0) + delta);
    }
  };
  const crowding = (table, side) => {
    const over = (used.get(table.key + '|' + side) || 0) + 1 - sideCapacity(table, side);
    return over > 0 ? over * weights.crowd : 0;
  };

  const placed = new Set();
  const choose = (item) => {
    let best = null;
    for (const choice of item.candidates) {
      const line = makeLine(curveFor(item.from, item.to, choice));
      let cost = line.length
        + tablesUnder(line.pts, tablesAt, item.skip) * weights.table
        + crowding(item.from, choice.fromSide) + crowding(item.to, choice.toSide);
      if (cost > (best?.cost ?? Infinity)) continue;
      for (const other of placed) {
        if (other !== item) cost += countCrossings(line, other.line) * weights.crossing;
        if (cost > (best?.cost ?? Infinity)) break;
      }
      if (!best || cost < best.cost) best = { cost, choice, line };
    }
    item.choice = best.choice;
    item.line = best.line;
  };
  for (const item of work) { choose(item); placed.add(item); useSides(item, 1); }
  for (const item of work) {                                     // second pass, now that all lines exist
    placed.delete(item); useSides(item, -1);
    choose(item);
    placed.add(item); useSides(item, 1);
  }

  // give every end its own point on its side
  const sides = new Map();
  for (const item of work) {
    for (const [table, other, side, column, end] of [
      [item.from, item.to, item.choice.fromSide, item.edge.fromCol, 'from'],
      [item.to, item.from, item.choice.toSide, item.edge.toCol, 'to'],
    ]) {
      const k = table.key + '|' + side;
      if (!sides.has(k)) sides.set(k, { table, side, ends: [] });
      sides.get(k).ends.push({ item, other, column, end, id: item.id + end });
    }
  }
  const anchors = {};
  for (const [k, { table, side, ends }] of sides) {
    spreadSide(table, side, ends, lockedBySide.get(k) || []);
    for (const e of ends) {
      anchors[e.item.id] = { ...anchors[e.item.id], [e.end]: { side, t: e.t, arranged: true } };
    }
  }
  // bends the user made stay theirs; new ones are marked as arranged
  const bends = {};
  for (const item of work) {
    if (item.choice.bend && !keepBends[item.id]) bends[item.id] = { ...item.choice.bend, arranged: true };
  }
  return { anchors, bends, arranged: work.length };
}
