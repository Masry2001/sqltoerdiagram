// Tests for "Arrange lines straight". Run: node test/orthogonal-router.test.mjs
import { routeStraight, pathJumps, pathFits, pathMidpoint, pathDistance, elbowPath, pathUnderTables, pathStillFits, separateOverlaps } from '../src/orthogonal-router.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const table = (key, x, y, w = 200, h = 160) => ({ key, x, y, w, h });
const byKey = (...tables) => new Map(tables.map((t) => [t.key, t]));
const edge = (fromKey, toKey, n = 0) => ({ id: `${fromKey}.c${n}>${toKey}.id`, fromKey, toKey });

function segments(paths) {
  const out = [];
  for (const [id, p] of Object.entries(paths)) {
    for (let i = 1; i < p.points.length; i++) out.push({ id, a: p.points[i - 1], b: p.points[i] });
  }
  return out;
}
const orthogonal = (paths) => segments(paths).every(({ a, b }) => a[0] === b[0] || a[1] === b[1]);
function overlapping(paths) {
  const segs = segments(paths);
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.id === t.id) continue;
    if (s.a[1] === s.b[1] && t.a[1] === t.b[1] && s.a[1] === t.a[1]
      && Math.min(Math.max(s.a[0], s.b[0]), Math.max(t.a[0], t.b[0])) - Math.max(Math.min(s.a[0], s.b[0]), Math.min(t.a[0], t.b[0])) > 1) return true;
    if (s.a[0] === s.b[0] && t.a[0] === t.b[0] && s.a[0] === t.a[0]
      && Math.min(Math.max(s.a[1], s.b[1]), Math.max(t.a[1], t.b[1])) - Math.max(Math.min(s.a[1], s.b[1]), Math.min(t.a[1], t.b[1])) > 1) return true;
  }
  return false;
}
function throughTable(paths, map) {
  for (const [id, p] of Object.entries(paths)) {
    const own = [id.split('.')[0], id.split('>')[1].split('.')[0]];
    for (const t of map.values()) {
      if (own.includes(t.key)) continue;
      for (let i = 1; i < p.points.length; i++) {
        const [x1, y1] = p.points[i - 1], [x2, y2] = p.points[i];
        if (Math.max(x1, x2) > t.x && Math.min(x1, x2) < t.x + t.w && Math.max(y1, y2) > t.y && Math.min(y1, y2) < t.y + t.h) return true;
      }
    }
  }
  return false;
}

// a table in the way is avoided, with right angles only
{
  const map = byKey(table('a', 0, 300), table('wall', 400, 200, 200, 400), table('b', 800, 300));
  const { paths, failed } = routeStraight([edge('a', 'b')], map);
  const p = Object.values(paths)[0];
  ok(failed.length === 0 && !!p, 'the line is routed');
  ok(orthogonal(paths), 'the line is made of horizontal and vertical segments');
  ok(!throughTable(paths, map), 'the line goes around the table in the way');
  ok(pathFits(p, map.get('a'), map.get('b')), 'the line starts and ends on its tables');
}

// many lines to one table: own entry points, no shared segments
{
  const hub = table('hub', 600, 600, 260, 300);
  const others = Array.from({ length: 16 }, (_, i) => table(`t${i}`, (i % 8) * 300, i < 8 ? 0 : 1300));
  const map = byKey(hub, ...others);
  const edges = others.map((t) => edge(t.key, 'hub'));
  const { paths, failed, overlapping: shared } = routeStraight(edges, map);
  ok(failed.length === 0 && Object.keys(paths).length === 16, 'every line is routed');
  const ends = Object.values(paths).map((p) => p.points[p.points.length - 1].join(','));
  ok(new Set(ends).size === ends.length, 'every line has its own entry point');
  ok(shared.length === 0 && !overlapping(paths), 'no two lines share a segment');
  ok(orthogonal(paths) && !throughTable(paths, map), 'all lines are straight and avoid other tables');
}

// crossings become jumps on the horizontal line
{
  const paths = [
    { id: 'h', points: [[0, 100], [300, 100]] },
    { id: 'v', points: [[150, 0], [150, 300]] },
    { id: 'far', points: [[500, 0], [500, 300]] },
  ];
  const jumps = pathJumps(paths);
  ok(jumps.h?.length === 1 && jumps.h[0][1] === 150, 'the horizontal line jumps at the crossing');
  ok(!jumps.v, 'the vertical line does not jump');
  ok(Object.keys(jumps).length === 1, 'lines that do not cross have no jumps');
  const touching = pathJumps([{ id: 'h', points: [[0, 100], [300, 100]] }, { id: 'v', points: [[150, 100], [150, 300]] }]);
  ok(!touching.h, 'a line that only touches is not a crossing');
}

// helpers
{
  const pts = [[0, 0], [100, 0], [100, 100]];
  const mid = pathMidpoint(pts);
  ok(mid.x === 100 && mid.y === 0, 'the midpoint is halfway along the path');
  ok(pathDistance(pts, 50, 10) === 10, 'distance to a path is measured to its nearest segment');
  const t = table('t', 0, 0);
  const moved = { ...t, x: 50 };
  const path = { points: [[200, 80], [400, 80]], fromSide: 'right', toSide: 'left' };
  const other = table('o', 400, 0);
  ok(pathFits(path, t, other), 'a path fits its tables');
  ok(!pathFits(path, moved, other), 'a path stops fitting when its table moves');
}

// re-routing a few lines keeps the rest: new lines avoid their lanes and ends
{
  const a = table('a', 0, 0), b = table('b', 600, 0), c = table('c', 0, 400), d = table('d', 600, 400);
  const map = byKey(a, b, c, d);
  const all = [edge('a', 'b', 0), edge('a', 'b', 1), edge('c', 'd', 0), edge('a', 'd', 0), edge('c', 'b', 0)];
  const first = routeStraight(all, map).paths;
  ok(Object.keys(first).length === all.length, 'every line routes before the move');
  // move d down; its lines are re-routed while the others stay
  const moved = byKey(a, b, c, { ...d, y: 560 });
  const todo = all.filter((e) => e.toKey === 'd');
  const keep = Object.fromEntries(all.filter((e) => e.toKey !== 'd').map((e) => [e.id, first[e.id]]));
  const again = routeStraight(todo, moved, { keep });
  ok(todo.every((e) => again.paths[e.id]), 'the moved table\'s lines are re-routed');
  ok(todo.every((e) => pathFits(again.paths[e.id], moved.get(e.fromKey), moved.get(e.toKey))), 'the re-routed lines meet the moved table');
  const merged = { ...keep, ...again.paths };
  ok(orthogonal(merged), 're-routed lines are straight');
  ok(!overlapping(merged), 're-routed lines don\'t lie on the kept lines');
  ok(!throughTable(merged, moved), 're-routed lines don\'t pass under tables');
  const ends = Object.values(merged).flatMap((p) => [p.points[0], p.points.at(-1)]).map((p) => p.join(','));
  ok(new Set(ends).size === ends.length, 're-routed lines don\'t share an entry point with kept lines');
}

// the right angle drawn while dragging, and the under-a-table check
{
  const e = elbowPath({ fx: 200, fy: 50, tx: 400, ty: 300, fromSide: 'right', toSide: 'left' });
  ok(orthogonal({ e }), 'the drag-time line is made of straight segments');
  ok(e.points[0].join() === '200,50' && e.points.at(-1).join() === '400,300', 'the drag-time line meets both ends');
  const t = elbowPath({ fx: 100, fy: 160, tx: 500, ty: 0, fromSide: 'bottom', toSide: 'right' });
  ok(orthogonal({ t }), 'a line leaving downward and arriving sideways is straight too');
  const blocker = table('x', 250, 100, 100, 100);
  ok(pathUnderTables([[0, 150], [500, 150]], [blocker]), 'a line through a table is detected');
  ok(!pathUnderTables([[0, 50], [500, 50]], [blocker]), 'a line beside a table is fine');
  ok(!pathUnderTables([[350, 150], [500, 150]], [blocker]), 'a line leaving a table\'s edge doesn\'t cross it');
  // a table nudged sideways: the line's end still touches the top edge, but
  // the line now runs through the table
  const from = table('f', 0, 0, 200, 100), to = table('g', 400, 300, 200, 100);
  const path = { points: [[150, 0], [150, -32], [-32, -32], [-32, 350], [400, 350]], fromSide: 'top', toSide: 'left' };
  ok(pathStillFits(path, from, to), 'an untouched path still fits');
  const nudged = { ...from, x: -40 };
  ok(pathFits(path, nudged, to) && !pathStillFits(path, nudged, to), 'a path that now crosses its own moved table no longer fits');
}

// lines that would lie on top of each other are drawn side by side
{
  const shared = [
    { id: 'a', points: [[0, 0], [100, 0], [100, 50]] },
    { id: 'b', points: [[0, 0], [100, 0], [100, 80]] },
    { id: 'c', points: [[0, 0], [60, 0], [60, -40]] },
  ];
  const apart = separateOverlaps(shared);
  const drawn = shared.map((p) => ({ id: p.id, points: apart[p.id] || p.points }));
  const starts = drawn.map((p) => p.points[0].join());
  ok(new Set(starts).size === 3, 'three lines leaving one point get three entry points');
  ok(!overlapping(Object.fromEntries(drawn.map((p) => [p.id, p]))), 'no two lines lie on top of each other');
  ok(orthogonal(Object.fromEntries(drawn.map((p) => [p.id, p]))), 'moved lines keep right angles');
  ok(!apart.a, 'the first line stays where it was');
  const clean = [{ id: 'x', points: [[0, 0], [50, 0]] }, { id: 'y', points: [[0, 20], [50, 20]] }];
  ok(Object.keys(separateOverlaps(clean)).length === 0, 'lines that do not overlap are left alone');
  // a point in the middle of a straight run must not tilt the line when moved
  const runs = [{ id: 'r', points: [[0, 0], [16, 0], [50, 0], [50, 40]] }, { id: 's', points: [[0, 0], [30, 0], [30, 40]] }];
  const ra = separateOverlaps(runs);
  ok(orthogonal(Object.fromEntries(runs.map((p) => [p.id, { points: ra[p.id] || p.points }]))), 'lines with extra points on a straight run stay right-angled');
}

console.log(`orthogonal router: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
