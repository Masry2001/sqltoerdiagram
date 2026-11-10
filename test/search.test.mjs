// Tests for table and field search. Run: node test/search.test.mjs
import { searchSchema } from '../src/search.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const table = (name, columns) => ({
  name, key: name.toLowerCase(),
  columns: columns.map(([n, type]) => ({ name: n, type })),
});
const model = {
  tables: [
    table('users', [['id', 'bigint'], ['email', 'varchar(255)'], ['name', 'varchar(255)']]),
    table('user_devices', [['id', 'bigint'], ['user_id', 'bigint'], ['visitor_id', 'varchar(128)']]),
    table('organizations', [['id', 'bigint'], ['email', 'varchar(255)']]),
    table('Releases', [['id', 'bigint'], ['UPC', 'varchar(32)']]),
  ],
};
const labels = (q) => searchSchema(model, q).results.map((r) => (r.column ? `${r.table}.${r.column}` : r.table));

{
  const r = labels('users');
  ok(r[0] === 'users', 'exact table name comes first');
  ok(labels('user').includes('user_devices'), 'other tables containing the word are listed');
  ok(!r.includes('users.email'), 'a table search does not list all its columns');
}
{
  const r = labels('email');
  ok(r.includes('users.email') && r.includes('organizations.email'), 'a field is found in every table');
  ok(r.every((x) => x.endsWith('.email')), 'only matching fields are listed');
}
{
  ok(labels('users email')[0] === 'users.email', 'table and field words narrow to one field');
  ok(labels('users.email')[0] === 'users.email', 'dot notation works');
  ok(labels('email users')[0] === 'users.email', 'word order does not matter');
}
{
  ok(labels('upc')[0] === 'Releases.UPC', 'search ignores letter case');
  ok(labels('vis').includes('user_devices.visitor_id'), 'part of a word matches');
  const r = labels('id');
  ok(r.indexOf('users.id') < r.indexOf('user_devices.user_id'), 'exact field names come before partial ones');
}
{
  ok(searchSchema(model, '').results.length === 0, 'an empty search lists nothing');
  ok(searchSchema(model, '   ').results.length === 0, 'spaces alone list nothing');
  ok(searchSchema(model, 'zzz').results.length === 0, 'no match lists nothing');
  const limited = searchSchema(model, 'id', 2);
  ok(limited.results.length === 2 && limited.total > 2, 'long result lists are capped and report the total');
  const r = searchSchema(model, 'email').results[0];
  ok(r.kind === 'column' && r.key === 'users' && r.type === 'varchar(255)', 'a field result carries its table key and type');
}

console.log(`search: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
