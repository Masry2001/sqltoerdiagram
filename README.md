# SQL to ER Diagram

**A free, open-source online ERD generator.** Paste a SQL schema (`CREATE TABLE`
statements) → get a clean, interactive entity-relationship diagram.

![deps](https://img.shields.io/badge/deps-2-blue) ![bundle](https://img.shields.io/badge/bundle-32KB%20gzip-brightgreen) [![Installer](https://github.com/Masry2001/sqltoerdiagram/actions/workflows/installer.yml/badge.svg)](https://github.com/Masry2001/sqltoerdiagram/actions/workflows/installer.yml)

**100% local · no signup · no upload.** It runs entirely in your browser, so your
schema never leaves your machine — no server, no backend. Live at
**[sqltoerdiagram.com](https://sqltoerdiagram.com)**.

## Quick start with an AI agent

One command installs the app and connects it to every AI agent on your machine
(Claude Code, Cursor, Codex, VS Code, Gemini CLI, OpenCode, Windsurf, Kiro,
Claude Desktop):

```bash
# Linux / macOS / Git Bash
curl -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs | node -
```

```powershell
# Windows PowerShell
curl.exe -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs | node -
```

Then restart your agent and ask it: *"Draw an ER diagram from schema.sql"*.
Details are in [MCP](#mcp) below.

## What this fork adds

- **Arrange ▾ → Arrange lines straight**: every relation becomes a right-angle line
  that goes around tables, each line enters its table at its own point, lines keep
  to their own lanes where there's room, and crossings are drawn as small
  semicircle jumps. It runs in the background, so the page stays responsive.
- **Arrange ▾ → Arrange lines**: the curved version. It spreads entry points so no
  two lines share one, and picks paths that avoid tables and crossings.
- **Lines you can edit**: click a line to pin it (everything else dims), drag its
  middle to bend it, drag either end to move where it enters or leaves a table.
  Press **Delete** to remove a pinned manual link. A table's right-click menu lists
  its manual links, so each one can be removed on its own.
- **Groups**: the group name is always drawn on top. A group moves only when you
  drag its name, and its tables move with it. The fifth colour dot opens a picker
  for any hex colour.
- **My diagrams**: keep several diagrams in the browser. The button next to the
  logo shows the open diagram's name; its menu lists your diagrams (click one to
  open it, ✕ to delete it) and has **New diagram**, **Rename…** (or double-click
  the name) and **Duplicate**. **File → Open project…** opens a file as a new
  diagram, and a shared link opens as its own diagram. Each diagram has its own
  undo history. (The store comes from the upstream project.)
- **Straight lines stay straight**: after **Arrange lines straight**, moving a
  table, a group or a line end re-routes only the lines that need it.
- **Search**: **Ctrl + F** finds tables and fields and jumps to them.
- **Undo / redo**: **Ctrl + Z**, **Ctrl + Y** (or **Ctrl + Shift + Z**). Arrange
  asks before re-arranging tables that are in groups.
- **MCP server** so an AI assistant such as Claude Code can drive the open
  diagram (see [MCP](#mcp) below).

## Why

Every other SQL-diagram tool is either paywalled, ugly, or slow. SQL to ER Diagram is
a single static page that stays smooth at **hundreds of tables**, edits your SQL
two-way, and shares a whole diagram in a single link — with no account and nothing
leaving your browser.

## Features

### Parse

- Standard `CREATE TABLE` / `ALTER TABLE` DDL across **PostgreSQL, MySQL, SQLite,
  SQL Server & Snowflake**.

### Visualize & navigate

- **Canvas renderer** with cached bitmaps + viewport culling — smooth at hundreds of
  tables (benchmarked **~120fps** while zooming 300 tables / 593 FKs).
- **Declutter dense schemas**: FK lines are soft by default; **hover** a table to
  highlight just its relationships, **click** to pin focus (fades every unrelated
  table and line), click empty space to clear.
- **Drag** tables, **scroll / pinch to zoom**, and pan.

### Smart layout

- **Hub-aware layered auto-arrange**: the most-connected table is placed on one side
  with its related tables aligned beside it. **Horizontal / Vertical** direction and
  **Compact / Comfortable / Spacious** spacing live under the **Arrange ▾** menu.
- **Overlap-free**: auto-arrange runs a separation pass so no two tables overlap.
- **Your arrangement is saved**: positions and the camera persist automatically, so
  reloading restores your exact layout. Editing SQL keeps your manual positions —
  only brand-new tables get auto-placed beside the rest. **Arrange** re-runs layout
  on demand.

### Edit on the canvas → SQL updates

- **Double-click** a table name, column name, or column type to edit it inline. The
  change is applied as a *surgical text edit* (comments, formatting, and unsupported
  clauses are preserved), and a table rename updates every `REFERENCES` to it.
- **Add columns**: pin a table, then **+ add column**. The new column is inserted into
  your SQL with a default type for the selected **dialect** (PostgreSQL / MySQL /
  SQLite / SQL Server / Snowflake) and opens inline so you can name it. Editing a
  column type shows dialect-aware suggestions.

### Annotate

- A bottom-left palette adds **sticky notes** and **group boxes** to label and cluster
  sections. Drag to move, drag the corner to resize, double-click to edit text, click
  to select (colour swatches + delete), or press Delete. They're part of the diagram —
  included in saves, share links, and PNG/SVG exports.

### Save, share & export

- **Save / Open projects**: **Save** downloads a `.json` project (SQL + layout + camera
  + dialect); **Open** loads one back.
- **Share link**: **Share** copies a URL with the entire project encoded in the hash —
  gzip-compressed + base64. The `#…` fragment is never sent to a server, so sharing
  needs **no backend**, and opening the link restores the exact diagram.
- **Export** to **PNG** (raster) and **SVG** (vector).

### Editor & appearance

- **Syntax-highlighted SQL editor**: keywords / types / strings / comments / numbers
  are colored via a paint layer behind the textarea. Re-tokenizing is a single linear
  pass coalesced to one animation frame, so typing stays instant (~6ms full repaint on
  a 45KB / 300-table script, sub-ms on normal schemas).
- **Hide the SQL panel** (⬚ in the toolbar) for a full-width diagram.
- **Light + dark themes**, and it remembers your last schema locally.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

## MCP

`mcp/server.mjs` is an MCP server (stdio) that lets an AI agent drive the diagram
open at `http://localhost:5173`. It can draw a schema from SQL, open and save
projects, arrange tables and lines, group tables into boxes, add or remove links,
add notes, and take screenshots to check the layout.

### 1. Install

You need **Node 18+** and **git**. Run the command as your normal user, not with
`sudo` (with `sudo` it would set up root's agents instead of yours).

| System | Command |
| --- | --- |
| Linux, macOS, Git Bash | `curl -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs \| node -` |
| Windows PowerShell | `curl.exe -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs \| node -` |
| From a checkout | `npm run mcp:install` |

On Windows, type `curl.exe`: in PowerShell plain `curl` is a different command.
CI runs the one-liner on Ubuntu, macOS and Windows on every change
([`installer.yml`](.github/workflows/installer.yml)).

The installer:

1. Clones the app to `~/.sql-to-erd` (or uses the checkout you run
   `npm run mcp:install` from) and runs `npm install`.
2. For every agent it finds, registers the `sql-to-erd` MCP server and copies
   the [`sql-to-erd` skill](skills/sql-to-erd/SKILL.md), which tells the AI how
   to use the tools:

| Agent | MCP config | Skill |
| --- | --- | --- |
| Claude Code | `claude mcp add -s user` (or `~/.claude.json`) | `~/.claude/skills/` |
| Claude Desktop | `claude_desktop_config.json` | — |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/skills/` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/skills/` |
| VS Code (Copilot), Insiders, VSCodium | user `mcp.json` | — |
| Codex | `~/.codex/config.toml` | `~/.agents/skills/` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.agents/skills/` |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.agents/skills/` |
| Kiro | `~/.kiro/settings/mcp.json` | — |

On Linux, app config lives under `XDG_CONFIG_HOME` (default `~/.config`), for
example `~/.config/Code/User/mcp.json` and `~/.config/opencode/opencode.json`.

Your existing config is merged, never replaced, and each file is backed up once to
`<file>.sql-to-erd.bak`. Running the installer again is safe: it only updates
what changed.

### 2. Use it

1. Restart your AI agent so it loads the new MCP server.
2. Start the app and keep it running:

   ```bash
   cd ~/.sql-to-erd && npm run dev
   ```

3. Open `http://localhost:5173` in **one** browser tab. The newest tab to connect
   (or the last one focused) receives the commands.
4. Ask your agent, for example:
   - *"Draw an ER diagram from schema.sql"*
   - *"Group these tables by business domain and straighten the lines"*
   - *"Save the diagram to docs/erd.json"*

### Options

Add them after `node -` (for example `... | node - --dry-run`) or after
`npm run mcp:install --`.

| Option | What it does |
| --- | --- |
| `--dry-run` | Show what would change, change nothing |
| `--uninstall` | Remove the MCP entries and skills (keeps the app folder) |
| `--only=cursor,codex` | Only these agents: `claude-code`, `claude-desktop`, `cursor`, `windsurf`, `vscode`, `vscode-insiders`, `vscodium`, `codex`, `gemini`, `opencode`, `kiro` |
| `--dir=<path>` | Put the app somewhere other than `~/.sql-to-erd` |
| `--no-cli` | Edit config files directly instead of using an agent's own CLI |
| `--skip-npm` | Don't run `npm install` |

Environment variables: `SQL_TO_ERD_HOME` (app folder), `SQL_TO_ERD_REPO` and
`SQL_TO_ERD_REF` (install from another fork or branch; set them on `node`, not
on `curl`).

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs | node - --uninstall
```

This removes the MCP entries and skills. Delete `~/.sql-to-erd` yourself if you
no longer want the app.

### Manual setup

For an agent the installer doesn't know, register this stdio server
(use absolute paths):

```json
{
  "mcpServers": {
    "sql-to-erd": { "command": "node", "args": ["/home/you/.sql-to-erd/mcp/server.mjs"] }
  }
}
```

Codex uses TOML in `~/.codex/config.toml`:

```toml
[mcp_servers.sql-to-erd]
command = "node"
args = ["/home/you/.sql-to-erd/mcp/server.mjs"]
```

Claude Code: `claude mcp add -s user sql-to-erd -- node ~/.sql-to-erd/mcp/server.mjs`

### Troubleshooting

- **`diagram_status` says `connected: false`**: the app isn't running or no tab
  is open. Run `npm run dev` in the app folder and open `http://localhost:5173`.
- **Port 5199 already in use**: another agent already runs the MCP server. Only
  one copy can run at a time, so close the other agent's session.
- **"isn't plain JSON (comments?)"**: that config file has comments (JSONC), so
  the installer left it alone and printed the entry to add by hand.
- **Agent can't find `node`**: the installer registers the absolute path of the
  `node` that ran it. If you later remove that Node version (for example with
  nvm), run the installer again.

The page talks to the server through `127.0.0.1:5199` only, and only from the dev
server's origin. The bridge isn't included in production builds.

## Build & host

```bash
npm run build    # outputs static files to dist/
npm run preview  # preview the production build locally
```

`dist/` is plain static HTML/JS/CSS — drop it on any static host:

- **GitHub Pages** — push `dist/` to a `gh-pages` branch, or use an action.
- **Netlify / Vercel / Cloudflare Pages** — build command `npm run build`, publish dir `dist`.
- **Any web server / S3 bucket** — just upload the contents of `dist/`.

## Supported SQL

- `CREATE [OR REPLACE] [TEMPORARY | TRANSIENT] TABLE [IF NOT EXISTS] name ( ... )` with quoted / backtick / `[bracket]` / `schema.qualified` names.
- Inline column constraints: `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `REFERENCES other(col)`.
- Table-level constraints: `PRIMARY KEY (...)`, `UNIQUE (...)`,
  `FOREIGN KEY (...) REFERENCES other(...)`, `CONSTRAINT ... FOREIGN KEY ...`.
- `ALTER TABLE x ADD [CONSTRAINT ...] FOREIGN KEY (...) REFERENCES y(...)`.
- Line (`--`, `#`) and block (`/* */`) comments are ignored.

## BigQuery

Select **BigQuery** from the dialect dropdown to work with BigQuery SQL instead of DDL.

- Paste a raw `WITH … AS (…)` query — no `CREATE TABLE` statements needed. Each CTE becomes a table node in the diagram.
- Column names are extracted from the `SELECT` list of each CTE (using aliases where present).
- Relationships are inferred automatically from `FROM` and `JOIN` references: a CTE that reads from another CTE gets an edge between them, and references to base tables create stub nodes connected to the CTE.
- Backtick-quoted three-part names (`project.dataset.table`) are supported — the table portion is used as the node label.

## Tech

- **Vite** — build + dev server.
- **@dagrejs/dagre** — layered auto-layout.
- Custom canvas renderer + SQL DDL parser (no heavy SQL-parser dependency).

## Shortcuts

| Key | Action |
| --- | --- |
| **⌘ / Ctrl + Enter** | Re-arrange |
| **Ctrl + F** | Search tables and fields |
| **Ctrl + Z** / **Ctrl + Y** | Undo / redo |
| **Delete** | Remove the pinned manual link |
| **Double-click** canvas | Zoom in |
| Drag the pane divider | Resize the editor |

## License

[MIT](./LICENSE) © Royal Bhati. Fork it, self-host it, add your own SQL dialects — go for it.
