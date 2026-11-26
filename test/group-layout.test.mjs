// Tests for the table order inside group boxes. Run: node test/group-layout.test.mjs
import { packGroup, segmentsCross, countCentreCrossings, orderTablesInGroups, arrangeInGroups } from '../src/group-layout.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const GAP = 36, PADDING = 36, HEADER = 44, GROUP_GAP = 80;
const table = (key, h = 160, w = 200) => ({ key, w, h });

// boxes as "organize groups" makes them: tables most connected first, boxes
// left to right then down
function organize(groups, lines) {
  const degree = new Map();
  for (const [a, b] of lines) { degree.set(a, (degree.get(a) || 0) + 1); degree.set(b, (degree.get(b) || 0) + 1); }
  const boxes = groups.map((tables) => {
    const order = [...tables].sort((a, b) => (degree.get(b.key) || 0) - (degree.get(a.key) || 0) || a.key.localeCompare(b.key));
    const pack = packGroup(order, GAP);
    return { order, pack, w: pack.w + PADDING * 2, h: pack.h + PADDING + HEADER };
  });
  const area = boxes.reduce((s, b) => s + (b.w + GROUP_GAP) * (b.h + GROUP_GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area * 1.6), ...boxes.map((b) => b.w));
  const place = () => {
    let x = 0, y = 0, rowHeight = 0;
    for (const box of boxes) {
      if (x > 0 && x + box.w > rowWidth) { x = 0; y += rowHeight + GROUP_GAP; rowHeight = 0; }
      box.x = x; box.y = y;
      x += box.w + GROUP_GAP;
      rowHeight = Math.max(rowHeight, box.h);
    }
  };
  place();
  return { boxes, place };
}
const centres = (boxes) => {
  const pos = new Map();
  for (const box of boxes) for (const p of box.pack.placed) pos.set(p.table.key, [box.x + PADDING + p.x + p.table.w / 2, box.y + HEADER + p.y + p.table.h / 2]);
  return (k) => pos.get(k);
};

// crossing test
{
  ok(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0]), 'an X crosses');
  ok(!segmentsCross([0, 0], [10, 0], [0, 5], [10, 5]), 'parallel lines do not cross');
  ok(!segmentsCross([0, 0], [10, 10], [10, 10], [20, 0]), 'lines meeting at an end do not cross');
  const at = { a: [0, 0], b: [10, 10], c: [0, 10], d: [10, 0] };
  ok(countCentreCrossings([['a', 'b'], ['c', 'd']], (k) => at[k]) === 1, 'counts one crossing');
  ok(countCentreCrossings([['a', 'b'], ['a', 'd']], (k) => at[k]) === 0, 'lines sharing a table do not count');
}

// a small shop schema: fewer crossings after ordering, never more
{
  const sales = ['customers', 'orders', 'order_items', 'payments', 'shipments', 'invoices'].map((k) => table(k));
  const catalog = ['products', 'categories', 'suppliers', 'product_images'].map((k) => table(k, 120));
  const people = ['employees', 'departments', 'addresses', 'stores'].map((k) => table(k, 140));
  const lines = [
    ['orders', 'customers'], ['order_items', 'orders'], ['order_items', 'products'], ['payments', 'orders'],
    ['shipments', 'orders'], ['shipments', 'addresses'], ['invoices', 'orders'], ['invoices', 'customers'],
    ['products', 'categories'], ['products', 'suppliers'], ['product_images', 'products'], ['suppliers', 'addresses'],
    ['employees', 'departments'], ['employees', 'stores'], ['stores', 'addresses'], ['orders', 'stores'],
    ['customers', 'addresses'], ['orders', 'employees'], ['categories', 'categories'],
  ];
  const { boxes, place } = organize([sales, catalog, people], lines);
  const plain = countCentreCrossings(lines.filter(([a, b]) => a !== b), centres(boxes));
  const result = orderTablesInGroups(boxes, lines, { gap: GAP, padding: PADDING, header: HEADER, place });
  const after = countCentreCrossings(lines.filter(([a, b]) => a !== b), centres(boxes));
  console.log(`  shop sample: ${result.before} -> ${result.after} crossings`);
  ok(result.before === plain, 'reports the crossings before');
  ok(result.after === after, 'reports the crossings after, as placed');
  ok(after <= plain, 'never more crossings than before');
  ok(after < plain, 'fewer crossings on this sample');
  ok(boxes.every((b, i) => b.order.length === [sales, catalog, people][i].length), 'every table stays in its own box');
  ok(boxes.every((b) => b.h === b.pack.h + PADDING + HEADER), 'box sizes follow the new order');
}

// a larger diagram (46 tables, 90 lines) stays quick
{
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const tables = Array.from({ length: 46 }, (_, i) => table('t' + i, 100 + Math.floor(random() * 200)));
  const groups = [];
  for (let i = 0; i < tables.length; i += 8) groups.push(tables.slice(i, i + 8));
  const lines = [];
  while (lines.length < 90) {
    const a = Math.floor(random() * 46);
    const b = random() < 0.6 ? Math.min(45, (a - (a % 8)) + Math.floor(random() * 8)) : Math.floor(random() * 46);
    if (a !== b) lines.push(['t' + a, 't' + b]);
  }
  const { boxes, place } = organize(groups, lines);
  const started = Date.now();
  const result = orderTablesInGroups(boxes, lines, { gap: GAP, padding: PADDING, header: HEADER, place, timeLimit: 1500 });
  const ms = Date.now() - started;
  console.log(`  46 tables / 90 lines: ${result.before} -> ${result.after} crossings in ${ms} ms`);
  ok(result.after <= result.before, 'never more crossings on a large diagram');
  ok(ms < 2500, 'stops near its time limit');
}

// "Arrange inside groups": tables stay in their boxes, boxes keep their places
{
  const sales = ['customers', 'orders', 'order_items', 'payments', 'shipments', 'invoices'].map((k) => table(k));
  const catalog = ['products', 'categories', 'suppliers', 'product_images'].map((k) => table(k, 120));
  const people = ['employees', 'departments', 'addresses', 'stores'].map((k) => table(k, 140));
  const lines = [
    ['orders', 'customers'], ['order_items', 'orders'], ['order_items', 'products'], ['payments', 'orders'],
    ['shipments', 'orders'], ['shipments', 'addresses'], ['invoices', 'orders'], ['invoices', 'customers'],
    ['products', 'categories'], ['products', 'suppliers'], ['product_images', 'products'], ['suppliers', 'addresses'],
    ['employees', 'departments'], ['employees', 'stores'], ['stores', 'addresses'], ['orders', 'stores'],
    ['customers', 'addresses'], ['orders', 'employees'], ['categories', 'categories'], ['notes', 'orders'],
  ];
  const { boxes } = organize([sales, catalog, people], lines);
  const tables = [];
  const frames = boxes.map((b, i) => {
    for (const p of b.pack.placed) tables.push({ ...p.table, x: b.x + PADDING + p.x, y: b.y + HEADER + p.y });
    return { id: 'g' + i, type: 'group', text: 'Group ' + i, color: 'blue', x: b.x, y: b.y, w: b.w, h: b.h };
  });
  const loose = { key: 'notes', w: 200, h: 100, x: -400, y: -300 };
  tables.push(loose);
  const result = arrangeInGroups(frames, tables, lines);
  console.log(`  arrange inside groups: ${result.before} -> ${result.after} crossings`);
  ok(result.after <= result.before, 'never more crossings than the layout it started from');
  ok(!result.positions.notes, 'a table outside every group stays put');
  ok(result.frames.every((f, i) => f.id === frames[i].id && f.text === frames[i].text && f.color === frames[i].color), 'group boxes keep their name, colour and id');
  ok(result.frames[0].x === frames[0].x && result.frames[0].y === frames[0].y, 'the first box stays where it was');
  const inside = (f, t) => t.x >= f.x && t.y >= f.y && t.x + t.w <= f.x + f.w && t.y + t.h <= f.y + f.h;
  const home = (key) => [sales, catalog, people].findIndex((g) => g.some((t) => t.key === key));
  ok(tables.filter((t) => t.key !== 'notes').every((t) => inside(result.frames[home(t.key)], { ...t, ...result.positions[t.key] })), 'every table stays inside its own box');
  const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
  ok(result.frames.every((f, i) => result.frames.every((g, j) => i === j || apart(f, g))), 'boxes do not overlap');
  const one = arrangeInGroups([], tables, lines);
  ok(one.frames.length === 0 && Object.keys(one.positions).length === tables.length, 'without groups the whole diagram is one group, with no box drawn');
  ok(one.after <= one.before, 'as one group: never more crossings');
  const x0 = Math.min(...tables.map((t) => t.x)), y0 = Math.min(...tables.map((t) => t.y));
  ok(Object.values(one.positions).every((p) => p.x >= x0 && p.y >= y0), 'as one group: packed from the top-left corner');
}

console.log(`group layout: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
