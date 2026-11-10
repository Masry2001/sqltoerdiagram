// Tests for Arrange lines. Run: node test/line-arranger.test.mjs
import { arrangeLines } from '../src/line-arranger.js';
import { routeEdges } from '../src/edge-routing.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const table = (key, x, y, w = 200, h = 140) => ({
  key, x, y, w, h, columns: ['id', 'a', 'b', 'c', 'd'].map((name) => ({ name })),
});
const byKey = (...tables) => new Map(tables.map((t) => [t.key, t]));
const edge = (fromKey, fromCol, toKey, toCol) => ({ fromKey, fromCol, toKey, toCol });
const idOf = (e) => `${e.fromKey}.${e.fromCol}>${e.toKey}.${e.toCol}`;

function underTables(route, tables) {
  for (let i = 0; i <= 40; i++) {
    const u = i / 40, v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
    const x = a * route.fx + b * route.c1x + c * route.c2x + d * route.tx;
    const y = a * route.fy + b * route.c1y + c * route.c2y + d * route.ty;
    if (tables.some((t) => t.key !== route.fromKey && t.key !== route.toKey
      && x > t.x + 2 && x < t.x + t.w - 2 && y > t.y + 2 && y < t.y + t.h - 2)) return true;
  }
  return false;
}

// a line between two tables with a third in the way goes around it
{
  const left = table('left', 0, 300);
  const middle = table('middle', 400, 280, 200, 180);
  const right = table('right', 800, 300);
  const map = byKey(left, middle, right);
  const edges = [edge('left', 'a', 'right', 'id')];
  const plain = routeEdges(edges, map)[0];
  ok(underTables(plain, [left, middle, right]), 'the automatic line passes under the middle table');
  const { anchors, bends } = arrangeLines(edges, map);
  const arranged = routeEdges(edges, map, () => false, bends, anchors)[0];
  ok(!underTables(arranged, [left, middle, right]), 'the arranged line goes around it');
  ok(anchors[idOf(edges[0])].from.arranged === true, 'arranged ends are marked as arranged');
}

// many lines into one table never share an entry point
{
  const hub = table('hub', 500, 500, 240, 300);
  const others = Array.from({ length: 24 }, (_, i) => table(`t${i}`, 100 + (i % 6) * 260, i < 12 ? 0 : 1100));
  const map = byKey(hub, ...others);
  const edges = others.map((t) => edge(t.key, 'a', 'hub', 'id'));
  const { anchors, bends } = arrangeLines(edges, map);
  const routes = routeEdges(edges, map, () => false, bends, anchors);
  const hubEnds = routes.map((r) => [r.tx, r.ty]);
  let closest = Infinity;
  for (let i = 0; i < hubEnds.length; i++) for (let j = i + 1; j < hubEnds.length; j++) {
    closest = Math.min(closest, Math.hypot(hubEnds[i][0] - hubEnds[j][0], hubEnds[i][1] - hubEnds[j][1]));
  }
  ok(closest >= 12, `entry points on the hub stay apart (closest ${closest.toFixed(1)})`);
  ok(routes.every((r) => r.tx >= hub.x && r.tx <= hub.x + hub.w && r.ty >= hub.y && r.ty <= hub.y + hub.h), 'entry points stay on the table');
}

// hand-placed ends and bends are kept
{
  const a = table('a', 0, 0);
  const b = table('b', 600, 0);
  const c = table('c', 600, 500);
  const map = byKey(a, b, c);
  const edges = [edge('a', 'a', 'b', 'id'), edge('a', 'b', 'c', 'id')];
  const handEnd = { to: { side: 'top', t: 0.3 } };
  const handBend = { x: 40, y: 80 };
  const { anchors, bends } = arrangeLines(edges, map, {
    keepAnchors: { [idOf(edges[0])]: handEnd },
    keepBends: { [idOf(edges[1])]: handBend },
  });
  ok(!anchors[idOf(edges[0])], 'a line with a hand-placed end is left alone');
  ok(!bends[idOf(edges[1])], 'a hand-made bend is not replaced');
  ok(!!anchors[idOf(edges[1])], 'a bent line still gets arranged ends');
}

// hidden tables and self references are skipped
{
  const a = table('a', 0, 0);
  const b = table('b', 600, 0);
  const map = byKey(a, b);
  const edges = [edge('a', 'a', 'b', 'id'), edge('a', 'b', 'a', 'id')];
  ok(arrangeLines(edges, map, { isHidden: (k) => k === 'b' }).arranged === 0, 'lines to hidden tables are skipped');
  ok(arrangeLines(edges, map).arranged === 1, 'a table referencing itself is left to the automatic route');
}

console.log(`line arranger: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
