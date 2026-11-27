// Simple annotation layer: group boxes (labelled frames to cluster sections)
// and sticky notes (free text). Colours are fixed so they read on both themes.

export const NOTE_COLORS = {
  yellow: { fill: '#ffe49c', text: '#3a3320' },
  blue:   { fill: '#bcd9ff', text: '#1f2f45' },
  green:  { fill: '#c4f0d0', text: '#1d3a28' },
  pink:   { fill: '#ffc9d8', text: '#46202e' },
};

export const GROUP_COLORS = {
  blue:   '#5aa7ff',
  green:  '#4ec9b0',
  amber:  '#f5b14a',
  purple: '#b488ff',
};

export const NOTE_ORDER = ['yellow', 'blue', 'green', 'pink'];

// A sticky note's text is in world units, so a note zooms like a table: at
// 100% it is 13 px text on 17 px lines, 10 px in from the edge.
export const NOTE_FONT = 13, NOTE_LINE = 17, NOTE_PAD = 10;
export const NOTE_FONT_CSS = `${NOTE_FONT}px ui-sans-serif, system-ui, sans-serif`;
const NOTE_MIN_TEXT_PX = 4;    // on screen, smaller text is drawn as faint bars

// Where each line of a note's text goes (world units): [{ text, x, y, w }],
// y being the top of the line. lines: the text already wrapped to the note's
// width less the padding, as [{ text, w }]. Lines that would start below the
// bottom padding are left out, as the note clips them.
export function noteTextLayout(note, lines) {
  const out = [];
  let y = note.y + NOTE_PAD;
  for (const { text, w } of lines) {
    out.push({ text, x: note.x + NOTE_PAD, y, w });
    y += NOTE_LINE;
    if (y > note.y + note.h - NOTE_PAD) break;
  }
  return out;
}

// Whether a note's text is too small to read at this zoom (drawn as bars).
export const noteTextAsBars = (scale) => NOTE_FONT * scale < NOTE_MIN_TEXT_PX;
export const GROUP_ORDER = ['blue', 'green', 'amber', 'purple'];

// A group can also use any colour, stored as a hex code like "#e05a9b".
export const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export function groupColor(color) {
  if (GROUP_COLORS[color]) return GROUP_COLORS[color];
  return isHexColor(color) ? color.toLowerCase() : GROUP_COLORS.blue;
}

let seq = 0;
function newId() {
  seq += 1;
  return 'a' + Date.now().toString(36) + '-' + seq.toString(36);
}

export function makeAnnotation(type, x, y) {
  if (type === 'group') {
    return { id: newId(), type: 'group', x: x - 160, y: y - 120, w: 320, h: 240, text: 'Group', color: 'blue' };
  }
  return { id: newId(), type: 'note', x: x - 90, y: y - 60, w: 180, h: 120, text: '', color: 'yellow' };
}

// tolerant normaliser for loaded/shared annotations
export function sanitizeAnnotations(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const a of arr) {
    if (!a || (a.type !== 'group' && a.type !== 'note')) continue;
    if (![a.x, a.y, a.w, a.h].every(Number.isFinite)) continue;
    const colors = a.type === 'group' ? GROUP_COLORS : NOTE_COLORS;
    const customGroupColor = a.type === 'group' && isHexColor(a.color);
    out.push({
      id: typeof a.id === 'string' ? a.id : newId(),
      type: a.type,
      x: a.x, y: a.y,
      w: Math.max(80, a.w), h: Math.max(50, a.h),
      text: typeof a.text === 'string' ? a.text : '',
      color: colors[a.color] ? a.color
        : customGroupColor ? a.color.toLowerCase()
          : (a.type === 'group' ? 'blue' : 'yellow'),
    });
  }
  return out;
}
