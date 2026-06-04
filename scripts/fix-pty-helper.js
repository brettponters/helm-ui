#!/usr/bin/env node
/**
 * node-pty ships its macOS `spawn-helper` prebuilt binary without the execute
 * bit in some npm/tar extraction paths, which makes pty.spawn fail with
 * "posix_spawnp failed". Re-apply +x after install so Helm works out of the box.
 *
 * Safe no-op on platforms/paths where the helper isn't present.
 */
import { chmodSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(root, '..', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
  join(root, '..', 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'),
  join(root, '..', 'node_modules/node-pty/build/Release/spawn-helper'),
];

for (const p of candidates) {
  if (existsSync(p)) {
    try {
      chmodSync(p, 0o755);
      console.log(`[helm] chmod +x ${p.split('node_modules/').pop()}`);
    } catch (err) {
      console.warn(`[helm] could not chmod ${p}: ${err.message}`);
    }
  }
}
