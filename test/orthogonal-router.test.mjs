// Tests for "Arrange lines straight". Run: node test/orthogonal-router.test.mjs
import { routeStraight, pathJumps, pathFits, pathMidpoint, pathDistance } from '../src/orthogonal-router.js';

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

console.log(`orthogonal router: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
