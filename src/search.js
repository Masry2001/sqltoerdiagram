// Search across table and column names (the diagram is a canvas, so the
// browser's own find can't see it). Words may be in any order, and a dot or
// space separates them, so "users email", "users.email" and "email" all work.

const MATCH_EXACT = 0;
const MATCH_START = 1;
const MATCH_INSIDE = 2;

function matchQuality(text, word) {
  if (text === word) return MATCH_EXACT;
  if (text.startsWith(word)) return MATCH_START;
  return text.includes(word) ? MATCH_INSIDE : null;
}

export function searchSchema(model, query, limit = 60) {
  const words = query.toLowerCase().split(/[\s.]+/).filter(Boolean);
  if (!words.length) return { results: [], total: 0 };
  const results = [];

  for (const table of model.tables) {
    const tableName = table.name.toLowerCase();

    if (words.every((w) => tableName.includes(w))) {
      const quality = matchQuality(tableName, words.join('_')) ?? matchQuality(tableName, words[0]) ?? MATCH_INSIDE;
      results.push({ kind: 'table', key: table.key, table: table.name, column: null, type: `${table.columns.length} columns`, score: quality });
    }

    for (const column of table.columns) {
      const columnName = column.name.toLowerCase();
      const text = `${tableName} ${columnName}`;
      if (!words.every((w) => text.includes(w))) continue;
      // at least one word has to be about the column, or a table search would
      // list every column of that table
      const qualities = words.map((w) => matchQuality(columnName, w)).filter((q) => q !== null);
      if (!qualities.length) continue;
      results.push({
        kind: 'column',
        key: table.key,
        table: table.name,
        column: column.name,
        type: column.type || '',
        score: Math.min(...qualities),
      });
    }
  }

  results.sort((a, b) => a.score - b.score
    || (a.kind === b.kind ? 0 : a.kind === 'table' ? -1 : 1)
    || a.table.length - b.table.length
    || a.table.localeCompare(b.table)
    || String(a.column).localeCompare(String(b.column)));
  return { results: results.slice(0, limit), total: results.length };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function highlight(text, words) {
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    let from = lower.indexOf(w);
    while (w && from >= 0) {
      for (let i = from; i < from + w.length; i++) marks[i] = true;
      from = lower.indexOf(w, from + w.length);
    }
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const open = marks[i] && !marks[i - 1];
    const close = marks[i] && !marks[i + 1];
    out += (open ? '<mark>' : '') + esc(text[i]) + (close ? '</mark>' : '');
  }
  return out;
}

// The search box: Ctrl+F opens it, typing lists matches, Enter or a click
// shows one (Enter again moves to the next), Escape closes it.
export function createSearchBox(diagram, host) {
  const box = document.createElement('div');
  box.className = 'search-box';
  box.hidden = true;
  box.innerHTML =
    '<div class="sb-head"><input id="schema-search" class="sb-input" type="text" placeholder="Search tables and fields…" autocomplete="off" spellcheck="false" aria-label="Search tables and fields" />' +
    '<span class="sb-count"></span>' +
    '<button class="sb-close icon-btn" aria-label="Close search">✕</button></div>' +
    '<div class="sb-list" role="listbox"></div>' +
    '<div class="sb-hint">↑ ↓ to choose · Enter to show · Esc to close</div>';
  host.appendChild(box);

  const input = box.querySelector('.sb-input');
  const count = box.querySelector('.sb-count');
  const list = box.querySelector('.sb-list');
  let results = [];
  let active = 0;
  let shown = -1;

  function render() {
    const query = input.value.trim();
    const words = query.toLowerCase().split(/[\s.]+/).filter(Boolean);
    const found = searchSchema(diagram.model, query);
    results = found.results;
    active = Math.min(active, Math.max(0, results.length - 1));
    count.textContent = query ? (found.total > results.length ? `${results.length} of ${found.total}` : `${found.total}`) : '';
    list.innerHTML = '';
    if (query && !results.length) {
      list.innerHTML = '<div class="sb-empty">No table or field matches</div>';
      return;
    }
    results.forEach((r, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sb-row' + (i === active ? ' is-active' : '');
      row.setAttribute('role', 'option');
      const hidden = diagram.hidden.has(r.key) ? ' <span class="sb-hidden">hidden</span>' : '';
      const name = r.kind === 'table'
        ? highlight(r.table, words)
        : `<span class="sb-table">${highlight(r.table, words)}.</span>${highlight(r.column, words)}`;
      row.innerHTML =
        `<span class="sb-kind ${r.kind === 'table' ? 'is-table' : ''}" title="${r.kind === 'table' ? 'Table' : 'Field'}">${r.kind === 'table' ? 'T' : 'F'}</span>` +
        `<span class="sb-name">${name}${hidden}</span>` +
        `<span class="sb-type">${esc(r.type)}</span>`;
      row.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the box
      row.addEventListener('click', () => { active = i; show(i); });
      list.appendChild(row);
    });
  }

  function markActive() {
    [...list.querySelectorAll('.sb-row')].forEach((row, i) => {
      row.classList.toggle('is-active', i === active);
      if (i === active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function show(i) {
    const r = results[i];
    if (!r) return;
    diagram.focusSearchResult(r.key, r.column);
    shown = i;
    markActive();
  }

  input.addEventListener('input', () => { active = 0; shown = -1; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      markActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!results.length) return;
      if (shown === active) active = (active + (e.shiftKey ? -1 : 1) + results.length) % results.length;
      show(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  box.querySelector('.sb-close').addEventListener('click', () => close());

  function open() {
    box.hidden = false;
    shown = -1;
    render();
    input.focus();
    input.select();
  }

  function close() {
    box.hidden = true;
    diagram.clearSearchMark();
    input.blur();
  }

  return { open, close, isOpen: () => !box.hidden };
}
