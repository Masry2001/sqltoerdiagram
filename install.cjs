#!/usr/bin/env node
// One-command installer for the sql-to-erd MCP server and its AI skill.
//
//   curl -fsSL https://raw.githubusercontent.com/Masry2001/sqltoerdiagram/main/install.cjs | node -
//   (Windows PowerShell: use curl.exe instead of curl)
//
// It clones (or updates) the app, runs npm install, then registers the MCP
// server and copies the skill for every AI agent it finds on this machine.
// Safe to re-run. Existing config files are merged, never replaced, and backed
// up once to <file>.sql-to-erd.bak before the first change.
//
// Options (after "node -" when piped):
//   --dry-run          show what would change, change nothing
//   --uninstall        remove the MCP entries and skills (keeps the app folder)
//   --only=a,b         only these agents (see AGENTS below for the ids)
//   --dir=<path>       app folder (default: ~/.sql-to-erd, or this checkout)
//   --no-cli           edit config files directly instead of using agent CLIs
//   --skip-npm         don't run npm install
// Environment: SQL_TO_ERD_HOME, SQL_TO_ERD_REPO, SQL_TO_ERD_REF
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'sql-to-erd';
const REPO = process.env.SQL_TO_ERD_REPO || 'https://github.com/Masry2001/sqltoerdiagram.git';
const REF = process.env.SQL_TO_ERD_REF || '';
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

// ---------- options ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
if (flag('help') || flag('h')) {
  console.log(fs.existsSync(__filename) ? fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n') : 'See install.cjs header.');
  process.exit(0);
}
const DRY = flag('dry-run');
const UNINSTALL = flag('uninstall');
const USE_CLI = !flag('no-cli');
const ONLY = opt('only') ? new Set(opt('only').split(',').map((s) => s.trim())) : null;

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n==> ${msg}`);
const did = (msg) => console.log(`  ${DRY ? '[dry-run] ' : ''}${msg}`);

// Running from a checkout (node install.cjs) uses that checkout; piped runs
// (__filename is "[stdin]") use ~/.sql-to-erd.
function appDir() {
  if (opt('dir')) return path.resolve(opt('dir'));
  if (process.env.SQL_TO_ERD_HOME) return path.resolve(process.env.SQL_TO_ERD_HOME);
  // Piped in, __filename is "[stdin]": its dirname would be the current folder,
  // so only trust it when the script really is a file on disk.
  if (fs.existsSync(__filename)) {
    const here = path.dirname(path.resolve(__filename));
    if (fs.existsSync(path.join(here, 'mcp', 'server.mjs'))) return here;
  }
  return path.join(HOME, '.sql-to-erd');
}
const APP = appDir();
const SERVER = path.join(APP, 'mcp', 'server.mjs');
const SKILL_SRC = path.join(APP, 'skills', NAME, 'SKILL.md');
const NODE = process.execPath; // absolute, so GUI apps with a short PATH still find node

// ---------- helpers ----------
function run(cmd, args, opts = {}) {
  // On Windows the shell is needed to run .cmd shims (npm, claude), and it joins
  // args with spaces, so quote any that contain one.
  const base = { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts };
  const res = IS_WIN
    ? spawnSync([cmd, ...args.map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a))].join(' '), { ...base, shell: true })
    : spawnSync(cmd, args, base);
  return res.status === 0;
}
function onPath(cmd) {
  if (IS_WIN) return spawnSync('where', [cmd], { stdio: 'pipe' }).status === 0;
  // `command -v` is POSIX and always there; `which` is missing on some minimal distros.
  return spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], { stdio: 'pipe' }).status === 0;
}
const exists = (p) => fs.existsSync(p);

function backup(file) {
  const bak = `${file}.sql-to-erd.bak`;
  if (exists(file) && !exists(bak) && !DRY) fs.copyFileSync(file, bak);
}
function readJson(file) {
  if (!exists(file)) return {};
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return {};
  return JSON.parse(text); // throws on JSONC; caller prints a manual snippet instead
}
function writeFile(file, text) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, text);
}

// Set or delete obj[k1][k2]...[NAME] in a JSON config file.
function editJson(file, keys, value, label) {
  let data;
  try {
    data = readJson(file);
  } catch {
    if (UNINSTALL) return log(`  ! ${label}: ${file} isn't plain JSON (comments?). Remove "${NAME}" under "${keys.join('.')}" by hand.`);
    log(`  ! ${label}: ${file} isn't plain JSON (comments?). Add this by hand under "${keys.join('.')}":`);
    log(`    "${NAME}": ${JSON.stringify(value)}`);
    return;
  }
  let node = data;
  for (const k of keys) node = node[k] && typeof node[k] === 'object' ? node[k] : (node[k] = {});
  if (UNINSTALL) {
    if (!(NAME in node)) return did(`${label}: nothing to remove`);
    delete node[NAME];
    writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    return did(`${label}: removed from ${file}`);
  }
  if (JSON.stringify(node[NAME]) === JSON.stringify(value)) return did(`${label}: already set in ${file}`);
  node[NAME] = value;
  writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  did(`${label}: wrote ${file}`);
}

const stdio = () => ({ command: NODE, args: [SERVER] });
const tomlStr = (s) => JSON.stringify(s); // JSON strings are valid TOML basic strings

function editCodexToml(file) {
  const header = `[mcp_servers.${NAME}]`;
  const original = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  let text = original;
  // Drop an existing block: header line up to the next table header or EOF.
  const block = new RegExp(`\\n?\\[mcp_servers\\.(?:"${NAME}"|${NAME})\\][\\s\\S]*?(?=\\n\\[|$)`);
  const had = block.test(text);
  text = text.replace(block, '');
  if (UNINSTALL) {
    if (!had) return did('Codex: nothing to remove');
    writeFile(file, text.replace(/\s*$/, '\n'));
    return did(`Codex: removed from ${file}`);
  }
  const entry = `${header}\ncommand = ${tomlStr(NODE)}\nargs = [${tomlStr(SERVER)}]\n`;
  text = `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${entry}`;
  if (text === original) return did(`Codex: already set in ${file}`);
  writeFile(file, text);
  did(`Codex: ${had ? 'updated' : 'wrote'} ${file}`);
}

function copySkill(dir, label) {
  const dest = path.join(dir, NAME);
  if (UNINSTALL) {
    if (!exists(dest)) return;
    if (!DRY) fs.rmSync(dest, { recursive: true, force: true });
    return did(`skill removed: ${dest}`);
  }
  if (!DRY) {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(SKILL_SRC, path.join(dest, 'SKILL.md'));
  }
  did(`skill (${label}): ${path.join(dest, 'SKILL.md')}`);
}

// ---------- agents ----------
const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const configHome = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const claudeDesktopDir =
  process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', 'Claude')
    : IS_WIN ? path.join(appData, 'Claude') : path.join(configHome, 'Claude');
const appConfigDir = (name) =>
  process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support', name)
    : IS_WIN ? path.join(appData, name) : path.join(configHome, name);
// VS Code, Insiders and VSCodium (common on Linux) keep user settings side by side.
const vscodeFlavours = [
  ['vscode', 'VS Code (Copilot)', 'Code'],
  ['vscode-insiders', 'VS Code Insiders', 'Code - Insiders'],
  ['vscodium', 'VSCodium', 'VSCodium'],
].map(([id, label, dir]) => ({ id, label, userDir: path.join(appConfigDir(dir), 'User') }));

const AGENTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    detect: () => onPath('claude') || exists(path.join(HOME, '.claude')),
    skills: path.join(HOME, '.claude', 'skills'),
    apply() {
      if (USE_CLI && onPath('claude')) {
        if (DRY) return did(`Claude Code: claude mcp ${UNINSTALL ? 'remove' : 'add'} -s user ${NAME}`);
        run('claude', ['mcp', 'remove', '-s', 'user', NAME], { quiet: true });
        if (UNINSTALL) return did('Claude Code: removed (claude mcp remove)');
        if (run('claude', ['mcp', 'add', '-s', 'user', NAME, '--', NODE, SERVER], { quiet: true })) {
          return did('Claude Code: registered (claude mcp add -s user)');
        }
      }
      editJson(path.join(HOME, '.claude.json'), ['mcpServers'], { type: 'stdio', ...stdio() }, 'Claude Code');
    },
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    detect: () => exists(claudeDesktopDir),
    apply: () => editJson(path.join(claudeDesktopDir, 'claude_desktop_config.json'), ['mcpServers'], stdio(), 'Claude Desktop'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: () => exists(path.join(HOME, '.cursor')),
    skills: path.join(HOME, '.cursor', 'skills'),
    apply: () => editJson(path.join(HOME, '.cursor', 'mcp.json'), ['mcpServers'], stdio(), 'Cursor'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detect: () => exists(path.join(HOME, '.codeium', 'windsurf')),
    skills: path.join(HOME, '.codeium', 'windsurf', 'skills'),
    apply: () => editJson(path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), ['mcpServers'], stdio(), 'Windsurf'),
  },
  ...vscodeFlavours.map(({ id, label, userDir }) => ({
    id,
    label,
    detect: () => exists(userDir),
    apply: () => editJson(path.join(userDir, 'mcp.json'), ['servers'], { type: 'stdio', ...stdio() }, label),
  })),
  {
    id: 'codex',
    label: 'Codex',
    detect: () => onPath('codex') || exists(path.join(HOME, '.codex')),
    skills: path.join(HOME, '.agents', 'skills'),
    apply: () => editCodexToml(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml')),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: () => onPath('gemini') || exists(path.join(HOME, '.gemini')),
    skills: path.join(HOME, '.agents', 'skills'),
    apply: () => editJson(path.join(HOME, '.gemini', 'settings.json'), ['mcpServers'], stdio(), 'Gemini CLI'),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    detect: () => onPath('opencode') || exists(path.join(configHome, 'opencode')),
    skills: path.join(HOME, '.agents', 'skills'),
    apply() {
      const dir = path.join(configHome, 'opencode');
      const jsonc = path.join(dir, 'opencode.jsonc');
      const file = exists(jsonc) ? jsonc : path.join(dir, 'opencode.json');
      editJson(file, ['mcp'], { type: 'local', command: [NODE, SERVER], enabled: true }, 'OpenCode');
    },
  },
  {
    id: 'kiro',
    label: 'Kiro',
    detect: () => exists(path.join(HOME, '.kiro')),
    apply: () => editJson(path.join(HOME, '.kiro', 'settings', 'mcp.json'), ['mcpServers'], stdio(), 'Kiro'),
  },
];

// ---------- main ----------
function fetchApp() {
  step(`App folder: ${APP}`);
  if (exists(SERVER)) {
    if (exists(path.join(APP, '.git')) && APP === path.join(HOME, '.sql-to-erd') && !DRY) {
      did('updating (git pull --ff-only)');
      run('git', ['-C', APP, 'pull', '--ff-only'], { quiet: true });
    } else did('using existing checkout');
  } else {
    if (!onPath('git')) throw new Error('git is required: install it from https://git-scm.com and run this again.');
    const args = ['clone', '--depth', '1', ...(REF ? ['--branch', REF] : []), REPO, APP];
    did(`git ${args.join(' ')}`);
    if (!DRY && !run('git', args)) throw new Error('git clone failed.');
  }
  if (!flag('skip-npm') && !DRY) {
    did('npm install');
    if (!run(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-fund', '--no-audit'], { cwd: APP, quiet: true })) {
      throw new Error(`npm install failed. Run it yourself in ${APP}.`);
    }
  }
}

function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) throw new Error(`Node 18 or newer is required (found ${process.version}).`);
  if (!IS_WIN && process.getuid && process.getuid() === 0 && process.env.SUDO_USER) {
    log(`! Running under sudo: this sets up the agents of root (${HOME}), not of ${process.env.SUDO_USER}.`);
    log('  Run it without sudo to set up your own agents.');
  }

  if (!UNINSTALL) fetchApp();

  step(UNINSTALL ? 'Removing from AI agents' : 'Registering the MCP server and skill');
  const chosen = AGENTS.filter((a) => (ONLY ? ONLY.has(a.id) : a.detect()));
  if (!chosen.length) log('  No supported AI agents found. Use --only=<id> to force one: ' + AGENTS.map((a) => a.id).join(', '));
  const skillDirs = new Map();
  for (const agent of chosen) {
    try {
      agent.apply();
    } catch (err) {
      log(`  ! ${agent.label}: ${err.message}`);
    }
    if (agent.skills) skillDirs.set(agent.skills, (skillDirs.get(agent.skills) || []).concat(agent.label));
  }
  if (UNINSTALL || exists(SKILL_SRC) || DRY) {
    for (const [dir, labels] of skillDirs) copySkill(dir, labels.join(', '));
  }

  if (UNINSTALL) {
    log(`\nDone. The app folder ${APP} was kept; delete it yourself if you no longer need it.`);
    return;
  }
  log(`
Done. Restart your AI agent so it loads the "${NAME}" MCP server, then:

  1. Start the app:   cd "${APP}" && npm run dev
  2. Open http://localhost:5173 in one browser tab
  3. Ask your agent:  "Draw an ER diagram from schema.sql"

Agents set up: ${chosen.map((a) => a.label).join(', ') || 'none'}`);
}

try {
  main();
} catch (err) {
  console.error(`\nsql-to-erd installer: ${err.message}`);
  process.exit(1);
}
