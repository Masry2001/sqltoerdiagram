// Tests for a table's line to itself (a small loop at a top corner).
// Run: node test/self-loop.test.mjs
import { selfLoopCorner, selfLoopPath, selfLoopPaths, selfLoopReach, SELF_LOOP_MIN } from '../src/self-loop.js';
import { routeStraight, routeStraightTidy, routeMoved, pathFits, pathStillFits } from '../src/orthogonal-router.js';
import { routeEdges } from '../src/edge-routing.js';
import { packGroup } from '../src/group-layout.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const table = (key, x, y, w = 220, h = 300) => ({ key, x, y, w, h, columns: ['id', 'manager_id', 'dept_id', 'store_id', 'ref_id'].map((name) => ({ name })) });
const byKey = (...tables) => new Map(tables.map((t) => [t.key, t]));
const SELF = 'employees.manager_id>employees.id';
const edge = (fromKey, toKey, col = 'ref_id') => ({ id: `${fromKey}.${col}>${toKey}.id`, fromKey, toKey, fromCol: col, toCol: 'id' });
const loopEdge = { id: SELF, fromKey: 'employees', toKey: 'employees', fromCol: 'manager_id', toCol: 'id' };
const inside = (x, y, a) => x > a.x0 && x < a.x1 && y > a.y0 && y < a.y1;

// which corner
{
  const t = table('employees', 0, 0);
  const left = { x: -500, y: 0, w: 200, h: 100 }, right = { x: 500, y: 0, w: 200, h: 100 };
  ok(selfLoopCorner(t, []) === 'right', 'no other lines: top-right');
  ok(selfLoopCorner(t, [{ side: 'right', other: right }, { side: 'right', other: right }, { side: 'left', other: left }]) === 'left', 'more lines on the right: top-left');
  ok(selfLoopCorner(t, [{ side: 'left', other: left }, { side: 'left', other: left }, { side: 'right', other: right }]) === 'right', 'more lines on the left: top-right');
  ok(selfLoopCorner(t, [{ side: 'left', other: left }, { side: 'right', other: right }]) === 'right', 'a tie: top-right');
  ok(selfLoopCorner(t, [{ side: 'top', other: right }, { side: 'bottom', other: right }]) === 'left', 'a tie, with the left clearly freer: top-left');
  ok(selfLoopCorner(t, [{ side: 'top', other: left }, { side: 'bottom', other: right }]) === 'right', 'a tie, neither side freer: top-right');
}

// the loop's shape
{
  const t = table('employees', 100, 200, 220, 300);
  const p = selfLoopPath(t, 'right');
  const reach = selfLoopReach(t);
  ok(reach === 22, 'reaches a tenth of the table size');
  ok(selfLoopReach(table('tiny', 0, 0, 80, 60)) === SELF_LOOP_MIN, 'a small table still gets a visible loop');
  ok(p.fromSide === 'right' && p.toSide === 'top', 'top-right: leaves the right side, returns on the top');
  ok(p.points[0][0] === 320 && p.points[0][1] === 230, 'leaves the side a tenth of the height below the top');
  ok(p.points.at(-1)[0] === 298 && p.points.at(-1)[1] === 200, 'returns on the top a tenth of the width in from the corner');
  ok(Math.max(...p.points.map((q) => q[0])) === 320 + reach && Math.min(...p.points.map((q) => q[1])) === 200 - reach, 'goes only a short way out');
  ok(p.points.every((q, i) => !i || q[0] === p.points[i - 1][0] || q[1] === p.points[i - 1][1]), 'right angles only');
  ok(pathStillFits(p, t, t), 'starts and ends on the table, never over it');
  const l = selfLoopPath(t, 'left');
  ok(l.fromSide === 'left' && l.points[0][0] === 100 && l.points.at(-1)[0] === 122, 'top-left: leaves the left side, returns near the left corner');
  const two = Object.values(selfLoopPaths(t, ['b', 'a'], []));
  ok(two[0].fromSide !== two[1].fromSide, 'a second loop on the same table takes the other corner');
}

// straight lines: lines on the right put the loop top-left, and keep out of it
{
  const emp = table('employees', 0, 0);
  const map = byKey(emp, table('departments', 500, -200, 200, 160), table('stores', 500, 300, 200, 160), table('projects', 500, 50, 200, 160));
  const edges = [loopEdge, edge('employees', 'departments', 'dept_id'), edge('employees', 'stores', 'store_id'), edge('projects', 'employees')];
  const runs = [['routeStraight', routeStraight(edges, map)], ['routeStraightTidy', routeStraightTidy(edges, map)], ['routeMoved', routeMoved(edges, map)]];
  for (const [name, result] of runs) {
    const p = result.paths[SELF];
    ok(!!p && p.fromSide === 'left' && p.toSide === 'top', `${name}: the loop sits at the top-left corner`);
    ok(!!p && pathFits(p, emp, emp) && p.points.length === 5, `${name}: a small five-point loop on the table`);
    const reach = selfLoopReach(emp);
    ok(!!p && Math.min(...p.points.map((q) => q[0])) >= -reach && Math.min(...p.points.map((q) => q[1])) >= -reach, `${name}: the loop stays close to the corner`);
    const area = { x0: -reach, y0: -reach, x1: 0.1 * emp.w, y1: 0.1 * emp.h };
    const intruder = Object.entries(result.paths).some(([id, q]) => id !== SELF && q.points.some(([x, y]) => inside(x, y, area)));
    ok(!intruder, `${name}: other lines keep out of the loop's corner`);
  }
}

// a loop that stays (other lines re-routed around it) keeps its corner clear
{
  const emp = table('employees', 0, 0);
  const map = byKey(emp, table('departments', 300, -260, 200, 160), table('stores', 340, -40, 200, 100), table('projects', 260, -400, 200, 100));
  const loop = selfLoopPath(emp, 'right');
  const edges = [edge('employees', 'departments', 'dept_id'), edge('employees', 'stores', 'store_id'), edge('projects', 'employees')];
  const { paths } = routeMoved(edges, map, { keep: { [SELF]: loop } });
  const reach = selfLoopReach(emp);
  const area = { x0: emp.w - 0.1 * emp.w, y0: -reach, x1: emp.w + reach, y1: 0.1 * emp.h };
  ok(!Object.values(paths).some((q) => q.points.some(([x, y]) => inside(x, y, area))), 'lines routed again keep out of a kept loop');
}

// a line that would pass the loop's corner goes round it
{
  const emp = table('employees', 0, 0);
  const map = byKey(emp, table('left', -500, -300, 200, 160), table('right', 600, -300, 200, 160),
    table('a', 600, 100, 200, 100), table('b', 600, 250, 200, 100));
  const edges = [loopEdge, edge('employees', 'a'), edge('employees', 'b'), edge('left', 'right')];
  const { paths, failed } = routeStraightTidy(edges, map);
  ok(!failed.length, 'every line is routed');
  const loop = paths[SELF];
  ok(loop.fromSide === 'left', 'the loop takes the freer corner');
  const xs = loop.points.map((q) => q[0]), ys = loop.points.map((q) => q[1]);
  const area = { x0: Math.min(...xs) - 4, y0: Math.min(...ys) - 4, x1: Math.max(...xs) + 4, y1: Math.max(...ys) + 4 };
  const through = paths['left.ref_id>right.id'].points.some(([x, y], i, pts) => i && (
    (y === pts[i - 1][1] && y > area.y0 && y < area.y1 && Math.min(x, pts[i - 1][0]) < area.x1 && Math.max(x, pts[i - 1][0]) > area.x0)
    || (x === pts[i - 1][0] && x > area.x0 && x < area.x1 && Math.min(y, pts[i - 1][1]) < area.y1 && Math.max(y, pts[i - 1][1]) > area.y0)));
  ok(!through, 'the passing line keeps clear of the loop');
}

// a busy diagram: every loop ends up at the corner the rule picks from the
// sides the other lines actually use
{
  let seed = 12;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tables = Array.from({ length: 46 }, (_, i) => ({ key: 't' + i, w: 220, h: 100 + Math.floor(random() * 200) }));
  const edges = [];
  while (edges.length < 90) {
    const a = Math.floor(random() * 46);
    const b = random() < 0.08 ? a : random() < 0.6 ? Math.min(45, (a - (a % 8)) + Math.floor(random() * 8)) : Math.floor(random() * 46);
    edges.push({ id: `t${a}.c${edges.length}>t${b}.id`, fromKey: 't' + a, toKey: 't' + b });
  }
  const boxes = [];
  for (let i = 0; i < 46; i += 8) { const order = tables.slice(i, i + 8); const pack = packGroup(order, 60); boxes.push({ pack, w: pack.w + 120, h: pack.h + 140 }); }
  let x = 0, y = 0, rowHeight = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > 2400) { x = 0; y += rowHeight + 220; rowHeight = 0; }
    b.x = x; b.y = y; x += b.w + 220; rowHeight = Math.max(rowHeight, b.h);
    for (const p of b.pack.placed) { p.table.x = b.x + 60 + p.x; p.table.y = b.y + 80 + p.y; }
  }
  const map = new Map(tables.map((t) => [t.key, t]));
  const { paths } = routeStraightTidy(edges, map, { groups: boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })) });
  const first = new Map();
  for (const e of edges) if (e.fromKey === e.toKey && paths[e.id] && !(first.get(e.fromKey) < e.id)) first.set(e.fromKey, e.id);
  let against = 0;
  for (const [key, id] of first) {
    const ends = [];
    for (const e of edges) {
      const p = paths[e.id];
      if (!p || e.fromKey === e.toKey) continue;
      if (e.fromKey === key) ends.push({ side: p.fromSide, other: map.get(e.toKey) });
      if (e.toKey === key) ends.push({ side: p.toSide, other: map.get(e.fromKey) });
    }
    if (selfLoopCorner(map.get(key), ends) !== paths[id].fromSide) against++;
  }
  ok(first.size > 5 && against === 0, `every loop follows the corner rule as the lines are routed (${against} of ${first.size} do not)`);
}

// curved lines: the same loop, and other ends keep clear of its ends
{
  const emp = table('employees', 0, 0);
  const map = byKey(emp, table('departments', 500, 0, 200, 160), table('stores', 500, 300, 200, 160));
  const edges = [loopEdge, edge('employees', 'departments', 'dept_id'), edge('employees', 'stores', 'store_id')];
  const routes = routeEdges(edges, map);
  const self = routes.find((r) => r.id === SELF);
  ok(!!self.loop && self.loop.fromSide === 'left' && self.loop.toSide === 'top', 'curved mode: the loop sits at the top-left corner');
  ok(self.fromSide === 'left' && self.fx === self.loop.points[0][0] && self.ty === 0, 'curved mode: the line ends are the loop ends');
  const onLeft = routes.filter((r) => r.id !== SELF && ((r.fromKey === 'employees' && r.fromSide === 'left') || (r.toKey === 'employees' && r.toSide === 'left')));
  ok(onLeft.every((r) => Math.abs((r.fromKey === 'employees' ? r.fy : r.ty) - self.fy) >= 12), 'curved mode: other ends keep clear of the loop end');
}

console.log(`self loop: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
