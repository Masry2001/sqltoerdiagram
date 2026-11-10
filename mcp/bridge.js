// Browser side of the MCP server (mcp/server.mjs). Loaded by the dev server only
// (see mcpBridge in vite.config.js). It uses the app's own debug handle and file
// input, so the app itself needs no changes.
import { layout } from '/src/layout.js';

const BRIDGE_URL = 'http://127.0.0.1:5199';
const GROUP_COLORS = ['blue', 'green', 'amber', 'purple'];
const LOAD_TIMEOUT_MS = 20_000;
const MIN_ZOOM = 0.08; // the app's lowest zoom when fitting the diagram
const LABEL_HEADER = 320; // clears a group name drawn at MIN_ZOOM

const diagram = () => window.__dbdiga;
const sqlEl = () => document.getElementById('sql');
const fileInput = () => document.getElementById('file-open');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (name) => String(name).toLowerCase();

function changed() {
  const d = diagram();
  d._tmapDirty = true;
  d.markDirty();
  d.onLayoutChange?.();
}

function tableMap() {
  return new Map(diagram().model.tables.map((t) => [t.key, t]));
}

function resolveKeys(names = []) {
  const known = tableMap();
  const keys = [];
  const unknown = [];
  for (const name of names) {
    const key = keyOf(name);
    if (known.has(key)) keys.push(key);
    else unknown.push(name);
  }
  return { keys, unknown };
}

function summary() {
  const d = diagram();
  return {
    tables: d.model.tables.length,
    relations: d.model.relations.length,
    manual_links: d.manualLinks.length,
    hidden: d.hidden.size,
    annotations: d.annotations.length,
    errors: d.model.errors ?? [],
  };
}

function currentProject() {
  const d = diagram();
  const positions = {};
  for (const t of d.model.tables) {
    if (Number.isFinite(t.x)) positions[t.key] = { x: Math.round(t.x), y: Math.round(t.y) };
  }
  return {
    app: 'dbdiga',
    version: 1,
    sql: sqlEl().value,
    dialect: localStorage.getItem('dbdiga-dialect') || undefined,
    positions,
    camera: { x: Math.round(d.cam.x), y: Math.round(d.cam.y), scale: +d.cam.scale.toFixed(4) },
    annotations: d.annotations.map((a) => ({ ...a })),
    hidden: [...d.hidden],
    manualLinks: d.manualLinks.map((l) => ({ from: { ...l.from }, to: { ...l.to } })),
    edgeBends: { ...d.edgeBends },
    edgeAnchors: { ...d.edgeAnchors },
    edgePaths: { ...d.edgePaths },
  };
}

// Goes through the app's "Open project" path. It clears the input when done.
async function loadProject(project) {
  const input = fileInput();
  const file = new File([JSON.stringify(project)], 'project.json', { type: 'application/json' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));

  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (input.value !== '') {
    if (Date.now() > deadline) throw new Error('The diagram took too long to load the project.');
    await delay(30);
  }

  // The app keeps the old position of any table that shares a name with the
  // previous diagram, so re-apply the project's own positions.
  for (const t of diagram().model.tables) {
    const p = project.positions?.[t.key];
    if (p && Number.isFinite(p.x)) {
      t.x = p.x;
      t.y = p.y;
    }
  }
  changed();
  return summary();
}

function degrees() {
  const d = diagram();
  const count = new Map();
  const bump = (key) => count.set(key, (count.get(key) || 0) + 1);
  for (const r of d.model.relations) {
    bump(keyOf(r.fromTable));
    bump(keyOf(r.toTable));
  }
  for (const l of d.manualLinks) {
    bump(l.from.table);
    bump(l.to.table);
  }
  return count;
}

// Packs tables into columns, each new table going to the shortest column.
function packGroup(tables, gap) {
  const columnWidth = Math.max(...tables.map((t) => t.w));
  const area = tables.reduce((sum, t) => sum + (columnWidth + gap) * (t.h + gap), 0);
  const count = Math.max(1, Math.min(tables.length, Math.round(Math.sqrt(area * 1.6) / (columnWidth + gap))));
  const heights = new Array(count).fill(0);
  const placed = [];
  for (const t of tables) {
    const column = heights.indexOf(Math.min(...heights));
    placed.push({ table: t, x: column * (columnWidth + gap), y: heights[column] });
    heights[column] += t.h + gap;
  }
  return {
    placed,
    w: count * columnWidth + (count - 1) * gap,
    h: Math.max(...heights) - gap,
  };
}

// ---- line-aware arrangement ----
function lineList() {
  const d = diagram();
  const lines = [];
  for (const r of d.model.relations) lines.push([keyOf(r.fromTable), keyOf(r.toTable)]);
  for (const l of d.manualLinks) lines.push([l.from.table, l.to.table]);
  return lines.filter(([a, b]) => a !== b && !d.hidden.has(a) && !d.hidden.has(b));
}

function segmentHitsRect(ax, ay, bx, by, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const checks = [[-dx, ax - r.x], [dx, r.x + r.w - ax], [-dy, ay - r.y], [dy, r.y + r.h - ay]];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// Straight-line estimate of clutter for the current layout.
function lineStats() {
  const d = diagram();
  const known = tableMap();
  const frames = d.annotations.filter((a) => a.type === 'group');
  const center = (t) => [t.x + t.w / 2, t.y + t.h / 2];
  const frameOf = (t) => {
    const [x, y] = center(t);
    return frames.find((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
  };
  let length = 0;
  let overOtherGroups = 0;
  let betweenGroups = 0;
  const lines = lineList();
  for (const [a, b] of lines) {
    const ta = known.get(a);
    const tb = known.get(b);
    if (!ta || !tb || !Number.isFinite(ta.x) || !Number.isFinite(tb.x)) continue;
    const [ax, ay] = center(ta);
    const [bx, by] = center(tb);
    length += Math.hypot(bx - ax, by - ay);
    const fa = frameOf(ta);
    const fb = frameOf(tb);
    if (fa !== fb) betweenGroups++;
    if (frames.some((f) => f !== fa && f !== fb && segmentHitsRect(ax, ay, bx, by, f))) overOtherGroups++;
  }
  return { lines: lines.length, between_groups: betweenGroups, total_length: Math.round(length), lines_over_other_groups: overOtherGroups };
}

function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function anneal(items, cost, iterations, random) {
  let current = cost(items);
  let best = current;
  let bestItems = [...items];
  const startHeat = Math.max(1, current * 0.02);
  for (let i = 0; i < iterations; i++) {
    const a = Math.floor(random() * items.length);
    const b = Math.floor(random() * items.length);
    if (a === b) continue;
    [items[a], items[b]] = [items[b], items[a]];
    const next = cost(items);
    const heat = startHeat * (1 - i / iterations) + 1e-6;
    if (next <= current || random() < Math.exp((current - next) / heat)) {
      current = next;
      if (next < best) {
        best = next;
        bestItems = [...items];
      }
    } else {
      [items[a], items[b]] = [items[b], items[a]];
    }
  }
  items.splice(0, items.length, ...bestItems);
  return best;
}

// Chooses box order and the table order inside each box to shorten the lines.
// Rows are centred so the busiest boxes can sit in the middle.
function optimizeBoxes(boxes, { gap, padding, header, groupGap, keepOnEdge }) {
  const random = seededRandom(20261110);
  const boxOf = new Map();
  boxes.forEach((box) => box.tables.forEach((t) => boxOf.set(t.key, box)));
  const lines = lineList().filter(([a, b]) => boxOf.has(a) && boxOf.has(b));
  const offsets = new Map();

  const repack = (box) => {
    box.pack = packGroup(box.order, gap);
    box.w = box.pack.w + padding * 2;
    box.h = box.pack.h + padding + header;
    for (const p of box.pack.placed) {
      offsets.set(p.table.key, [padding + p.x + p.table.w / 2, header + p.y + p.table.h / 2]);
    }
  };
  boxes.forEach((box) => {
    box.order = [...box.tables].sort((a, b) => a.key.localeCompare(b.key));
    repack(box);
  });

  const place = (order, rowWidth) => {
    const rows = [[]];
    let used = 0;
    for (const box of order) {
      if (used > 0 && used + box.w > rowWidth) {
        rows.push([]);
        used = 0;
      }
      rows.at(-1).push(box);
      used += box.w + groupGap;
    }
    const widest = Math.max(...rows.map((row) => row.reduce((s, b) => s + b.w + groupGap, -groupGap)));
    let y = 0;
    rows.forEach((row, index) => {
      const width = row.reduce((s, b) => s + b.w + groupGap, -groupGap);
      let x = (widest - width) / 2;
      for (const box of row) {
        box.x = x;
        box.y = y;
        box.row = index;
        x += box.w + groupGap;
      }
      y += Math.max(...row.map((b) => b.h)) + groupGap;
    });
    return rows.length;
  };

  const lineCost = (subset = lines) => {
    let total = 0;
    for (const [a, b] of subset) {
      const boxA = boxOf.get(a);
      const boxB = boxOf.get(b);
      const oa = offsets.get(a);
      const ob = offsets.get(b);
      total += Math.hypot(boxA.x + oa[0] - boxB.x - ob[0], boxA.y + oa[1] - boxB.y - ob[1]);
    }
    return total;
  };

  const arrangeBoxes = () => {
    const area = boxes.reduce((s, b) => s + (b.w + groupGap) * (b.h + groupGap), 0);
    const minWidth = Math.max(...boxes.map((b) => b.w));
    let bestOrder = null;
    let bestWidth = 0;
    let bestCost = Infinity;
    for (const aspect of [1, 1.4, 1.9]) {
      const rowWidth = Math.max(minWidth, Math.sqrt(area * aspect));
      const order = bestOrder ? [...bestOrder] : [...boxes];
      const cost = (items) => {
        const rowCount = place(items, rowWidth);
        const offEdge = items.filter((b) => keepOnEdge.has(b.name) && b.row !== 0 && b.row !== rowCount - 1).length;
        return lineCost() + offEdge * 1e9;
      };
      const result = anneal(order, cost, 12000, random);
      if (result < bestCost) {
        bestCost = result;
        bestOrder = [...order];
        bestWidth = rowWidth;
      }
    }
    place(bestOrder, bestWidth);
    return { order: bestOrder, width: bestWidth };
  };

  let arrangement = arrangeBoxes();
  for (let round = 0; round < 2; round++) {
    for (const box of boxes) {
      if (box.order.length < 2) continue;
      const touching = lines.filter(([a, b]) => boxOf.get(a) === box || boxOf.get(b) === box);
      anneal(box.order, () => {
        repack(box);
        return lineCost(touching);
      }, 150 * box.order.length, random);
      repack(box);
    }
    arrangement = arrangeBoxes();
  }
  place(arrangement.order, arrangement.width);
}

// Re-spaces tables and boxes while keeping the current columns, table order
// and box order.
function respaceBoxes(boxes, { gap, padding, header, groupGap, labelSpace }) {
  const frames = diagram().annotations.filter((a) => a.type === 'group');
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  for (const box of boxes) {
    box.frame = frames.find((f) => f.text === box.name);
    if (!box.frame) throw new Error(`There is no group box named "${box.name}" to keep.`);

    const sorted = [...box.tables].sort((a, b) => a.x - b.x);
    const columns = [];
    for (const t of sorted) {
      const last = columns.at(-1);
      if (last && Math.abs(t.x - last.x) <= 10) last.tables.push(t);
      else columns.push({ x: t.x, tables: [t] });
    }
    const columnWidth = Math.max(...box.tables.map((t) => t.w));
    const placed = [];
    let tallest = 0;
    columns.forEach((column, index) => {
      let y = 0;
      for (const t of column.tables.sort((a, b) => a.y - b.y)) {
        placed.push({ table: t, x: index * (columnWidth + gap), y });
        y += t.h + gap;
      }
      tallest = Math.max(tallest, y - gap);
    });
    box.pack = { placed };
    const contentWidth = columns.length * columnWidth + (columns.length - 1) * gap;
    box.w = contentWidth + padding * 2;
    box.h = tallest + padding + header;
    if (labelSpace) {
      // Names keep their on-screen size, so they are largest at minimum zoom.
      const labelWidth = (measure.measureText(box.name).width + 20) / MIN_ZOOM;
      box.w = Math.max(box.w, Math.ceil(labelWidth));
    }
    box.inset = (box.w - contentWidth) / 2;
  }

  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.frame.y - b.frame.y)) {
    const row = rows.find((r) => Math.abs(r.y - box.frame.y) <= 10);
    if (row) row.boxes.push(box);
    else rows.push({ y: box.frame.y, boxes: [box] });
  }
  const rowWidth = (row) => row.boxes.reduce((sum, b) => sum + b.w + groupGap, -groupGap);
  const widest = Math.max(...rows.map(rowWidth));
  let y = 0;
  for (const row of rows) {
    let x = (widest - rowWidth(row)) / 2;
    for (const box of row.boxes.sort((a, b) => a.frame.x - b.frame.x)) {
      box.x = x;
      box.y = y;
      x += box.w + groupGap;
    }
    y += Math.max(...row.boxes.map((b) => b.h)) + groupGap;
  }
}

function organize({
  groups,
  ungrouped = 'group',
  optimize_lines = false,
  keep_on_edge = [],
  keep_arrangement = false,
  table_gap = 36,
  label_space = false,
}) {
  const d = diagram();
  const GAP = Math.max(16, Math.min(300, table_gap));
  const PADDING = Math.max(36, Math.round(GAP * 0.75));
  const HEADER = label_space ? LABEL_HEADER : 44;
  const GROUP_GAP = optimize_lines || keep_arrangement ? 220 : 80;
  const showStats = optimize_lines || keep_arrangement;
  const statsBefore = showStats ? lineStats() : null;

  const known = tableMap();
  const degree = degrees();
  const used = new Set();
  const unknown = [];
  const duplicates = [];

  const resolved = groups.map((group) => {
    const tables = [];
    for (const name of group.tables) {
      const key = keyOf(name);
      const t = known.get(key);
      if (!t) unknown.push(name);
      else if (used.has(key)) duplicates.push(name);
      else {
        used.add(key);
        if (!d.hidden.has(key)) tables.push(t);
      }
    }
    return { name: group.name, color: group.color, tables };
  });

  const rest = d.model.tables.filter((t) => !used.has(t.key) && !d.hidden.has(t.key));
  if (ungrouped === 'group' && rest.length) resolved.push({ name: 'Other', tables: rest });

  const boxes = resolved.filter((g) => g.tables.length).map((group, index) => {
    const ordered = [...group.tables].sort(
      (a, b) => (degree.get(b.key) || 0) - (degree.get(a.key) || 0) || a.key.localeCompare(b.key),
    );
    const pack = packGroup(ordered, GAP);
    return {
      ...group,
      color: GROUP_COLORS.includes(group.color) || /^#[0-9a-f]{6}$/i.test(group.color ?? '')
        ? group.color
        : GROUP_COLORS[index % GROUP_COLORS.length],
      pack,
      w: pack.w + PADDING * 2,
      h: pack.h + PADDING + HEADER,
    };
  });
  if (!boxes.length) throw new Error('None of the listed tables are visible in the diagram.');
  if (ungrouped === 'hide' && rest.length) d.setTablesHidden(rest.map((t) => t.key), true);

  if (keep_arrangement) {
    respaceBoxes(boxes, { gap: GAP, padding: PADDING, header: HEADER, groupGap: GROUP_GAP, labelSpace: label_space });
  } else if (optimize_lines) {
    optimizeBoxes(boxes, {
      gap: GAP,
      padding: PADDING,
      header: HEADER,
      groupGap: GROUP_GAP,
      keepOnEdge: new Set(keep_on_edge),
    });
  } else {
    const totalArea = boxes.reduce((sum, b) => sum + (b.w + GROUP_GAP) * (b.h + GROUP_GAP), 0);
    const rowWidth = Math.max(Math.sqrt(totalArea * 1.6), ...boxes.map((b) => b.w));
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const box of boxes) {
      if (x > 0 && x + box.w > rowWidth) {
        x = 0;
        y += rowHeight + GROUP_GAP;
        rowHeight = 0;
      }
      box.x = x;
      box.y = y;
      x += box.w + GROUP_GAP;
      rowHeight = Math.max(rowHeight, box.h);
    }
  }

  const stamp = Date.now().toString(36);
  const frames = boxes.map((box, index) => {
    for (const p of box.pack.placed) {
      p.table.x = box.x + (box.inset ?? PADDING) + p.x;
      p.table.y = box.y + HEADER + p.y;
    }
    return { id: `mcp-${stamp}-${index}`, type: 'group', x: box.x, y: box.y, w: box.w, h: box.h, text: box.name, color: box.color };
  });

  d.setAnnotations([...d.annotations.filter((a) => a.type !== 'group'), ...frames]);
  d.fit();
  changed();
  return {
    groups: boxes.map((b) => ({ name: b.name, tables: b.tables.length })),
    unknown_tables: unknown,
    listed_twice: duplicates,
    ...(showStats ? { line_stats_before: statsBefore, line_stats_after: lineStats() } : {}),
    ...summary(),
  };
}

function getDiagram({ tables, include_columns = false, include_sql = false }) {
  const d = diagram();
  let only = null;
  let unknown = [];
  if (tables?.length) {
    const found = resolveKeys(tables);
    only = new Set(found.keys);
    unknown = found.unknown;
  }
  const inScope = (from, to) => !only || only.has(from) || only.has(to);
  return {
    tables: d.model.tables.filter((t) => !only || only.has(t.key)).map((t) => ({
      name: t.name,
      key: t.key,
      x: Math.round(t.x),
      y: Math.round(t.y),
      w: Math.round(t.w),
      h: Math.round(t.h),
      hidden: d.hidden.has(t.key),
      column_count: t.columns.length,
      ...(include_columns
        ? { columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk, nn: c.nn, unique: c.unique, fk: c.fk })) }
        : {}),
    })),
    relations: d.model.relations
      .filter((r) => inScope(keyOf(r.fromTable), keyOf(r.toTable)))
      .map((r) => ({ from: r.fromTable, from_columns: r.fromCols, to: r.toTable, to_columns: r.toCols })),
    manual_links: d.manualLinks
      .filter((l) => inScope(l.from.table, l.to.table))
      .map((l) => ({ from_table: l.from.table, from_column: l.from.col, to_table: l.to.table, to_column: l.to.col })),
    annotations: d.annotations,
    unknown_tables: unknown,
    ...(include_sql ? { sql: sqlEl().value } : {}),
  };
}

function setVisibility({ action, tables = [] }) {
  const d = diagram();
  if (action === 'show_all') {
    d.setTablesHidden([...d.hidden], false);
    return summary();
  }
  const { keys, unknown } = resolveKeys(tables);
  if (action === 'hide') d.setTablesHidden(keys, true);
  if (action === 'show') d.setTablesHidden(keys, false);
  if (action === 'only') {
    const keep = new Set(keys);
    d.setTablesHidden(d.model.tables.filter((t) => keep.has(t.key)).map((t) => t.key), false);
    d.setTablesHidden(d.model.tables.filter((t) => !keep.has(t.key)).map((t) => t.key), true);
  }
  return { unknown_tables: unknown, ...summary() };
}

function columnExists(known, table, column) {
  return known.get(table)?.columns.some((c) => c.name === column);
}

function addLinks({ links }) {
  const d = diagram();
  const known = tableMap();
  const before = d.manualLinks.length;
  const rejected = [];
  for (const l of links) {
    const from = keyOf(l.from_table);
    const to = keyOf(l.to_table);
    if (!columnExists(known, from, l.from_column) || !columnExists(known, to, l.to_column)) {
      rejected.push(l);
      continue;
    }
    d.addManualLink(from, l.from_column, to, l.to_column);
  }
  changed();
  return { added: d.manualLinks.length - before, rejected, ...summary() };
}

function removeLinks({ links = [], all = false }) {
  const d = diagram();
  const before = d.manualLinks.length;
  if (all) {
    d.setManualLinks([]);
  } else {
    const remove = new Set(links.map((l) => `${keyOf(l.from_table)}.${l.from_column}>${keyOf(l.to_table)}.${l.to_column}`));
    d.setManualLinks(d.manualLinks.filter((l) => !remove.has(`${l.from.table}.${l.from.col}>${l.to.table}.${l.to.col}`)));
  }
  changed();
  return { removed: before - d.manualLinks.length, ...summary() };
}

function screenshot({ tables, max_size = 1800 }) {
  const d = diagram();
  const limit = Math.min(4000, Math.max(400, max_size));
  let rect = d.bounds();
  if (tables?.length) {
    const { keys, unknown } = resolveKeys(tables);
    const known = tableMap();
    const chosen = keys.map((k) => known.get(k)).filter((t) => Number.isFinite(t.x) && !d.hidden.has(t.key));
    if (!chosen.length) throw new Error(`No visible tables match: ${unknown.join(', ') || tables.join(', ')}`);
    const x0 = Math.min(...chosen.map((t) => t.x)) - 60;
    const y0 = Math.min(...chosen.map((t) => t.y)) - 60;
    const x1 = Math.max(...chosen.map((t) => t.x + t.w)) + 60;
    const y1 = Math.max(...chosen.map((t) => t.y + t.h)) + 60;
    rect = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }
  if (!rect.w) throw new Error('The diagram is empty.');

  const scale = Math.min(2, limit / Math.max(rect.w, rect.h));
  d.bounds = () => rect; // exportPNG reads its area from bounds()
  try {
    const dataUrl = d.exportPNG(scale);
    return { dataUrl, width: Math.ceil(rect.w * scale), height: Math.ceil(rect.h * scale), scale: +scale.toFixed(3) };
  } finally {
    delete d.bounds;
  }
}

const OPS = {
  status: () => summary(),
  get: getDiagram,
  project: currentProject,
  load: ({ project }) => loadProject(project),
  load_sql: ({ sql, dialect }) => {
    const { positions, annotations, hidden, manualLinks, edgeBends, edgeAnchors, edgePaths } = currentProject();
    return loadProject({
      app: 'dbdiga',
      version: 1,
      sql,
      dialect: dialect ?? localStorage.getItem('dbdiga-dialect') ?? undefined,
      positions,
      annotations,
      hidden,
      manualLinks,
      edgeBends,
      edgeAnchors,
      edgePaths,
    });
  },
  auto_arrange: ({ direction = 'LR', spacing = 'comfortable' }) => {
    const d = diagram();
    layout(d.model, { dir: direction, spacing }, d.hidden);
    d.fit();
    changed();
    return summary();
  },
  organize,
  arrange_lines: () => ({ ...diagram().arrangeAllLines(), ...summary() }),
  arrange_lines_straight: async () => ({ ...(await diagram().arrangeLinesStraight()), ...summary() }),
  move: ({ positions }) => {
    const known = tableMap();
    const unknown = [];
    let moved = 0;
    for (const p of positions) {
      const t = known.get(keyOf(p.table));
      if (!t) unknown.push(p.table);
      else {
        t.x = p.x;
        t.y = p.y;
        moved++;
      }
    }
    changed();
    return { moved, unknown_tables: unknown };
  },
  visibility: setVisibility,
  add_links: addLinks,
  remove_links: removeLinks,
  annotations: ({ annotations }) => {
    const d = diagram();
    const stamp = Date.now().toString(36);
    d.setAnnotations(annotations.map((a, i) => ({
      text: '',
      color: a.type === 'group' ? 'blue' : 'yellow',
      ...a,
      id: a.id ?? `mcp-${stamp}-${i}`,
    })));
    changed();
    return summary();
  },
  view: ({ fit, center_table }) => {
    const d = diagram();
    if (center_table) {
      const key = keyOf(center_table);
      if (!tableMap().has(key)) throw new Error(`Unknown table: ${center_table}`);
      d.centerOn(key);
    } else if (fit !== false) {
      d.fit();
    }
    return { camera: d.cam };
  },
  screenshot,
};

async function run({ id, op, args }) {
  let body;
  try {
    if (!OPS[op]) throw new Error(`Unknown command: ${op}`);
    body = { id, ok: true, result: await OPS[op](args) };
  } catch (err) {
    body = { id, ok: false, error: err.message };
  }
  await fetch(`${BRIDGE_URL}/result`, { method: 'POST', body: JSON.stringify(body) });
}

let source = null;
let retryTimer = null;

// Reconnects quietly, since the MCP server only runs while Claude is connected.
function connect(retryMs = 3000) {
  clearTimeout(retryTimer);
  source?.close();
  const current = new EventSource(`${BRIDGE_URL}/events`);
  source = current;
  let opened = false;
  current.onopen = () => { opened = true; };
  current.onmessage = (event) => run(JSON.parse(event.data));
  current.onerror = () => {
    current.close();
    if (source !== current) return;
    const next = opened ? 3000 : Math.min(retryMs * 2, 30_000);
    retryTimer = setTimeout(() => connect(next), next);
  };
}

async function start() {
  if (new URLSearchParams(location.search).has('embed')) return;
  while (!window.__dbdiga) await delay(50);
  connect();
  // The server talks to the newest connection, so the window used last wins,
  // even when the diagram is open in more than one tab or browser.
  window.addEventListener('focus', () => connect());
}

start();
