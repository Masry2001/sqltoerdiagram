// Tests for column counts and the lines of a clicked foreign-key column.
// Run: node test/columns.test.mjs
import { countColumns, columnLines } from '../src/columns.js';
import { parseSchema } from '../src/parse.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const ids = (lines) => lines.map((l) => l.id).sort();

const SQL = `
CREATE TABLE customers (id INT PRIMARY KEY, name TEXT, email TEXT);
CREATE TABLE accounts (id INT PRIMARY KEY, owner TEXT);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  placed_at TIMESTAMP
);
CREATE TABLE products (sku TEXT, variant INT, title TEXT, PRIMARY KEY (sku, variant));
CREATE TABLE order_items (
  order_id INT,
  sku TEXT,
  variant INT,
  qty INT,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (sku, variant) REFERENCES products(sku, variant)
);
CREATE TABLE payments (
  id INT PRIMARY KEY,
  payer_id INT,
  FOREIGN KEY (payer_id) REFERENCES customers(id),
  FOREIGN KEY (payer_id) REFERENCES accounts(id)
);
`;
const model = parseSchema(SQL, 'sql');

{
  // 3 + 2 + 3 + 3 + 4 + 2
  ok(countColumns(model.tables) === 17, `every column of every table is counted (got ${countColumns(model.tables)})`);
  ok(countColumns([]) === 0 && countColumns(undefined) === 0, 'no tables, no columns');
  ok(countColumns(new Set(model.tables.filter((t) => t.key === 'orders'))) === 3, 'a selection (a Set of tables) can be counted');
}
{
  const lines = columnLines(model.relations, [], 'orders', 'customer_id');
  ok(lines.length === 1, 'a foreign-key column has its relation line');
  ok(lines[0].id === 'orders.customer_id>customers.id', `the id matches the drawn line (got ${lines[0]?.id})`);
  ok(lines[0].fromKey === 'orders' && lines[0].toKey === 'customers' && !lines[0].dashed, 'the line joins the two tables');
  ok(columnLines(model.relations, [], 'orders', 'CUSTOMER_ID').length === 1, 'column names match in any case');
}
{
  ok(columnLines(model.relations, [], 'orders', 'placed_at').length === 0, 'a column that is not a foreign key has no lines');
  ok(columnLines(model.relations, [], 'orders', 'id').length === 0, 'a referenced primary key is not a foreign key');
  ok(columnLines(model.relations, [], 'customers', 'customer_id').length === 0, 'only the clicked table\'s own key counts');
}
{
  // a composite key is drawn as one line, named after its first columns
  const first = columnLines(model.relations, [], 'order_items', 'sku');
  const second = columnLines(model.relations, [], 'order_items', 'variant');
  ok(first.length === 1 && first[0].id === 'order_items.sku>products.sku', `the first column of a composite key finds its line (got ${ids(first)})`);
  ok(second.length === 1 && second[0].id === 'order_items.sku>products.sku', `any column of a composite key finds its line (got ${ids(second)})`);
  ok(columnLines(model.relations, [], 'order_items', 'qty').length === 0, 'other columns of the table are not part of it');
}
{
  const lines = columnLines(model.relations, [], 'payments', 'payer_id');
  ok(lines.length === 2, 'a column with several relations has every line');
  ok(ids(lines).join() === 'payments.payer_id>accounts.id,payments.payer_id>customers.id', `each to its own table (got ${ids(lines)})`);
}
{
  const manual = [
    { from: { table: 'accounts', col: 'owner' }, to: { table: 'customers', col: 'id' } },
    { from: { table: 'orders', col: 'customer_id' }, to: { table: 'accounts', col: 'id' } },
  ];
  const owner = columnLines(model.relations, manual, 'accounts', 'owner');
  ok(owner.length === 1 && owner[0].dashed && owner[0].id === 'accounts.owner>customers.id', 'a dashed link that leaves a column is its line');
  ok(columnLines(model.relations, manual, 'customers', 'id').length === 0, 'a dashed link does not start at the column it points to');
  ok(columnLines(model.relations, manual, 'orders', 'customer_id').length === 2, 'relations and dashed links of a column are listed together');
}

// A column named key or index is a column, not a MySQL index clause.
{
  const m = parseSchema(`
CREATE TABLE permission_catalog (key text primary key, label text not null);
CREATE TABLE settings (index int, key varchar(64), value text);
CREATE TABLE t (id int, name text, KEY idx_name (name), INDEX (id), KEY (name, id));
CREATE TABLE r (permission_key text REFERENCES permission_catalog (key));`);
  const cols = (n) => m.tables.find((t) => t.name === n).columns.map((c) => c.name);
  ok(cols('permission_catalog').join() === 'key,label', 'a column named key is kept');
  ok(cols('settings').join() === 'index,key,value', 'columns named index and key (with a size) are kept');
  ok(cols('t').join() === 'id,name', 'KEY / INDEX clauses are still skipped');
  ok(m.relations.length === 1, 'a reference to a column named key still resolves');
  ok(countColumns(m.tables) === 8, 'column count includes key columns');
}

console.log(`columns: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
