// Checks what install.cjs left behind. Usage: node check-install.cjs installed|uninstalled
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2];
const HOME = os.homedir();
const NAME = 'sql-to-erd';
const failures = [];
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const json = (p) => (read(p) ? JSON.parse(read(p)) : {});
const expect = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const want = mode === 'installed';

const cursor = json(path.join(HOME, '.cursor', 'mcp.json'));
expect(!!cursor.mcpServers?.[NAME] === want, `Cursor entry ${want ? 'present' : 'removed'}`);
expect(!!cursor.mcpServers?.other, 'Cursor: existing "other" server kept');

const codex = read(path.join(HOME, '.codex', 'config.toml'));
expect(codex.includes(`[mcp_servers.${NAME}]`) === want, `Codex entry ${want ? 'present' : 'removed'}`);
expect(codex.includes('[mcp_servers.other]'), 'Codex: existing "other" server kept');

const opencode = json(path.join(HOME, '.config', 'opencode', 'opencode.json'));
expect(!!opencode.mcp?.[NAME] === want, `OpenCode entry ${want ? 'present' : 'removed'}`);

const gemini = json(path.join(HOME, '.gemini', 'settings.json'));
expect(!!gemini.mcpServers?.[NAME] === want, `Gemini CLI entry ${want ? 'present' : 'removed'}`);

if (process.platform === 'linux') {
  const codium = json(path.join(HOME, '.config', 'VSCodium', 'User', 'mcp.json'));
  expect(!!codium.servers?.[NAME] === want, `VSCodium entry ${want ? 'present' : 'removed'}`);
}

for (const dir of [path.join(HOME, '.agents', 'skills'), path.join(HOME, '.cursor', 'skills')]) {
  expect(fs.existsSync(path.join(dir, NAME, 'SKILL.md')) === want, `skill in ${dir} ${want ? 'present' : 'removed'}`);
}

if (want) {
  const entry = cursor.mcpServers[NAME];
  expect(path.isAbsolute(entry.command) && fs.existsSync(entry.command), `node path is absolute and exists: ${entry.command}`);
  expect(fs.existsSync(entry.args[0]), `server path exists: ${entry.args[0]}`);
  if (process.env.EXPECT_APP_DIR) {
    const wanted = path.join(path.resolve(process.env.EXPECT_APP_DIR), 'mcp', 'server.mjs');
    expect(entry.args[0] === wanted, `server is in the app folder ${wanted}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
