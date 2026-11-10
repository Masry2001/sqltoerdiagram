// Tests for "My diagrams" (src/store.js). Run: node test/store.test.mjs
// The store and these checks come from the upstream project.
import { createStore, hashText } from '../src/store.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const st = createStore(storage);
  ok(st.list().length === 1 && st.current.name === 'Untitled diagram', 'a first diagram exists by default');
  const first = st.currentId;
  const id = st.create('Shop', { sql: 'CREATE TABLE a (id int);' }, { tables: 1, hash: 'h1' });
  ok(id && st.list().length === 2 && st.currentId === first, 'create adds a diagram without opening it');
  const content = st.open(id, { sql: 'FIRST' });
  ok(content.sql === 'CREATE TABLE a (id int);' && st.currentId === id, 'open returns the stored content');
  ok(st.open(first, { sql: 'SHOP NOW' }).sql === 'FIRST', 'the diagram you left is parked and comes back intact');
  ok(st.create('Shop', null) && st.list().some((d) => d.name === 'Shop 2'), 'duplicate names get a number');
  ok(!st.remove(st.currentId), 'the open diagram cannot be removed');
  ok(st.remove(id) && !st.get(id), 'other diagrams can be removed');
  ok(st.rename(first, '  Billing  ') && st.current.name === 'Billing', 'rename trims');
  ok(createStore(storage).current.name === 'Billing', 'the index persists');
  ok(hashText('a') !== hashText('b') && hashText('a') === hashText('a'), 'hash is stable');
}

console.log(`store: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
