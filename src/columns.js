// Column counts, and the lines that leave a foreign-key column.

// Every column of every table. Hidden tables count too, as they do in the
// table count beside it.
export function countColumns(tables) {
  let n = 0;
  for (const t of tables || []) n += t.columns?.length || 0;
  return n;
}

// The lines that leave a column of a table: each relation whose foreign key
// includes the column (a composite key, for any of its columns), and each
// dashed link (drawn by hand or inferred) that starts at it. Ids match the
// drawn lines, `${fromKey}.${fromCol}>${toKey}.${toCol}`, where a relation is
// drawn from its first columns. Empty for a column that is not a foreign key.
export function columnLines(relations, manualLinks, tableKey, column) {
  const col = String(column).toLowerCase();
  const lines = [];
  const seen = new Set();
  const add = (id, fromKey, toKey, dashed) => {
    if (seen.has(id)) return;
    seen.add(id);
    lines.push({ id, fromKey, toKey, dashed });
  };
  for (const r of relations || []) {
    const fromKey = r.fromTable.toLowerCase();
    if (fromKey !== tableKey || !r.fromCols.some((c) => c.toLowerCase() === col)) continue;
    const toKey = r.toTable.toLowerCase();
    add(`${fromKey}.${r.fromCols[0]}>${toKey}.${r.toCols[0]}`, fromKey, toKey, false);
  }
  for (const l of manualLinks || []) {
    if (l.from.table !== tableKey || String(l.from.col).toLowerCase() !== col) continue;
    add(`${l.from.table}.${l.from.col}>${l.to.table}.${l.to.col}`, l.from.table, l.to.table, true);
  }
  return lines;
}
