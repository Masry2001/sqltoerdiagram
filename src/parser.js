// SQL DDL parser — extracts tables, columns and foreign-key relations from
// CREATE TABLE / ALTER TABLE statements. Tolerant of MySQL, Postgres and
// SQL-Server-ish dialects (backticks, "quotes", [brackets], schema.qualified).
//
// It also records SOURCE SPANS (absolute character offsets into the original
// SQL) for table names, column names, column types and FK references. These
// power two-way editing: editing a table on the canvas becomes a precise text
// splice, so the user's comments / formatting / unsupported clauses survive.
//
// Offsets stay valid because comments are blanked to equal-length whitespace
// rather than removed.

// Replace comments with same-length whitespace (newlines preserved), so every
// offset in the returned string maps 1:1 to the original SQL.
function blankComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
    } else if (c === '#') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < n) { out += sql[i]; const done = sql[i] === c && sql[i - 1] !== '\\'; i++; if (done) break; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

// Split top-level statements on ';'. Returns [{text, start}] (start = offset).
function splitStatements(S) {
  const out = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < S.length; i++) {
    const c = S[i];
    if (q) { if (c === q && S[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { out.push({ text: S.slice(start, i), start }); start = i + 1; }
  }
  if (S.slice(start).trim()) out.push({ text: S.slice(start), start });
  return out;
}

// Split a parenthesised body on top-level commas. Returns [{text, start}].
function splitTopCommas(body, base) {
  const parts = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === q && body[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push({ text: body.slice(start, i), start: base + start }); start = i + 1; }
  }
  parts.push({ text: body.slice(start), start: base + start });
  return parts;
}

function clean(id) {
  if (!id) return id;
  id = id.trim();
  // Strip a *matched* wrapping delimiter pair only: `id`, "id", [id].
  // Stripping the sides independently would mangle e.g. the type TEXT[]
  // (no leading '[') into TEXT[ by dropping the trailing ']'.
  const close = { '`': '`', '"': '"', '[': ']' }[id[0]];
  if (id.length >= 2 && close && id[id.length - 1] === close) return id.slice(1, -1);
  return id;
}
function bareName(id) {
  const parts = id.split('.');
  return clean(parts[parts.length - 1]);
}

// Tokenise a definition; each token carries absolute start/end offsets.
function tokenize(def, base) {
  const tokens = [];
  let i = 0;
  const n = def.length;
  while (i < n) {
    const c = def[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') {
      let depth = 0, start = i;
      while (i < n) {
        if (def[i] === '(') depth++;
        if (def[i] === ')') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    } else if (c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      let start = i; i++;
      while (i < n && def[i] !== close) i++;
      i++;
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    } else if (c === ',') {
      i++;
    } else {
      let start = i;
      while (i < n && !/[\s(,]/.test(def[i])) i++;
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    }
  }
  return tokens;
}

function parseColumnsFromParen(group) {
  const inner = group.replace(/^\(/, '').replace(/\)$/, '');
  return splitTopCommas(inner, 0).map(p => bareName(p.text));
}

// Identifier spans for each column listed in a "(a, b, c)" clause, given the
// inner text and its absolute base offset. Used to keep PK/FK/UNIQUE clauses
// in sync when a column is renamed.
function colSpans(innerText, innerBase) {
  const out = [];
  for (const seg of splitTopCommas(innerText, innerBase)) {
    const m = seg.text.match(/\S+/);
    if (!m) continue;
    const raw = m[0];
    let s = seg.start + m.index, e = s + raw.length;
    if (/^[`"\[]/.test(raw)) { s += 1; e -= 1; }
    out.push({ name: bareName(raw).toLowerCase(), start: s, end: e });
  }
  return out;
}

const CREATE_RE = /create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+|transient\s+|volatile\s+)?table\s+(?:if\s+not\s+exists\s+)?/i;

export function parseSchema(sql) {
  const original = sql || '';
  const S = blankComments(original);
  const statements = splitStatements(S);

  const tables = new Map();   // lowerName -> table object
  const relations = [];
  const errors = [];

  const ensureTable = (name, nameSpan) => {
    const key = name.toLowerCase();
    if (!tables.has(key)) {
      tables.set(key, { name, key, columns: [], colIndex: new Map(), colRefs: [], nameSpan, bodySpan: null });
    } else if (nameSpan && !tables.get(key).nameSpan) {
      tables.get(key).nameSpan = nameSpan;
    }
    return tables.get(key);
  };

  for (const st of statements) {
    const stmt = st.text;
    const base = st.start;
    if (!stmt.trim()) continue;

    const cm = stmt.match(CREATE_RE);
    if (cm) {
      const afterStart = cm.index + cm[0].length;
      const after = stmt.slice(afterStart);
      const open = after.indexOf('(');
      if (open < 0) continue;
      // table name token sits between afterStart and the '('
      const nameRegion = after.slice(0, open);
      const rawNameMatch = nameRegion.match(/(\S+)/);
      if (!rawNameMatch) continue;
      const rawName = rawNameMatch[1];
      const nameLocal = afterStart + rawNameMatch.index;
      // span covers the bare table name (last dotted part) for clean rename
      const dotIdx = rawName.lastIndexOf('.');
      const bareStart = nameLocal + (dotIdx >= 0 ? dotIdx + 1 : 0);
      const name = bareName(rawName);
      const nameSpan = [base + bareStart, base + nameLocal + rawName.length];

      // balanced body
      let depth = 0, end = -1;
      for (let i = open; i < after.length; i++) {
        if (after[i] === '(') depth++;
        if (after[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) { errors.push(`Unbalanced parens in table "${name}"`); continue; }
      const bodyLocal = afterStart + open + 1;
      const body = after.slice(open + 1, end);
      const table = ensureTable(name, nameSpan);
      table.bodySpan = [base + bodyLocal, base + afterStart + end];
      table.stmtSpan = [base + cm.index, base + stmt.length];   // CREATE … (sans ';')
      parseTableBody(body, base + bodyLocal, table, relations);
      continue;
    }

    // ALTER TABLE [ONLY] x ADD [CONSTRAINT y] FOREIGN KEY (a) REFERENCES z (b)
    // (pg_dump emits "ALTER TABLE ONLY schema.table")
    const am = stmt.match(/alter\s+table\s+(?:only\s+)?([^\s(]+(?:\.[^\s(]+)?)\s+add\s+/is);
    if (am) {
      const t = bareName(am[1]);
      const tail = stmt.slice(am.index + am[0].length);
      const tailBase = base + am.index + am[0].length;
      const rel = parseForeignKey(tail, tailBase, t);
      if (rel) relations.push(rel);
    }
  }

  // resolve relations; mark fk columns
  const tableList = [...tables.values()];
  const resolved = [];
  for (const r of relations) {
    const from = tables.get(r.fromTable.toLowerCase());
    const to = tables.get(r.toTable.toLowerCase());
    if (!from) continue;
    for (const c of r.fromCols) {
      const col = from.colIndex.get(c.toLowerCase());
      if (col) col.fk = true;
    }
    resolved.push({
      fromTable: from.name,
      fromCols: r.fromCols,
      toTable: to ? to.name : r.toTable,
      toCols: r.toCols,
      toMissing: !to,
      refSpan: r.refSpan || null,
    });
  }

  return { tables: tableList, relations: resolved, errors, sql: original };
}

function parseTableBody(body, base, table, relations) {
  const items = splitTopCommas(body, base);
  for (const part of items) {
    const item = part.text;
    if (!item.trim()) continue;
    const tokens = tokenize(item, part.start);
    if (!tokens.length) continue;
    const head = clean(tokens[0].text).toLowerCase();

    if (head === 'primary' && tokens[1] && /key/i.test(tokens[1].text)) {
      markKeyCols(tokens, table, 'pk');
      continue;
    }
    if (head === 'unique') {
      markKeyCols(tokens, table, 'unique');
      continue;
    }
    if (head === 'foreign' && tokens[1] && /key/i.test(tokens[1].text)) {
      const rel = parseForeignKey(item, part.start, table.name);
      if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      continue;
    }
    if (head === 'constraint') {
      if (/foreign\s+key/i.test(item)) {
        const rel = parseForeignKey(item, part.start, table.name);
        if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      } else if (/primary\s+key/i.test(item)) {
        markKeyCols(tokens, table, 'pk');
      }
      continue;
    }
    if (head === 'check' || head === 'fulltext' || head === 'spatial') continue;
    // MySQL `KEY [name] (cols)` / `INDEX [name] (cols)` is an index, but a
    // column may also be named key or index (`key text primary key`).
    if ((head === 'key' || head === 'index') && isIndexClause(item)) continue;

    // column definition
    const nameTok = tokens[0];
    const colName = bareName(nameTok.text);
    if (!colName) continue;
    // name span = bare identifier (strip wrapping quotes from the token span)
    let ns = nameTok.start, ne = nameTok.end;
    if (/^[`"\[]/.test(nameTok.text)) { ns += 1; ne -= 1; }

    let type = '', typeSpan = null;
    if (tokens[1] && !/^\(/.test(tokens[1].text)) {
      const t1 = tokens[1];
      type = clean(t1.text);
      typeSpan = [t1.start, t1.end];
      if (tokens[2] && tokens[2].text.startsWith('(')) { // e.g. varchar (255)
        type += tokens[2].text;
        typeSpan = [t1.start, tokens[2].end];
      } else if (t1.text.includes('(')) {
        type = t1.text;
      }
    }

    const rest = item.toLowerCase();
    const col = {
      name: colName,
      type: prettyType(type),
      typeRaw: type,
      pk: /\bprimary\s+key\b/.test(rest),
      nn: /\bnot\s+null\b/.test(rest),
      unique: /\bunique\b/.test(rest),
      fk: false,
      nameSpan: [ns, ne],
      typeSpan,
      defSpan: [part.start, part.start + item.length],   // full "name type …" segment
    };
    table.columns.push(col);
    table.colIndex.set(colName.toLowerCase(), col);

    // inline REFERENCES other(col)
    const refm = item.match(/references\s+([^\s(]+(?:\.[^\s(]+)?)\s*(\([^)]*\))?/id);
    if (refm) {
      col.fk = true;
      const toTable = bareName(refm[1]);
      const toCols = refm[2] ? parseColumnsFromParen(refm[2]) : [];
      const gi = refm.indices[1];
      const dotIdx = refm[1].lastIndexOf('.');
      const refStart = part.start + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
      relations.push({
        fromTable: table.name,
        fromCols: [colName],
        toTable,
        toCols,
        refSpan: [refStart, part.start + gi[1]],
      });
    }
  }
}

// Column types that take a size in parentheses, e.g. `key varchar(255)`.
const SIZED_TYPES = new Set(['varchar', 'char', 'character', 'nvarchar', 'nchar', 'varbinary',
  'binary', 'bit', 'decimal', 'numeric', 'dec', 'float', 'double', 'real', 'int', 'integer',
  'bigint', 'smallint', 'tinyint', 'mediumint', 'number', 'varchar2', 'nvarchar2', 'raw',
  'time', 'timestamp', 'timestamptz', 'datetime', 'datetime2', 'interval', 'enum', 'set', 'string']);

// True when a body item that starts with KEY or INDEX is an index definition
// (`KEY idx_a (a, b)`, `INDEX (a)`), false when it is a column named key/index.
export function isIndexClause(item) {
  const m = /^\s*(?:key|index)\s*(?:([`"\[]?[\w$]+[`"\]]?)\s*)?\(/i.exec(item);
  if (!m) return false;
  if (m[1] && SIZED_TYPES.has(m[1].replace(/[`"\[\]]/g, '').toLowerCase())) return false;
  return true;
}

// Mark a table-level key clause's columns and record their spans for renames.
function markKeyCols(tokens, table, flag) {
  const grp = tokens.find(t => t.text.startsWith('('));
  if (!grp) return;
  for (const ref of colSpans(grp.text.slice(1, -1), grp.start + 1)) {
    const col = table.colIndex.get(ref.name);
    if (col) col[flag] = true;
    table.colRefs.push(ref);
  }
}

function parseForeignKey(text, base, fromTable) {
  const m = text.match(
    /foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+(?:\.[^\s(]+)?)\s*(\(([^)]*)\))?/id
  );
  if (!m) return null;
  const fromCols = m[1].split(',').map(s => bareName(s)).filter(Boolean);
  const toTable = bareName(m[2]);
  const toCols = m[4] ? m[4].split(',').map(s => bareName(s)).filter(Boolean) : [];
  const gi = m.indices[2];
  const dotIdx = m[2].lastIndexOf('.');
  const refStart = base + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
  const localColSpans = colSpans(m[1], base + m.indices[1][0]);
  return { fromTable, fromCols, toTable, toCols, refSpan: [refStart, base + gi[1]], localColSpans };
}

function prettyType(t) {
  if (!t) return '';
  const m = t.match(/^([a-zA-Z_]+)(.*)$/s);
  if (!m) return t.toLowerCase();
  return m[1].toLowerCase() + (m[2] || '').replace(/\s+/g, '');
}
