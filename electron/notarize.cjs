'use strict';
/**
 * afterSign hook: notarize the signed app with Apple so it opens without a
 * Gatekeeper warning on other people's machines.
 *
 * We deliberately do NOT use @electron/notarize's keychainProfile path or
 * electron-builder's built-in `notarize` config — both fail to generate
 * options when credentials live in a notarytool keychain profile
 * (electron-builder #8015, electron/notarize #92/#175, the
 * "notarize options were unable to be generated" bug). Instead we shell out to
 * the Apple tools directly, which is the path that actually works:
 *
 *   1. zip the .app   (notarytool wants a zip/dmg/pkg, not a raw bundle)
 *   2. notarytool submit --wait   (upload + block until Apple's verdict)
 *   3. stapler staple   (attach the ticket to the .app)
 *
 * Credentials are a notarytool keychain profile (default "helm-notary"),
 * created once with:
 *   xcrun notarytool store-credentials helm-notary \
 *     --apple-id <you@example.com> --team-id <TEAMID>
 *
 * Set HELM_SKIP_NOTARIZE=1 to build a signed-but-not-notarized app (fine for
 * local testing; only download-to-other-machines needs notarization).
 */
const { execFileSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');
const { rmSync } = require('fs');

const PROFILE = process.env.HELM_NOTARY_PROFILE || 'helm-notary';

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.HELM_SKIP_NOTARIZE === '1') {
    console.log('[notarize] skipped (HELM_SKIP_NOTARIZE=1)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;
  const zipPath = join(tmpdir(), `${appName}-notarize-${Date.now()}.zip`);

  try {
    console.log(`[notarize] zipping ${appName}.app…`);
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);

    console.log(`[notarize] uploading to Apple notary (profile "${PROFILE}")…`);
    run('xcrun', ['notarytool', 'submit', zipPath, '--keychain-profile', PROFILE, '--wait']);

    console.log('[notarize] stapling ticket…');
    run('xcrun', ['stapler', 'staple', appPath]);

    console.log('[notarize] accepted + stapled ✓');
  } catch (err) {
    console.warn(`[notarize] not notarized: ${err.message}`);
    console.warn('[notarize] (the app is signed but will show a Gatekeeper prompt when downloaded by others)');
  } finally {
    try { rmSync(zipPath, { force: true }); } catch { /* best effort */ }
  }
};
