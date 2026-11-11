---
name: sql-to-erd
description: Draw, arrange and screenshot ER diagrams from SQL schemas with the sql-to-erd MCP server (SQL to ER Diagram app). Use when the user wants an ER diagram / ERD / entity-relationship diagram / schema diagram from CREATE TABLE SQL, wants tables grouped by domain, relation lines tidied, manual links added, or a diagram project (.json) opened or saved.
---

# SQL to ER Diagram (sql-to-erd MCP)

The `sql-to-erd` MCP server drives the diagram that is open in a browser tab at
`http://localhost:5173`. Every `diagram_*` tool acts on that live tab, so the app
must be running and open before any tool except `diagram_status` will work.

## 1. Make sure the app is connected

1. Call `diagram_status`.
2. If it returns `connected: false`:
   - Start the app from the install folder (default `~/.sql-to-erd`, or the repo
     checkout): `npm run dev` (keep it running; it serves `http://localhost:5173`).
   - Open `http://localhost:5173` in **one** browser tab. The newest tab to connect,
     or the last one focused, receives the commands.
   - Call `diagram_status` again. Don't continue until it says `connected: true`.
3. If the reason mentions port 5199 being in use, another agent already runs the
   MCP server. Only one copy can run at a time; close the other agent's session.

## 2. Typical flow

1. **Draw**: `diagram_load_sql` with the SQL (`CREATE TABLE ...` with foreign keys)
   and an optional `dialect` (`postgres`, `mysql`, `sqlite`, `sqlserver`,
   `snowflake`). Tables that keep their name keep their position.
2. **Lay out**, pick one:
   - `diagram_auto_arrange` (`direction` `LR`/`TB`, `spacing`) for a plain graph layout.
   - `diagram_organize_groups` to put tables in labelled boxes by domain. List
     every table in a group, or set `ungrouped` to `group` / `hide` / `leave`.
     Add `optimize_lines: true` to shorten relation lines.
3. **Tidy lines**: `diagram_arrange_lines_straight` for right-angle lines, or
   `diagram_arrange_lines` for curved ones. Run this after moving tables.
4. **Check**: `diagram_screenshot` and look at the image. Pass `tables` to zoom
   into one area. Fix what looks wrong, then screenshot again.
5. **Show the user**: `diagram_view` with `fit: true` or `center_table`.
6. **Save** if asked: `diagram_save_project` with a path ending in `.json`.

## 3. Rules that are easy to get wrong

- Read before you replace: `diagram_set_annotations` replaces **all** group boxes
  and sticky notes. Call `diagram_get` first and send back the ones to keep.
- Manual links vs foreign keys: `diagram_add_links` / `diagram_remove_links` only
  touch dashed manual links. Foreign keys come from the SQL; change the SQL to
  change them.
- Project paths for `diagram_load_project` and `diagram_save_project` must end in
  `.json`. Save overwrites an existing file, so confirm before overwriting one
  the user didn't name.
- Big schemas: call `diagram_get` without `include_columns` / `include_sql` first,
  and narrow with `tables` when you need columns.
- `diagram_set_visibility` with `only` hides every other table; use `show_all`
  to undo it.
- Table names are matched as written in the SQL. Use `diagram_get` to read the
  exact names before you group, move or link tables.

## 4. Without the browser (headless SVG)

For a one-off SVG file without the MCP server, the repo has a CLI:

```bash
node bin/cli.js schema.sql -o schema.svg --theme=light --direction=LR
```

It also reads Prisma, DBML, Mermaid, PlantUML, SQLAlchemy and Sequelize
(`--format`), and `--tables a,b` limits the output to some tables.
