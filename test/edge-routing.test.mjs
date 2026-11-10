// Tests for relation-line routing. Run: node test/edge-routing.test.mjs
import { routeEdges, edgeMidpoint, anchorForPoint } from '../src/edge-routing.js';
import { columnY } from '../src/renderer.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const table = (key, x, y, w = 200, h = 120, columns = ['id', 'a', 'b', 'c']) => ({
  key, x, y, w, h, columns: columns.map((name) => ({ name })),
});
const byKey = (...tables) => new Map(tables.map((t) => [t.key, t]));
const edge = (fromKey, fromCol, toKey, toCol) => ({ fromKey, fromCol, toKey, toCol });

// stacked tables use the facing top and bottom edges
{
  const top = table('top', 0, 0);
  const bottom = table('bottom', 0, 400);
  const [r] = routeEdges([edge('top', 'a', 'bottom', 'id')], byKey(top, bottom));
  ok(r.axis === 'v', 'stacked tables route vertically');
  ok(r.fromSide === 'bottom' && r.toSide === 'top', 'stacked tables use facing edges');
  ok(r.fy === 120 && r.ty === 400, 'line starts and ends on the edges');
  ok(r.c1y > r.fy && r.c2y < r.ty, 'curve leaves away from each table');
}

// side-by-side tables keep the column row
{
  const left = table('left', 0, 0);
  const right = table('right', 500, 0);
  const [r] = routeEdges([edge('left', 'a', 'right', 'id')], byKey(left, right));
  ok(r.axis === 'h', 'side-by-side tables route horizontally');
  ok(r.fx === 200 && r.tx === 500, 'line starts and ends on the facing sides');
  ok(r.fy === left.y + columnY(left, 'a'), 'line stays on its column row');
}

// a diagonal pair follows its larger distance
{
  const a = table('a', 0, 0);
  const far = table('far', 300, 1000);
  ok(routeEdges([edge('a', 'id', 'far', 'id')], byKey(a, far))[0].axis === 'v', 'mostly vertical pair uses top and bottom');
  const wide = table('wide', 1000, 300);
  ok(routeEdges([edge('a', 'id', 'wide', 'id')], byKey(a, wide))[0].axis === 'h', 'mostly horizontal pair uses the sides');
}

// lines sharing a top edge are spread and ordered by where they go
{
  const parent = table('parent', 400, 0, 400);
  const west = table('west', 0, 600);
  const east = table('east', 800, 600);
  const routes = routeEdges(
    [edge('east', 'a', 'parent', 'id'), edge('west', 'a', 'parent', 'id')],
    byKey(parent, west, east),
  );
  const toWest = routes.find((r) => r.fromKey === 'west');
  const toEast = routes.find((r) => r.fromKey === 'east');
  ok(toWest.tx !== toEast.tx, 'shared edge spreads its lines');
  ok(toWest.tx < toEast.tx, 'ports are ordered by destination');
}

// lines into one column are spread around it, inside the table
{
  const parent = table('parent', 500, 0, 200, 80);
  const children = Array.from({ length: 30 }, (_, i) => table(`c${i}`, 0, i * 2 - 30));
  const edges = children.map((c) => edge(c.key, 'a', 'parent', 'id'));
  const routes = routeEdges(edges, byKey(parent, ...children));
  ok(routes.every((r) => r.ty >= parent.y && r.ty <= parent.y + parent.h), 'ports stay on the table');
  ok(new Set(routes.map((r) => r.ty)).size === 30, 'every line has its own port');
}

// hidden and unplaced tables are skipped
{
  const a = table('a', 0, 0);
  const b = table('b', 500, 0);
  const none = table('none', NaN, NaN);
  const map = byKey(a, b, none);
  ok(routeEdges([edge('a', 'id', 'none', 'id')], map).length === 0, 'unplaced tables have no line');
  ok(routeEdges([edge('a', 'id', 'b', 'id')], map, (k) => k === 'b').length === 0, 'hidden tables have no line');
}

// a self reference still gets a curve
{
  const a = table('a', 0, 0);
  const [r] = routeEdges([edge('a', 'b', 'a', 'id')], byKey(a));
  ok(r.axis === 'h' && r.fx !== r.tx, 'self reference leaves and returns on opposite sides');
}

// a bend moves the line's midpoint by exactly its offset and keeps the ends
{
  const top = table('top', 0, 0);
  const bottom = table('bottom', 0, 400);
  const map = byKey(top, bottom);
  const edges = [edge('top', 'a', 'bottom', 'id')];
  const [plain] = routeEdges(edges, map);
  const [bent] = routeEdges(edges, map, () => false, { [plain.id]: { x: 90, y: -30 } });
  const a = edgeMidpoint(plain);
  const b = edgeMidpoint(bent);
  ok(Math.abs(b.x - a.x - 90) < 1e-9 && Math.abs(b.y - a.y + 30) < 1e-9, 'midpoint moves by the bend offset');
  ok(bent.fx === plain.fx && bent.fy === plain.fy && bent.tx === plain.tx && bent.ty === plain.ty, 'ends stay on the tables');
  ok(bent.fromDir === plain.fromDir && bent.toDir === plain.toDir, 'markers keep facing away from the tables');
  ok(bent.bendX === 90 && bent.bendY === -30, 'route reports its bend');

  bottom.y = 700;
  const [moved] = routeEdges(edges, map, () => false, { [plain.id]: { x: 90, y: -30 } });
  const [movedPlain] = routeEdges(edges, map);
  const c = edgeMidpoint(moved);
  const d = edgeMidpoint(movedPlain);
  ok(Math.abs(c.x - d.x - 90) < 1e-9 && Math.abs(c.y - d.y + 30) < 1e-9, 'a bend moves with its tables');
}

// an end can be pinned to any point on any side of its table
{
  const top = table('top', 0, 0);
  const bottom = table('bottom', 0, 400);
  const map = byKey(top, bottom);
  const edges = [edge('top', 'a', 'bottom', 'id')];
  const id = routeEdges(edges, map)[0].id;
  const [r] = routeEdges(edges, map, () => false, {}, { [id]: { to: { side: 'right', t: 0.25 } } });
  ok(r.toSide === 'right', 'pinned end uses the chosen side');
  ok(r.tx === 200 && r.ty === 400 + 120 * 0.25, 'pinned end sits at the chosen point');
  ok(r.toVertical === false && r.toDir === 1, 'pinned end faces away from its side');
  ok(r.c2x > r.tx && r.c2y === r.ty, 'curve leaves straight out from the side');
  ok(r.toPinned === true && r.fromPinned === false, 'route reports which ends are pinned');
  ok(r.fromSide === 'bottom' && r.fy === 120, 'the other end stays automatic');

  bottom.x = 50; bottom.y = 900;
  const [moved] = routeEdges(edges, map, () => false, {}, { [id]: { to: { side: 'right', t: 0.25 } } });
  ok(moved.tx === 250 && moved.ty === 900 + 120 * 0.25, 'pinned end moves with its table');
}

// pinned ends don't take a slot from the automatic ones
{
  const parent = table('parent', 400, 0, 400);
  const west = table('west', 0, 600);
  const east = table('east', 800, 600);
  const map = byKey(parent, west, east);
  const edges = [edge('west', 'a', 'parent', 'id'), edge('east', 'a', 'parent', 'id')];
  const westId = routeEdges(edges, map).find((r) => r.fromKey === 'west').id;
  const routes = routeEdges(edges, map, () => false, {}, { [westId]: { to: { side: 'top', t: 0.5 } } });
  const eastRoute = routes.find((r) => r.fromKey === 'east');
  ok(eastRoute.toSide === 'bottom' && eastRoute.tx === parent.x + parent.w / 2, 'remaining line recentres on the edge');
}

// an automatic end steps aside from a hand-placed end on the same side
{
  const parent = table('parent', 400, 0, 400);
  const a = table('a', 400, 600);
  const b = table('b', 600, 600);
  const map = byKey(parent, a, b);
  const edges = [edge('a', 'a', 'parent', 'id'), edge('b', 'a', 'parent', 'id')];
  const free = routeEdges(edges, map);
  const bId = free.find((r) => r.fromKey === 'b').id;
  const aRoute = free.find((r) => r.fromKey === 'a');
  const t = (aRoute.tx - parent.x) / parent.w;
  const routes = routeEdges(edges, map, () => false, {}, { [bId]: { to: { side: 'bottom', t } } });
  const pinned = routes.find((r) => r.fromKey === 'b');
  const auto = routes.find((r) => r.fromKey === 'a');
  ok(pinned.toSide === 'bottom' && auto.toSide === 'bottom', 'both ends are on the same side');
  ok(Math.abs(pinned.tx - auto.tx) >= 12, 'automatic end keeps clear of the placed end');
}

// a broken saved anchor falls back to automatic
{
  const a = table('a', 0, 0);
  const b = table('b', 500, 0);
  const map = byKey(a, b);
  const edges = [edge('a', 'a', 'b', 'id')];
  const id = routeEdges(edges, map)[0].id;
  const [r] = routeEdges(edges, map, () => false, {}, { [id]: { from: { side: 'nope', t: 0.5 }, to: { side: 'top', t: 9 } } });
  ok(r.fromSide === 'right' && r.fromPinned === false, 'invalid side is ignored');
  ok(r.tx === 700 && r.ty === 0, 'out-of-range position is kept on the table');
}

// a dragged point snaps to the nearest edge
{
  const t = table('t', 100, 100, 200, 100);
  const near = (a, side, along) => a.side === side && Math.abs(a.t - along) < 1e-9;
  ok(near(anchorForPoint(t, 150, 40), 'top', 0.25), 'above snaps to the top');
  ok(near(anchorForPoint(t, 250, 260), 'bottom', 0.75), 'below snaps to the bottom');
  ok(near(anchorForPoint(t, 20, 125), 'left', 0.25), 'left of the table snaps to the left');
  ok(near(anchorForPoint(t, 380, 175), 'right', 0.75), 'right of the table snaps to the right');
  ok(near(anchorForPoint(t, 290, 150), 'right', 0.5), 'inside snaps to the nearest side');
}

console.log(`edge routing: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
