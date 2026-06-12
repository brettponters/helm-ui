'use strict';
/**
 * Shared `claude helm` setup logic — used by both the CLI (`npm run setup-chat`)
 * and the app's first-run bootstrap (electron/main.cjs). Single source of truth
 * so the two never drift.
 *
 * Does two things, idempotently:
 *   1. Registers the `helm-teammates` MCP server in ~/.claude.json (global), so
 *      a teammate finds it from any working directory.
 *   2. Adds a `claude helm` shell function to the user's shell rc.
 *
 * The MCP command/args/env are parameters so the packaged app can point at its
 * own bundled helm-mcp.js and run it via Electron-as-Node (no system Node needed),
 * while the dev CLI uses plain `node` against the repo copy.
 */
const { readFileSync, writeFileSync, existsSync, copyFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const HOME = os.homedir();
const FN_MARKER = 'server:helm-teammates';

// NOTE: `claude helm` runs with --dangerously-skip-permissions so teammates work
// without permission prompts — a deliberate, frictionless-but-risky default.
const FN_BLOCK = `
# Helm: \`claude helm\` joins Helm teammate chat with permissions bypassed (added by Helm setup).
claude() {
  if [ "$1" = "helm" ]; then
    shift
    command claude --dangerously-skip-permissions --dangerously-load-development-channels server:helm-teammates "$@"
  else
    command claude "$@"
  fi
}
`;

function backup(file) {
  const bak = `${file}.helm-bak`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
}

function rcPath() {
  const shell = process.env.SHELL || '';
  return shell.includes('bash') ? join(HOME, '.bashrc') : join(HOME, '.zshrc');
}

// True only when BOTH the MCP is registered and the shell function exists.
function isSetUp() {
  let mcpOk = false;
  try {
    const p = join(HOME, '.claude.json');
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      mcpOk = !!(cfg.mcpServers && cfg.mcpServers['helm-teammates']);
    }
  } catch { /* treat malformed as not set up */ }

  let shellOk = false;
  try {
    const rc = rcPath();
    shellOk = existsSync(rc) && readFileSync(rc, 'utf8').includes(FN_MARKER);
  } catch { /* not readable -> not set up */ }

  return mcpOk && shellOk;
}

/**
 * @param {{ command?: string, args: string[], env?: object }} opts MCP launch spec.
 * @returns {{ mcp: string, shell: string, manualShell: boolean }}
 */
function setupHelmChat({ command = 'node', args, env = {} } = {}) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('setupHelmChat: args (MCP path) required');
  const result = { mcp: '', shell: '', manualShell: false };

  // 1. Register the MCP globally (overwrites any prior helm-teammates entry so a
  //    moved/reinstalled app re-points correctly).
  const p = join(HOME, '.claude.json');
  let cfg = {};
  if (existsSync(p)) { backup(p); try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { cfg = {}; } }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['helm-teammates'] = { type: 'stdio', command, args, env };
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  result.mcp = `registered helm-teammates -> ${command} ${args.join(' ')}`;

  // 2. Add the shell function (never clobber an existing claude() definition).
  const rc = rcPath();
  const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
  if (existing.includes(FN_MARKER)) {
    result.shell = `shell already has \`claude helm\` (${rc})`;
  } else if (/(^|\n)\s*claude\s*\(\)\s*\{/.test(existing)) {
    result.shell = `you already define claude() in ${rc} — add the helm branch manually`;
    result.manualShell = true;
  } else {
    backup(rc);
    writeFileSync(rc, existing + '\n' + FN_BLOCK);
    result.shell = `added \`claude helm\` to ${rc}`;
  }
  return result;
}

module.exports = { isSetUp, setupHelmChat, rcPath, FN_BLOCK, FN_MARKER };
