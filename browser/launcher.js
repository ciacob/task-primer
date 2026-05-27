'use strict';

/**
 * browser/launcher.js
 *
 * Responsible for four things:
 *   1. Resolving the correct Chrome for Testing binary for the current platform
 *   2. Downloading it (once) if not already cached in <cacheDir>
 *   3. Renaming the .app bundle on macOS (once) so the Dock, menu bar, and
 *      Mission Control show the application's own name instead of
 *      "Google Chrome for Testing"
 *   4. Spawning the browser in --app mode and returning the child process handle
 *
 * The returned handle is a standard Node.js ChildProcess. Callers attach
 * .on('exit', ...) to detect window close without any platform heuristics —
 * the browser is our direct child process, so exit detection is reliable.
 *
 * ── Build resolution ─────────────────────────────────────────────────────────
 *
 *   By default, buildId is set to 'stable' in package.json under
 *   taskPrimer.browser.buildId. This is a channel name, not a revision number.
 *   @puppeteer/browsers resolves it at download time to the latest Chrome for
 *   Testing stable release that has verified downloads for all platforms:
 *
 *     linux64, mac-arm64, mac-x64, win32, win64
 *
 *   The resolved binary is cached in <cacheDir> and reused on every subsequent
 *   run — resolution and download only happen once.
 *
 *   Why 'stable' and not a hardcoded revision?
 *   Revision numbers in Chrome for Testing are not guaranteed to have builds
 *   for all platforms. The stable channel endpoint is the only authoritative
 *   source of a version that is confirmed cross-platform. Hardcoding a revision
 *   that works on one platform and silently 404s on another is a maintenance trap.
 *
 * ── Pinning (optional) ───────────────────────────────────────────────────────
 *
 *   If reproducibility matters more than staying current, replace 'stable'
 *   in package.json with an exact version string, e.g. '124.0.6367.207'.
 *   Use only versions listed at:
 *     https://googlechromelabs.github.io/chrome-for-testing/
 *   Verify the version has a 200 for your target platforms before committing.
 *   After changing the version, delete .browsers/ to force a fresh download.
 *
 * ── macOS app rename ─────────────────────────────────────────────────────────
 *
 *   On macOS, the Dock icon label, menu bar app name, and Mission Control
 *   entry all read from the .app bundle's Info.plist — specifically the keys
 *   CFBundleName and CFBundleDisplayName. We patch these once after download
 *   using macOS's built-in `plutil` tool (no extra dependency).
 *
 *   The desired name comes from taskPrimer.appName in package.json.
 *
 *   A sentinel file (<bundle>/Contents/.last-rename) records the last name
 *   written. The patch is skipped if the sentinel matches the desired name,
 *   so it runs exactly once per build per name — safe to call on every launch.
 *
 *   Note on menu content: the macOS menu bar entries (File, Edit, View, etc.)
 *   are controlled by Chrome's internals and cannot be customised via plist
 *   or command-line flags. Only the app name (the bold item at the far left)
 *   is affected by this patch.
 *
 * ── pkg compatibility ────────────────────────────────────────────────────────
 *
 *   The browser binary lives in <cacheDir> on disk, outside any bundle.
 *   This file uses only @puppeteer/browsers (pure JS, no native addons)
 *   and Node built-ins. Both bundle cleanly with pkg.
 *
 *   When packaging with pkg, set cacheDir to a path relative to the
 *   executable (e.g. path.join(path.dirname(process.execPath), '.browsers'))
 *   so the cache survives next to the binary rather than relative to __dirname.
 */

const path      = require('path');
const fs        = require('fs');
const { spawn, execSync } = require('child_process');
const {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  computeExecutablePath,
} = require('@puppeteer/browsers');

// ─── Launch flags ─────────────────────────────────────────────────────────────

/**
 * --app=<url>
 *   Opens in a frameless app window — no address bar, no tab strip.
 *   Makes the browser behave like a dedicated native app window and ensures
 *   a single, clean process tree that we can watch for exit.
 *
 * --no-first-run / --no-default-browser-check
 *   Suppress first-launch setup prompts.
 *
 * --disable-extensions / --disable-translate
 *   Keep the window clean; no extension UI, no translation bar.
 *
 * --disable-infobars
 *   Suppresses the "Chrome is being controlled by automated software" and
 *   "Chrome for Testing is only for automated testing" notification bars.
 *
 * Linux sandbox note:
 *   --no-sandbox is added on Linux because most container and CI environments
 *   disable the kernel namespacing that Chrome's sandbox requires.
 *   Remove it if your Linux environment supports user namespaces.
 */
function buildLaunchArgs(url) {
  const args = [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-translate',
    '--disable-infobars',
  ];

  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return args;
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Ensure the requested Chrome for Testing build is present in cacheDir.
 * Downloads it if missing; skips silently if already cached.
 *
 * @param {string} cacheDir   Absolute path to the cache directory.
 * @param {string} buildId    Channel name ('stable') or exact version string.
 * @returns {Promise<string>} Absolute path to the browser executable.
 */
async function ensureChromium(cacheDir, buildId) {
  const platform = detectBrowserPlatform();

  if (!platform) {
    throw new Error(
      'Could not detect a supported platform for Chrome for Testing download. ' +
      'Supported: linux64, mac-arm64, mac-x64, win32, win64.'
    );
  }

  // Resolve channel names ('stable', 'beta', …) to concrete version strings.
  // Exact version strings pass through unchanged.
  const resolvedBuildId = await resolveBuildId('chrome', platform, buildId);

  const executablePath = computeExecutablePath({
    cacheDir,
    browser: 'chrome',
    buildId: resolvedBuildId,
  });

  if (fs.existsSync(executablePath)) {
    return executablePath;  // Already cached — fast path, no network required
  }

  // ── First-time download ───────────────────────────────────────────────────
  console.log(`[browser] Chrome for Testing ${resolvedBuildId} not found in cache.`);
  console.log(`[browser] Platform: ${platform}`);
  console.log(`[browser] Cache directory: ${cacheDir}`);
  console.log(`[browser] This is a one-time download (~300 MB). Please wait…\n`);

  let lastPercent = -1;

  await install({
    cacheDir,
    browser: 'chrome',
    buildId: resolvedBuildId,
    downloadProgressCallback(downloaded, total) {
      if (!total) return;
      const pct = Math.floor((downloaded / total) * 100);
      if (pct !== lastPercent && pct % 5 === 0) {
        process.stdout.write(`\r[browser] Downloading… ${pct}%   `);
        lastPercent = pct;
      }
    },
  });

  process.stdout.write('\r[browser] Download complete.              \n');
  return executablePath;
}

// ─── macOS app bundle rename ──────────────────────────────────────────────────

/**
 * Patch CFBundleName and CFBundleDisplayName in the .app bundle's Info.plist
 * so the Dock, menu bar, and Mission Control show `appName` instead of
 * "Google Chrome for Testing".
 *
 * No-ops silently on non-macOS platforms.
 * No-ops if the bundle has already been patched with this exact name.
 * Logs a warning (does not throw) if the patch fails — a cosmetic failure
 * should never prevent the app from launching.
 *
 * @param {string} executablePath  Absolute path to the browser binary.
 * @param {string} appName         The desired application name.
 */
function renameAppBundle(executablePath, appName) {
  if (process.platform !== 'darwin') { return; }
  if (!appName) { return; }

  // Executable lives at:
  //   <bundle>/Contents/MacOS/<binary-name>
  // So Info.plist is exactly 3 levels up, then into Contents/.
  const bundleContents = path.resolve(executablePath, '..', '..', '..');
  const plistPath      = path.join(bundleContents, 'Info.plist');
  const sentinelPath   = path.join(bundleContents, '.last-rename');

  if (!fs.existsSync(plistPath)) {
    console.warn('[browser] Info.plist not found — skipping app rename.');
    return;
  }

  // Check sentinel: skip if already patched with this exact name.
  try {
    const last = fs.readFileSync(sentinelPath, 'utf8').trim();
    if (last === appName) return;  // Already correct — nothing to do
  } catch (_) {
    // Sentinel absent or unreadable — proceed with patch
  }

  try {
    // plutil is a macOS system utility — always present, no extra dependency.
    // -replace <key> -string <value> <file> edits the plist in place.
    const q = JSON.stringify(appName);   // shell-safe quoting for the value
    execSync(`plutil -replace CFBundleName        -string ${q} "${plistPath}"`);
    execSync(`plutil -replace CFBundleDisplayName -string ${q} "${plistPath}"`);

    // Write sentinel so we don't re-patch on every launch
    fs.writeFileSync(sentinelPath, appName, 'utf8');

    console.log(`[browser] App bundle renamed to "${appName}".`);
  } catch (err) {
    // Cosmetic failure — warn but don't abort the launch
    console.warn(`[browser] App rename failed (non-fatal): ${err.message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the browser is cached, rename the app bundle if needed, then launch.
 *
 * @param {object} options
 * @param {string} options.url      The URL to open in the app window.
 * @param {string} options.cacheDir Absolute path to the browser cache dir.
 * @param {string} options.buildId  Channel name or exact version (default: 'stable').
 * @param {string} [options.appName] Desired app name for macOS Dock/menu bar.
 *                                   Omit or pass null to skip renaming.
 *
 * @returns {Promise<import('child_process').ChildProcess>}
 *   The spawned browser process. Listen to .on('exit') for window close.
 */
async function launch({ url, cacheDir, buildId = 'stable', appName }) {
  const executablePath = await ensureChromium(cacheDir, buildId);

  renameAppBundle(executablePath, appName);

  console.log(`[browser] Launching Chrome for Testing → ${url}`);

  const child = spawn(executablePath, buildLaunchArgs(url), {
    detached: false,    // Keep the browser as a child of this process
    stdio:    'ignore', // Chrome for Testing is chatty; silence it
  });

  child.on('error', (err) => {
    console.error(`[browser] Failed to spawn browser: ${err.message}`);
  });

  return child;
}

module.exports = { launch };
