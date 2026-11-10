#!/usr/bin/env node
// MCP server (stdio) that drives the diagram open at http://localhost:5173.
// The page connects back through mcp/bridge.js: commands go out over SSE and
// results return by POST, on 127.0.0.1 only, from the dev server's origin only.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PORT = 5199;
const APP_URL = 'http://localhost:5173';
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 60 * 1024 * 1024;

// ---- bridge to the browser tab ----
const clients = new Set();
const pending = new Map();
let nextCommandId = 1;
let bridgeError = null;

function currentClient() {
  return [...clients].at(-1) ?? null;
}

function originAllowed(req) {
  return ALLOWED_ORIGINS.has(req.headers.origin) && ALLOWED_HOSTS.has(req.headers.host);
}

const httpServer = http.createServer((req, res) => {
  if (!originAllowed(req)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/result') {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      res.writeHead(204).end();
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || 'The diagram reported an error.'));
    });
    return;
  }

  res.writeHead(404).end();
});

httpServer.on('error', (err) => {
  bridgeError = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is in use, probably by another Claude session using this MCP server. Close that session and reconnect.`
    : `The bridge could not start: ${err.message}`;
});
httpServer.listen(PORT, '127.0.0.1');

function send(op, args = {}) {
  if (bridgeError) return Promise.reject(new Error(bridgeError));
  const client = currentClient();
  if (!client) {
    return Promise.reject(new Error(`No diagram tab is connected. Open ${APP_URL} in the browser and try again.`));
  }
  const id = nextCommandId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The diagram did not answer "${op}" in time. Check that the tab is still open.`));
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    client.write(`data: ${JSON.stringify({ id, op, args })}\n\n`);
  });
}

// ---- tools ----
const tableList = { type: 'array', items: { type: 'string' } };
const groupColor = { type: 'string', description: 'blue, green, amber, purple, or any hex colour such as #e05a9b' };
const link = {
  type: 'object',
  properties: {
    from_table: { type: 'string' },
    from_column: { type: 'string' },
    to_table: { type: 'string' },
    to_column: { type: 'string' },
  },
  required: ['from_table', 'from_column', 'to_table', 'to_column'],
};

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

async function jsonPath(path) {
  const full = resolve(path);
  if (!full.toLowerCase().endsWith('.json')) throw new Error('The project path must end in .json.');
  return full;
}

const TOOLS = [
  {
    name: 'diagram_status',
    description: 'Report whether a browser tab is connected and summarise the open diagram.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (bridgeError || !currentClient()) {
        return asText({ connected: false, reason: bridgeError ?? `Open ${APP_URL} in the browser.` });
      }
      return asText({ connected: true, ...(await send('status')) });
    },
  },
  {
    name: 'diagram_get',
    description: 'Read the diagram: tables with positions and sizes, foreign-key relations, dashed manual links and annotations. Use the options to add columns or the SQL, or to narrow it to some tables.',
    inputSchema: {
      type: 'object',
      properties: {
        tables: { ...tableList, description: 'Only these tables, and relations touching them.' },
        include_columns: { type: 'boolean', default: false },
        include_sql: { type: 'boolean', default: false },
      },
    },
    handler: async (args) => asText(await send('get', args)),
  },
  {
    name: 'diagram_load_project',
    description: 'Open a saved project (.json) in the diagram, replacing what is open.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async ({ path }) => {
      const project = JSON.parse(await readFile(await jsonPath(path), 'utf8'));
      if (typeof project.sql !== 'string') throw new Error('That file is not a diagram project: it has no "sql" text.');
      return asText(await send('load', { project }));
    },
  },
  {
    name: 'diagram_load_sql',
    description: 'Draw or change the schema from SQL (CREATE TABLE statements with foreign keys). Tables that keep their name keep their position; new ones are placed beside them.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        dialect: { type: 'string', enum: ['postgres', 'mysql', 'sqlite', 'sqlserver', 'snowflake'] },
      },
      required: ['sql'],
    },
    handler: async (args) => asText(await send('load_sql', args)),
  },
  {
    name: 'diagram_save_project',
    description: 'Save the diagram with its layout, groups, hidden tables and manual links to a .json project file. Overwrites an existing file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async ({ path }) => {
      const full = await jsonPath(path);
      const project = await send('project');
      await writeFile(full, JSON.stringify(project, null, 2));
      return asText({ saved: full, tables: Object.keys(project.positions).length });
    },
  },
  {
    name: 'diagram_auto_arrange',
    description: "Lay out the visible tables with the app's automatic graph layout. This does not use groups.",
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['LR', 'TB'], default: 'LR' },
        spacing: { type: 'string', enum: ['compact', 'comfortable', 'spacious'], default: 'comfortable' },
      },
    },
    handler: async (args) => asText(await send('auto_arrange', args)),
  },
  {
    name: 'diagram_organize_groups',
    description: 'Organize tables into labelled group boxes, for example by business domain. Tables are packed inside each box with the most connected first; boxes follow the order given, left to right then down. Replaces existing group boxes and keeps sticky notes.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, color: groupColor, tables: tableList },
            required: ['name', 'tables'],
          },
        },
        ungrouped: {
          type: 'string',
          enum: ['group', 'hide', 'leave'],
          default: 'group',
          description: 'Tables not listed: put them in an "Other" box, hide them, or leave them where they are.',
        },
        optimize_lines: {
          type: 'boolean',
          default: false,
          description: 'Choose the box order and table order that shorten the relation lines, and report line statistics before and after.',
        },
        keep_on_edge: {
          ...tableList,
          description: 'With optimize_lines: group names that must sit in the first or last row.',
        },
        keep_arrangement: {
          type: 'boolean',
          default: false,
          description: 'Keep the current columns, table order and box order, and only change the spacing.',
        },
        table_gap: {
          type: 'number',
          default: 36,
          description: 'Space between tables, 16 to 300.',
        },
        label_space: {
          type: 'boolean',
          default: false,
          description: 'With keep_arrangement: size each box so its name stays clear of the tables and is not cut off at minimum zoom.',
        },
      },
      required: ['groups'],
    },
    handler: async (args) => asText(await send('organize', args)),
  },
  {
    name: 'diagram_arrange_lines',
    description: 'Arrange the relation lines: choose each line\'s sides, entry points and bend so lines avoid other tables, cross less and never share an entry point. Lines placed or bent by hand keep that. Same as Arrange > Arrange lines in the app.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => asText(await send('arrange_lines')),
  },
  {
    name: 'diagram_arrange_lines_straight',
    description: 'Arrange the relation lines as straight horizontal and vertical segments that go around tables, never share a segment or an entry point, and jump where they cross. Same as Arrange > Arrange lines straight in the app.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => asText(await send('arrange_lines_straight')),
  },
  {
    name: 'diagram_move_tables',
    description: 'Move tables to exact positions in diagram coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        positions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { table: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
            required: ['table', 'x', 'y'],
          },
        },
      },
      required: ['positions'],
    },
    handler: async (args) => asText(await send('move', args)),
  },
  {
    name: 'diagram_set_visibility',
    description: 'Hide or show tables. "only" shows just the listed tables and hides the rest; "show_all" shows everything.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['hide', 'show', 'only', 'show_all'] },
        tables: tableList,
      },
      required: ['action'],
    },
    handler: async (args) => asText(await send('visibility', args)),
  },
  {
    name: 'diagram_add_links',
    description: 'Draw dashed manual links, for relations the database does not enforce with a foreign key.',
    inputSchema: { type: 'object', properties: { links: { type: 'array', items: link } }, required: ['links'] },
    handler: async (args) => asText(await send('add_links', args)),
  },
  {
    name: 'diagram_remove_links',
    description: 'Remove dashed manual links. Pass all: true to remove every one. Foreign keys come from the SQL and are not affected.',
    inputSchema: {
      type: 'object',
      properties: { links: { type: 'array', items: link }, all: { type: 'boolean' } },
    },
    handler: async (args) => asText(await send('remove_links', args)),
  },
  {
    name: 'diagram_set_annotations',
    description: 'Replace all group boxes and sticky notes. Read the current ones with diagram_get first to keep them.',
    inputSchema: {
      type: 'object',
      properties: {
        annotations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['group', 'note'] },
              text: { type: 'string' },
              color: { type: 'string', description: 'Groups: blue, green, amber, purple or a hex colour. Notes: yellow, blue, green or pink.' },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            required: ['type', 'x', 'y', 'w', 'h'],
          },
        },
      },
      required: ['annotations'],
    },
    handler: async (args) => asText(await send('annotations', args)),
  },
  {
    name: 'diagram_view',
    description: "Move the user's view: fit everything, or center on and highlight one table.",
    inputSchema: {
      type: 'object',
      properties: { fit: { type: 'boolean' }, center_table: { type: 'string' } },
    },
    handler: async (args) => asText(await send('view', args)),
  },
  {
    name: 'diagram_screenshot',
    description: 'Return a PNG of the diagram so the layout can be checked. Pass tables to capture just that area at readable size.',
    inputSchema: {
      type: 'object',
      properties: {
        tables: { ...tableList, description: 'Capture only the area around these tables.' },
        max_size: { type: 'number', default: 1800, description: 'Longest image side in pixels, 400 to 4000.' },
      },
    },
    handler: async (args) => {
      const shot = await send('screenshot', args);
      const data = shot.dataUrl.replace(/^data:image\/png;base64,/, '');
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: `${shot.width}x${shot.height} px at ${shot.scale}x` },
        ],
      };
    },
  },
];

// ---- MCP over stdio (newline-delimited JSON-RPC) ----
function reply(id, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notification

  if (method === 'initialize') {
    reply(id, {
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sql-to-erd', version: '0.1.0' },
      },
    });
  } else if (method === 'ping') {
    reply(id, { result: {} });
  } else if (method === 'tools/list') {
    reply(id, {
      result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
    });
  } else if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) {
      reply(id, { error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return;
    }
    try {
      reply(id, { result: await tool.handler(params.arguments ?? {}) });
    } catch (err) {
      reply(id, { result: { isError: true, content: [{ type: 'text', text: err.message }] } });
    }
  } else {
    reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    handle(message).catch((err) => {
      if (message.id !== undefined) reply(message.id, { error: { code: -32603, message: err.message } });
    });
  }
});
process.stdin.on('end', () => process.exit(0));
