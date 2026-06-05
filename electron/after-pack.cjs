'use strict';
/**
 * Post-package fixups so the unsigned app actually runs:
 *  1. node-pty's macOS `spawn-helper` can lose its execute bit during packaging
 *     ("posix_spawnp failed" otherwise) — re-apply +x.
 *  2. Apple Silicon refuses to run an unsigned bundle, so ad-hoc sign it
 *     (codesign -s -). This needs no Apple Developer certificate and makes the
 *     app launch locally. (For distribution to others, replace with a real
 *     Developer ID identity + notarization.)
 *
 * Order matters: chmod first, then sign — signing seals the bundle.
 */
const { chmodSync, existsSync } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, 'Helm.app');
  const resources = path.join(appPath, 'Contents', 'Resources', 'app');

  const helpers = [
    'node_modules/node-pty/build/Release/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  ];
  for (const rel of helpers) {
    const p = path.join(resources, rel);
    if (existsSync(p)) {
      try { chmodSync(p, 0o755); console.log(`[helm afterPack] chmod +x ${rel}`); }
      catch (e) { console.warn(`[helm afterPack] chmod failed ${rel}: ${e.message}`); }
    }
  }

  // Ad-hoc sign only when electron-builder isn't doing real Developer ID signing
  // (i.e. no cert available). With a cert, electron-builder signs + we notarize.
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
      console.log('[helm afterPack] ad-hoc signed Helm.app (no Developer ID cert)');
    } catch (e) {
      console.warn(`[helm afterPack] ad-hoc sign failed: ${e.message}`);
    }
  }
};
