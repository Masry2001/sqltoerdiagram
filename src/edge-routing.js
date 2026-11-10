// Chooses where each relation line meets its tables. Stacked tables connect
// through their top and bottom edges; side-by-side tables connect at the column
// row. Lines sharing an edge are spread out and ordered by where they are going,
// so they don't cross each other as they leave the table. A user can also pin
// either end of a line to a chosen point on its table's edge.
import { columnY } from './renderer.js';

const MIN_BEND = 28;
const BEND_RATIO = 0.4;
const PORT_GAP = 14;
const PORT_INSET = 6;
const OUTWARD = {
  right: [1, 0],
  left: [-1, 0],
  top: [0, -1],
  bottom: [0, 1],
};

const centerX = (t) => t.x + t.w / 2;
const centerY = (t) => t.y + t.h / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const isVerticalSide = (side) => side === 'top' || side === 'bottom';

function axisBetween(a, b) {
  if (a === b) return 'h';
  if (overlaps(a.y, a.y + a.h, b.y, b.y + b.h)) return 'h';
  if (overlaps(a.x, a.x + a.w, b.x, b.x + b.w)) return 'v';
  return Math.abs(centerY(a) - centerY(b)) > Math.abs(centerX(a) - centerX(b)) ? 'v' : 'h';
}

function sidesFor(axis, from, to) {
  if (axis === 'v') {
    const down = centerY(from) < centerY(to);
    return { fromSide: down ? 'bottom' : 'top', toSide: down ? 'top' : 'bottom' };
  }
  const right = centerX(from) < centerX(to);
  return { fromSide: right ? 'right' : 'left', toSide: right ? 'left' : 'right' };
}

function anchorPoint(table, anchor) {
  const along = clamp(anchor.t, 0, 1);
  if (isVerticalSide(anchor.side)) {
    return { x: table.x + table.w * along, y: anchor.side === 'top' ? table.y : table.y + table.h };
  }
  return { x: anchor.side === 'right' ? table.x + table.w : table.x, y: table.y + table.h * along };
}

const validAnchor = (anchor) => !!anchor && !!OUTWARD[anchor.side] && Number.isFinite(anchor.t);

// The point on a table's edge closest to (x, y), as { side, t } with t from 0 to 1
// along that side.
export function anchorForPoint(table, x, y) {
  const px = clamp(x, table.x, table.x + table.w);
  const py = clamp(y, table.y, table.y + table.h);
  const distances = [
    ['left', Math.hypot(x - table.x, y - py)],
    ['right', Math.hypot(x - (table.x + table.w), y - py)],
    ['top', Math.hypot(x - px, y - table.y)],
    ['bottom', Math.hypot(x - px, y - (table.y + table.h))],
  ];
  const [side] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
  return {
    side,
    t: isVerticalSide(side) ? (px - table.x) / table.w : (py - table.y) / table.h,
  };
}

function assignPorts(ends) {
  const groups = new Map();
  for (const end of ends) {
    const vertical = isVerticalSide(end.side);
    const key = `${end.table.key}|${end.side}|${vertical ? '' : String(end.column).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(end);
  }

  for (const group of groups.values()) {
    const { table, side } = group[0];
    const vertical = isVerticalSide(side);
    const position = vertical ? centerX : centerY;
    group.sort((a, b) => position(a.other) - position(b.other) || a.other.key.localeCompare(b.other.key));

    group.forEach((end, index) => {
      if (vertical) {
        end.x = table.x + (table.w * (index + 1)) / (group.length + 1);
        end.y = side === 'top' ? table.y : table.y + table.h;
        return;
      }
      const base = table.y + columnY(table, end.column);
      const room = table.h - PORT_INSET * 2;
      const gap = group.length > 1 ? Math.min(PORT_GAP, room / (group.length - 1)) : 0;
      const span = gap * (group.length - 1);
      const start = group.length > 1
        ? clamp(base - span / 2, table.y + PORT_INSET, table.y + table.h - PORT_INSET - span)
        : base;
      end.x = side === 'right' ? table.x + table.w : table.x;
      end.y = start + index * gap;
    });
  }
}

// An automatic end never sits on a hand-placed one: it steps along its side to
// the nearest free spot.
const END_CLEARANCE = 12;
function avoidPinnedEnds(autoEnds, pinnedEnds) {
  if (!pinnedEnds.length) return;
  const taken = new Map();
  const along = (end) => (isVerticalSide(end.side) ? end.x : end.y);
  for (const end of pinnedEnds) {
    const k = end.table.key + '|' + end.side;
    if (!taken.has(k)) taken.set(k, []);
    taken.get(k).push(along(end));
  }
  for (const end of autoEnds) {
    const spots = taken.get(end.table.key + '|' + end.side);
    if (!spots) continue;
    const vertical = isVerticalSide(end.side);
    const lo = (vertical ? end.table.x : end.table.y) + PORT_INSET;
    const hi = (vertical ? end.table.x + end.table.w : end.table.y + end.table.h) - PORT_INSET;
    const at = along(end);
    const free = (p) => p >= lo && p <= hi && spots.every((s) => Math.abs(s - p) >= END_CLEARANCE);
    if (free(at)) { spots.push(at); continue; }
    let next = at;
    for (let step = 1; step < 200; step++) {
      const up = at + step * (END_CLEARANCE / 2), down = at - step * (END_CLEARANCE / 2);
      if (free(down)) { next = down; break; }
      if (free(up)) { next = up; break; }
    }
    if (vertical) end.x = next; else end.y = next;
    spots.push(next);
  }
}

// The curve between two end points ({x, y, side}), with an optional bend.
export function curveBetween(fromEnd, toEnd, bend = null) {
  const c1 = controlPoint(fromEnd, toEnd);
  const c2 = controlPoint(toEnd, fromEnd);
  return applyBend({
    fx: fromEnd.x, fy: fromEnd.y, tx: toEnd.x, ty: toEnd.y,
    c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y,
  }, bend);
}

export { anchorPoint, isVerticalSide, OUTWARD };

// Each curve leaves its table straight out from the side it is attached to.
function controlPoint(end, otherEnd) {
  const [dx, dy] = OUTWARD[end.side];
  const distance = dx ? Math.abs(otherEnd.x - end.x) : Math.abs(otherEnd.y - end.y);
  const reach = Math.max(MIN_BEND, distance * BEND_RATIO);
  return { x: end.x + dx * reach, y: end.y + dy * reach };
}

// Moving both control points by 4/3 of an offset moves the curve's midpoint by
// exactly that offset, so a bend's handle sits on the line.
function applyBend(curve, bend) {
  if (!bend) return { ...curve, bendX: 0, bendY: 0 };
  const shiftX = (bend.x * 4) / 3;
  const shiftY = (bend.y * 4) / 3;
  return {
    ...curve,
    c1x: curve.c1x + shiftX,
    c1y: curve.c1y + shiftY,
    c2x: curve.c2x + shiftX,
    c2y: curve.c2y + shiftY,
    bendX: bend.x,
    bendY: bend.y,
  };
}

// The point halfway along a routed line, where its bend handle sits.
export function edgeMidpoint(seg) {
  return {
    x: (seg.fx + 3 * seg.c1x + 3 * seg.c2x + seg.tx) / 8,
    y: (seg.fy + 3 * seg.c1y + 3 * seg.c2y + seg.ty) / 8,
  };
}

// edges: [{ fromKey, fromCol, toKey, toCol, ... }]. Returns the visible ones with
// their curve added: fx, fy, c1x, c1y, c2x, c2y, tx, ty, plus id, each end's
// side and the direction it leaves its table. bends maps a line's id to its
// {x, y} offset; anchors maps it to { from?, to? } points of the form { side, t }.
export function routeEdges(edges, byKey, isHidden = () => false, bends = {}, anchors = {}) {
  const routes = [];
  const autoEnds = [];

  for (const edge of edges) {
    const from = byKey.get(edge.fromKey);
    const to = byKey.get(edge.toKey);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) continue;
    if (isHidden(from.key) || isHidden(to.key)) continue;

    const axis = axisBetween(from, to);
    const sides = sidesFor(axis, from, to);
    const id = `${edge.fromKey}.${edge.fromCol}>${edge.toKey}.${edge.toCol}`;
    const makeEnd = (table, other, side, column, anchor) => {
      if (validAnchor(anchor)) return { table, other, side: anchor.side, ...anchorPoint(table, anchor), pinned: true };
      const end = { table, other, side, column, pinned: false };
      autoEnds.push(end);
      return end;
    };
    routes.push({
      route: { ...edge, axis, id },
      fromEnd: makeEnd(from, to, sides.fromSide, edge.fromCol, anchors[id]?.from),
      toEnd: makeEnd(to, from, sides.toSide, edge.toCol, anchors[id]?.to),
    });
  }

  assignPorts(autoEnds);
  avoidPinnedEnds(autoEnds, routes.flatMap(({ fromEnd, toEnd }) => [fromEnd, toEnd]).filter((e) => e.pinned));

  return routes.map(({ route, fromEnd, toEnd }) => {
    const c1 = controlPoint(fromEnd, toEnd);
    const c2 = controlPoint(toEnd, fromEnd);
    const [fromX, fromY] = OUTWARD[fromEnd.side];
    const [toX, toY] = OUTWARD[toEnd.side];
    return applyBend({
      ...route,
      fx: fromEnd.x,
      fy: fromEnd.y,
      tx: toEnd.x,
      ty: toEnd.y,
      c1x: c1.x,
      c1y: c1.y,
      c2x: c2.x,
      c2y: c2.y,
      fromSide: fromEnd.side,
      toSide: toEnd.side,
      fromDir: fromX + fromY,
      toDir: toX + toY,
      fromVertical: isVerticalSide(fromEnd.side),
      toVertical: isVerticalSide(toEnd.side),
      fromPinned: fromEnd.pinned,
      toPinned: toEnd.pinned,
    }, bends[route.id]);
  });
}
