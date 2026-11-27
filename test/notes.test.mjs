// Tests for sticky notes: text in world units, and straight lines going
// around notes. Run: node test/notes.test.mjs
import { noteTextLayout, noteTextAsBars, NOTE_FONT, NOTE_LINE, NOTE_PAD } from '../src/annotations.js';
import { routeStraight, routeStraightTidy, routeMoved, pathUnderTables } from '../src/orthogonal-router.js';
import { exportSVG } from '../src/svg-export.js';
import { parseSchema } from '../src/parse.js';
import { layout } from '../src/layout.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

// ---- text in world units ----
{
  ok(NOTE_FONT === 13 && NOTE_LINE === 17 && NOTE_PAD === 10, 'at 100% a note looks as before: 13 px text, 17 px lines, 10 px padding');
  const note = { x: 100, y: 200, w: 300, h: 120 };
  const lines = Array.from({ length: 25 }, (_, i) => ({ text: 'line ' + i, w: 40 }));
  const placed = noteTextLayout(note, lines);
  ok(placed[0].x === 110 && placed[0].y === 210, 'the first line starts at the padding, in world units');
  ok(placed.every((l, i) => l.y === 210 + i * 17), 'lines are 17 world units apart');
  ok(placed.length === 6 && placed.at(-1).y <= note.y + note.h - NOTE_PAD, 'lines past the bottom are left out');
  const tall = noteTextLayout({ ...note, h: 25 * 17 + 20 }, lines);
  ok(tall.length === 25, 'a note tall enough shows all 25 lines');
  ok(!noteTextAsBars(1) && !noteTextAsBars(0.4), 'readable text is drawn as text');
  ok(noteTextAsBars(0.2), 'far out, text too small to read is drawn as bars');
}

// ---- the SVG export lays notes out the same way ----
{
  const model = parseSchema('CREATE TABLE customers (id INT PRIMARY KEY, name TEXT);');
  layout(model, {});
  const text = Array.from({ length: 10 }, (_, i) => 'Note line ' + i).join('\n');
  const svg = exportSVG(model, 'light', [{ id: 'n1', type: 'note', x: 500, y: 40, w: 260, h: 100, text, color: 'yellow' }]);
  const ys = [...svg.matchAll(/<tspan x="510" y="([\d.]+)">Note line/g)].map((m) => +m[1]);
  ok(ys.length === 5, 'SVG: lines past the bottom of the note are cut, as on the canvas');
  ok(ys.every((y, i) => y === 40 + NOTE_PAD + NOTE_FONT - 1 + i * NOTE_LINE), 'SVG: same line positions as before (world units)');
  ok(svg.includes(`font-size="${NOTE_FONT}"`), 'SVG: 13 px note text');
}

// ---- straight lines go around notes ----
{
  const t = (key, x, y, w = 200, h = 120) => ({ key, x, y, w, h });
  const map = new Map([t('orders', 0, 0), t('customers', 700, 0)].map((x) => [x.key, x]));
  const edges = [{ id: 'orders.customer_id>customers.id', fromKey: 'orders', toKey: 'customers' }];
  const note = { x: 300, y: -60, w: 240, h: 240 };       // right between the two tables
  const free = routeStraight(edges, map);
  ok(pathUnderTables(Object.values(free.paths)[0].points, [note]), 'without the note as an obstacle the line runs under it');
  for (const [name, run] of [
    ['routeStraight', () => routeStraight(edges, map, { obstacles: [note] })],
    ['routeStraightTidy', () => routeStraightTidy(edges, map, { obstacles: [note] })],
    ['routeMoved', () => routeMoved(edges, map, { obstacles: [note] })],
  ]) {
    const { paths, failed } = run();
    const p = Object.values(paths)[0];
    ok(!failed.length && !!p, `${name}: the line is routed`);
    ok(p && !pathUnderTables(p.points, [note]), `${name}: the line goes around the note`);
    const clear = p && p.points.every(([x, y], i) => !i || (() => {
      const [px, py] = p.points[i - 1];
      const lx = Math.min(x, px), hx = Math.max(x, px), ly = Math.min(y, py), hy = Math.max(y, py);
      return !(hx > note.x - 8 && lx < note.x + note.w + 8 && hy > note.y - 8 && ly < note.y + note.h + 8);
    })());
    ok(clear, `${name}: and keeps a margin from it`);
  }
  const odd = routeStraight(edges, map, { obstacles: [null, { x: 1, y: 2 }, { x: 0, y: 0, w: 0, h: 10 }] });
  ok(Object.keys(odd.paths).length === 1, 'broken or empty note rectangles are ignored');
}

console.log(`notes: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
