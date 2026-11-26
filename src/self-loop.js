// A table's line to itself (a foreign key to its own table) is drawn as a small
// loop at one of the table's top corners: it leaves the side a little below the
// top, goes a short way out and up, and comes back down onto the top edge near
// the corner. The corner is the one on the side with fewer other lines, so the
// loop stays out of their way. Every line style uses it.
//
// Pure functions: no DOM.
export const SELF_LOOP_MIN = 20;       // the loop reaches at least this far out (px)
export const SELF_LOOP_SHARE = 0.1;    // ...or this share of the table's size
const RING_STEP = 12;                  // a second loop at the same corner goes round the first, this much further out

// How far the loop reaches out from the table.
export function selfLoopReach(table) {
  return Math.max(SELF_LOOP_MIN, Math.round(SELF_LOOP_SHARE * Math.min(table.w, table.h)));
}

// Which top corner the loop takes: 'left' or 'right'.
// ends: the table's other line ends, [{ side, other }]: side is where the line
// enters the table (left, right, top, bottom, or null when not known yet) and
// other is the table at its far end. More lines on the right side put the loop
// at the top-left corner, otherwise it takes the top-right one. On a tie it
// still takes the top-right, unless more of the other tables lie to the right
// (the left is clearly freer).
export function selfLoopCorner(table, ends = []) {
  let left = 0, right = 0, leftward = 0, rightward = 0;
  const cx = table.x + table.w / 2;
  for (const { side, other } of ends) {
    if (side === 'left') left++;
    else if (side === 'right') right++;
    if (!other || other === table || !Number.isFinite(other.x)) continue;
    const ox = other.x + other.w / 2;
    if (ox < cx) leftward++;
    else if (ox > cx) rightward++;
  }
  if (left !== right) return right > left ? 'left' : 'right';
  return rightward > leftward ? 'left' : 'right';
}

// The loop as a right-angle path: { points, fromSide, toSide }. It leaves the
// side about a tenth of the table's height below the top and comes back on the
// top edge about a tenth of the table's width in from the corner. ring: 0 for
// the first loop at this corner, 1 for one going round it, and so on.
export function selfLoopPath(table, corner = 'right', ring = 0) {
  const reach = selfLoopReach(table) + ring * RING_STEP;
  const down = Math.min(table.h - 4, Math.max(8, Math.round(table.h * SELF_LOOP_SHARE)) + ring * RING_STEP);
  const inset = Math.min(table.w - 4, Math.max(8, Math.round(table.w * SELF_LOOP_SHARE)) + ring * RING_STEP);
  const onLeft = corner === 'left';
  const sideX = onLeft ? table.x : table.x + table.w;
  const outX = onLeft ? sideX - reach : sideX + reach;
  const topX = onLeft ? table.x + inset : table.x + table.w - inset;
  const sideY = table.y + down;
  const outY = table.y - reach;
  return {
    points: [[sideX, sideY], [outX, sideY], [outX, outY], [topX, outY], [topX, table.y]],
    fromSide: onLeft ? 'left' : 'right',
    toSide: 'top',
  };
}

// Every loop of one table (a table can refer to itself more than once), as
// {id: path}. The first takes the freer corner (selfLoopCorner), the second the
// other top corner, and further ones go round those, a little further out.
// corner: the first loop's corner, when already chosen.
export function selfLoopPaths(table, ids, ends = [], corner = null) {
  const first = corner === 'left' || corner === 'right' ? corner : selfLoopCorner(table, ends);
  const second = first === 'left' ? 'right' : 'left';
  const out = {};
  [...ids].sort().forEach((id, i) => { out[id] = selfLoopPath(table, i % 2 ? second : first, i >> 1); });
  return out;
}

// The rectangle the loop takes, grown by `margin` on every side: { x0, y0, x1, y1 }.
export function selfLoopArea(path, margin = 0) {
  const xs = path.points.map((p) => p[0]), ys = path.points.map((p) => p[1]);
  return { x0: Math.min(...xs) - margin, y0: Math.min(...ys) - margin, x1: Math.max(...xs) + margin, y1: Math.max(...ys) + margin };
}
