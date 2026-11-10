// Build a standalone SVG string of the current diagram (vector, theme-aware).
import { THEMES, columnY, ROW_H, HEADER_H } from './renderer.js';
import { NOTE_COLORS, groupColor } from './annotations.js';
import { relationCardinality } from './cardinality.js';
import { routeEdges } from './edge-routing.js';
import { pathFits, pathJumps, JUMP_RADIUS } from './orthogonal-router.js';

// Crow's-foot cardinality marker at a line endpoint (world coords).
//   dir = +1 if the line extends in +x from (x,y), else -1.
function svgMarker(x, y, dir, kind, color) {
  const foot = 11, spread = 5.5, r = 3.2;
  const attr = `fill="none" stroke="${color}" stroke-width="1.5"`;
  const many = kind === 'many' || kind === 'zero-or-many';
  const optional = kind === 'zero-or-one' || kind === 'zero-or-many';
  let out = '';
  if (many) {
    const ax = x + dir * foot;
    out += `<path d="M ${ax} ${y} L ${x} ${y - spread} M ${ax} ${y} L ${x} ${y + spread} M ${ax} ${y} L ${x} ${y}" ${attr}/>`;
  } else {
    const bx = x + dir * foot;
    out += `<path d="M ${bx} ${y - spread} L ${bx} ${y + spread}" ${attr}/>`;
  }
  if (optional) {
    const cx = x + dir * (foot + r + 2);
    out += `<circle cx="${cx}" cy="${y}" r="${r}" ${attr}/>`;
  }
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// A straight path as SVG; a jump is a semicircle over the line it crosses.
function svgPath(points, jumps = []) {
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1], [x2, y2] = points[i];
    if (y1 === y2) {
      const dir = Math.sign(x2 - x1);
      const here = jumps.filter(([seg]) => seg === i).map(([, x]) => x).sort((a, b) => (a - b) * dir);
      for (const x of here) {
        d += ` L ${x - dir * JUMP_RADIUS} ${y1} A ${JUMP_RADIUS} ${JUMP_RADIUS} 0 0 ${dir > 0 ? 1 : 0} ${x + dir * JUMP_RADIUS} ${y1}`;
      }
    }
    d += ` L ${x2} ${y2}`;
  }
  return d;
}

export function exportSVG(model, themeName, annotations = [], hidden = null, edgeBends = {}, edgeAnchors = {}, edgePaths = {}) {
  const theme = THEMES[themeName] || THEMES.dark;
  const isHidden = (k) => !!(hidden && hidden.has(k));
  const ts = model.tables.filter(t => Number.isFinite(t.x) && !isHidden(t.key));
  if (!ts.length && !annotations.length) return null;

  const pad = 40;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of ts) {
    x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
  }
  for (const a of annotations) {
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.w); y1 = Math.max(y1, a.y + a.h);
  }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const W = x1 - x0, H = y1 - y0;

  const byKey = new Map(model.tables.map(t => [t.key, t]));
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="${x0} ${y0} ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">`);
  parts.push(`<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="${theme.bg}"/>`);

  // group boxes (behind everything)
  for (const a of annotations) {
    if (a.type !== 'group') continue;
    const color = groupColor(a.color);
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="12" fill="${hexA(color, 0.08)}" stroke="${hexA(color, 0.7)}" stroke-width="1.5"/>`);
    if (a.text) parts.push(`<text x="${a.x + 10}" y="${a.y + 16}" dominant-baseline="middle" font-weight="600" font-size="13" fill="${color}">${esc(a.text)}</text>`);
  }

  // edges
  const edges = model.relations.map((r) => ({
    fromKey: r.fromTable.toLowerCase(), toKey: r.toTable.toLowerCase(),
    fromCol: r.fromCols[0], toCol: r.toCols[0],
    card: relationCardinality(r, byKey),
  }));
  const routed = routeEdges(edges, byKey, isHidden, edgeBends, edgeAnchors);
  // straight paths (Arrange lines straight) replace curves while they fit
  const facing = { right: 1, bottom: 1, left: -1, top: -1 };
  for (const seg of routed) {
    const path = edgePaths[seg.id];
    if (!path || !pathFits(path, byKey.get(seg.fromKey), byKey.get(seg.toKey))) continue;
    const first = path.points[0], last = path.points[path.points.length - 1];
    Object.assign(seg, {
      path: path.points, fx: first[0], fy: first[1], tx: last[0], ty: last[1],
      fromDir: facing[path.fromSide], toDir: facing[path.toSide],
      fromVertical: path.fromSide === 'top' || path.fromSide === 'bottom',
      toVertical: path.toSide === 'top' || path.toSide === 'bottom',
    });
  }
  const jumps = pathJumps(routed.filter((s) => s.path).map((s) => ({ id: s.id, points: s.path })), JUMP_RADIUS + 1);
  for (const seg of routed) {
    const { fx, fy, tx, ty, c1x, c1y, c2x, c2y, card, fromDir, toDir, fromVertical, toVertical } = seg;
    const d = seg.path ? svgPath(seg.path, jumps[seg.id]) : `M ${fx} ${fy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
    parts.push(`<path d="${d}" fill="none" stroke="${theme.edge}" stroke-width="1.5"/>`);
    const marker = (x, y, dir, kind, vertical) => {
      const drawn = svgMarker(x, y, dir, kind, theme.edge);
      return vertical ? `<g transform="rotate(90 ${x} ${y})">${drawn}</g>` : drawn;
    };
    parts.push(marker(fx, fy, fromDir, card.from, fromVertical));
    parts.push(marker(tx, ty, toDir, card.to, toVertical));
  }

  // tables
  for (const t of ts) {
    const g = [];
    g.push(`<g transform="translate(${t.x} ${t.y})">`);
    g.push(`<rect x="0" y="0" width="${t.w}" height="${t.h}" rx="10" fill="${theme.tableBg}" stroke="${theme.tableBorder}"/>`);
    // header
    g.push(`<path d="M0 ${HEADER_H} V10 a10 10 0 0 1 10 -10 H${t.w - 10} a10 10 0 0 1 10 10 V${HEADER_H} Z" fill="${theme.header}"/>`);
    g.push(`<line x1="0" y1="${HEADER_H}" x2="${t.w}" y2="${HEADER_H}" stroke="${theme.divider}"/>`);
    g.push(`<text x="12" y="${HEADER_H / 2}" dominant-baseline="middle" font-weight="600" font-size="14" fill="${theme.headerText}">${esc(t.name)}</text>`);

    for (let i = 0; i < t.columns.length; i++) {
      const c = t.columns[i];
      const y = HEADER_H + i * ROW_H;
      if (i % 2 === 1) g.push(`<rect x="1" y="${y}" width="${t.w - 2}" height="${ROW_H}" fill="${theme.rowAlt}"/>`);
      const cy = y + ROW_H / 2;
      if (c.pk) g.push(`<text x="10" y="${cy}" dominant-baseline="middle" font-size="9" font-weight="700" fill="${theme.pk}">PK</text>`);
      else if (c.fk) g.push(`<text x="10" y="${cy}" dominant-baseline="middle" font-size="9" font-weight="700" fill="${theme.fk}">FK</text>`);
      g.push(`<text x="38" y="${cy}" dominant-baseline="middle" font-size="13" font-family="ui-monospace, Menlo, monospace" fill="${theme.rowText}">${esc(c.name)}</text>`);
      if (c.type) g.push(`<text x="${t.w - 12}" y="${cy}" dominant-baseline="middle" text-anchor="end" font-size="12" font-family="ui-monospace, Menlo, monospace" fill="${theme.typeText}">${esc(c.type)}</text>`);
    }
    g.push('</g>');
    parts.push(g.join(''));
  }

  // sticky notes (front)
  for (const a of annotations) {
    if (a.type !== 'note') continue;
    const c = NOTE_COLORS[a.color] || NOTE_COLORS.yellow;
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="8" fill="${c.fill}"/>`);
    if (a.text) {
      const pad = 10, lh = 17, maxChars = Math.max(4, Math.floor((a.w - pad * 2) / 7));
      const lines = wrap(a.text, maxChars);
      const tspans = lines.map((ln, i) =>
        `<tspan x="${a.x + pad}" y="${a.y + pad + 12 + i * lh}">${esc(ln)}</tspan>`).join('');
      parts.push(`<text font-size="13" fill="${c.text}">${tspans}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// rough word-wrap by character budget (SVG has no auto-wrap)
function wrap(text, maxChars) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars && line) { out.push(line); line = word; }
      else line = (line ? line + ' ' : '') + word;
    }
    out.push(line);
  }
  return out;
}
