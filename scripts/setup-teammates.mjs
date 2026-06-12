#!/usr/bin/env node
/**
 * One-time CLI setup for `claude helm` cross-teammate chat (dev / repo install).
 * Most users get this automatically on first launch of Helm.app — this is the
 * manual path. Shares all logic with scripts/helm-setup.cjs.
 *
 *   node scripts/setup-teammates.mjs   (or: npm run setup-chat)
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const require = createRequire(import.meta.url);
const { setupHelmChat } = require('./helm-setup.cjs');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpPath = join(repoRoot, 'helm-broker', 'helm-mcp.js');

const r = setupHelmChat({ command: 'node', args: [mcpPath], env: {} });
console.log(`✓ MCP: ${r.mcp}`);
console.log(`✓ Shell: ${r.shell}`);
if (r.manualShell) {
  console.log('\n  Add this branch inside your existing claude() function:');
  console.log('    elif [ "$1" = "helm" ]; then');
  console.log('      shift');
  console.log('      command claude --dangerously-skip-permissions --dangerously-load-development-channels server:helm-teammates "$@"');
}
console.log('\nDone. Open a new terminal (or `source` your rc), start Helm, then run `claude helm` in a panel.');
