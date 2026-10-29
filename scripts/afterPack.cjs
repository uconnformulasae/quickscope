const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * afterPack hook for electron-builder.
 *
 * For macOS builds without an Apple Developer certificate (unsigned / ad-hoc),
 * electron-builder modifies the Electron bundle (Info.plist, app.asar, extraResources)
 * but leaves the prebuilt linker signatures intact, resulting in a corrupted
 * signature state ("code has no resources but signature indicates they must be present").
 *
 * When downloaded by users via a browser, macOS Gatekeeper detects the corrupted
 * signature and marks the app as "damaged" (killing it with SIGKILL 137).
 *
 * This hook performs a clean ad-hoc deep code signing on the assembled .app bundle
 * before electron-builder packages it into DMG / ZIP. This ensures macOS recognizes
 * the bundle integrity and allows users to open it via System Settings -> "Open Anyway".
 */
exports.default = async function (context) {
  // Only target macOS
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  // If building with notarization or an Apple signing certificate, let electron-builder handle signing
  if (process.env.NOTARIZE === 'true' || process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[afterPack] Apple signing / notarization active; skipping ad-hoc re-sign.');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] Bundle not found at ${appPath}, skipping.`);
    return;
  }

  console.log(`[afterPack] Performing ad-hoc deep code signing on: ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, {
      stdio: 'inherit',
    });
    console.log(`[afterPack] Successfully ad-hoc signed ${appName}`);
  } catch (err) {
    console.error(`[afterPack] Failed to ad-hoc sign ${appName}:`, err);
    throw err;
  }
};

module.exports = exports.default;
