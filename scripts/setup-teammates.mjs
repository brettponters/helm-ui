#!/usr/bin/env node
/**
 * One-time setup for `claude helm` cross-teammate chat.
 *
 *   1. Registers the `helm-teammates` MCP server in ~/.claude.json (global, so
 *      it is found from any working directory a teammate runs in).
 *   2. Adds a `claude helm` shell function to your shell rc.
 *
 * Safe + idempotent: backs up files it touches, never clobbers an existing
 * `claude()` function (it prints the snippet to add instead).
 *
 *   node scripts/setup-teammates.mjs
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';

const HOME = os.homedir();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpPath = join(repoRoot, 'helm-broker', 'helm-mcp.js');

function backup(file) {
  const bak = `${file}.helm-bak`;
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
}

// ─── 1. Register the MCP server globally ─────────────────────────────────────

function setupMcp() {
  const p = join(HOME, '.claude.json');
  let cfg = {};
  if (existsSync(p)) {
    backup(p);
    cfg = JSON.parse(readFileSync(p, 'utf8'));
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['helm-teammates'] = { type: 'stdio', command: 'node', args: [mcpPath], env: {} };
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log(`✓ Registered helm-teammates MCP -> ${mcpPath}`);
}

// ─── 2. Add the `claude helm` shell function ────────────────────────────

const FN_MARKER = 'server:helm-teammates';
// NOTE: `claude helm` runs with --dangerously-skip-permissions so teammates work
// without permission prompts. This is a deliberate, frictionless-but-risky default;
// remove that flag below if you want teammates to keep asking before acting.
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

function setupShell() {
  const shell = process.env.SHELL || '';
  const rc = shell.includes('bash') ? join(HOME, '.bashrc') : join(HOME, '.zshrc');

  const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';

  if (existing.includes(FN_MARKER)) {
    console.log(`✓ Shell already has \`claude helm\` (${rc})`);
    return;
  }
  if (/(^|\n)\s*claude\s*\(\)\s*\{/.test(existing)) {
    console.log(`! You already define a claude() function in ${rc}.`);
    console.log('  Add this branch inside it so it does not get clobbered:\n');
    console.log('    elif [ "$1" = "helm" ]; then');
    console.log('      shift');
    console.log('      command claude --dangerously-skip-permissions --dangerously-load-development-channels server:helm-teammates "$@"');
    return;
  }
  backup(rc);
  writeFileSync(rc, existing + '\n' + FN_BLOCK);
  console.log(`✓ Added \`claude helm\` to ${rc}`);
}

setupMcp();
setupShell();
console.log('\nDone. Restart your shell (or `source` your rc), start Helm, then run `claude helm` in a panel.');
