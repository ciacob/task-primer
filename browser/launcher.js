'use strict';

/**
 * browser/launcher.js
 *
 * Responsible for three things only:
 *   1. Resolving the correct Chromium binary for the current platform
 *   2. Downloading it (once) if not already cached in <cacheDir>
 *   3. Spawning it in --app mode and returning the child process handle
 *
 * The returned handle is a standard Node.js ChildProcess.  Callers can
 * attach .on('exit', ...) to detect window close without any platform
 * detection tricks — Chromium is our process, we spawned it.
 *
 * ── Pinned build ────────────────────────────────────────────────────────────
 *
 *   Product  : Chrome for Testing (not the user-facing consumer Chrome)
 *   Milestone: 124
 *   Build ID : 1274542
 *
 *   Chrome for Testing builds are published by Google specifically for
 *   automation and testing.  They never auto-update, making them safe to
 *   pin.  Build 1274542 is the last stable 124 release and ships binaries
 *   for all supported platforms:
 *
 *     linux    (x64)
 *     mac      (x64)
 *     mac_arm  (Apple Silicon)
 *     win32    (ia32)
 *     win64    (x64)
 *
 *   To update the pin: change BROWSER_CONFIG.buildId (and milestone for
 *   documentation purposes) and delete the old .browsers/ directory.
 *   The new build will be downloaded on the next --ui invocation.
 *
 *   Build ID reference:
 *     https://googlechromelabs.github.io/chrome-for-testing/
 *
 * ── pkg compatibility ────────────────────────────────────────────────────────
 *
 *   The Chromium binary lives in <cacheDir> on disk, outside any bundle.
 *   This file uses only @puppeteer/browsers (pure JS, no native addons)
 *   and Node built-ins.  Both bundle cleanly with pkg.
 *
 *   When packaging with pkg, set cacheDir to a path relative to the
 *   executable (e.g. path.join(path.dirname(process.execPath), '.browsers'))
 *   so the cache survives next to the binary.
 */

const path           = require('path');
const { spawn }      = require('child_process');
const {
  install,
  detectBrowserPlatform,
  computeExecutablePath,
}                    = require('@puppeteer/browsers');

// ─── Pinned browser configuration ────────────────────────────────────────────

const BROWSER_CONFIG = {
  product:   'chrome',   // Chrome for Testing (not chromium OSS)
  buildId:   '1274542',  // Milestone 124 — last stable 124 release
  milestone: 124,        // Informational; not used by the download API
};

// ─── Chromium launch flags ────────────────────────────────────────────────────

/**
 * --app=<url>            Opens in a frameless app window (no address bar,
 *                        no tabs) — this is the flag that makes Chromium
 *                        feel like a native app window rather than a browser.
 *
 * --no-first-run         Skip the "welcome to Chrome" setup screen.
 * --no-default-browser-check  Don't prompt to become the default browser.
 * --disable-extensions   No extensions in this managed window.
 * --disable-translate    No translation prompt.
 *
 * Linux sandbox note:
 *   --no-sandbox is added automatically on Linux when not running as root,
 *   because most CI/container environments disable the kernel namespace
 *   sandboxing that Chromium requires.  Remove it if your environment
 *   supports sandboxing (i.e. you are NOT in a container).
 */
function buildLaunchArgs(url) {
  const args = [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-translate',
  ];

  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return args;
}

// ─── Download helper ─────────────────────────────────────────────────────────

/**
 * Ensure the pinned Chromium build is present in cacheDir.
 * Downloads it if missing, skips silently if already cached.
 *
 * @param {string} cacheDir  Absolute path to the cache directory.
 * @returns {Promise<string>} Absolute path to the Chromium executable.
 */
async function ensureChromium(cacheDir) {
  const platform = detectBrowserPlatform();

  if (!platform) {
    throw new Error(
      'Could not detect a supported platform for Chromium download. ' +
      'Supported: linux, mac, mac_arm, win32, win64.'
    );
  }

  // computeExecutablePath returns the expected path whether or not it exists
  const executablePath = computeExecutablePath({
    cacheDir,
    browser:  BROWSER_CONFIG.product,
    buildId:  BROWSER_CONFIG.buildId,
  });

  const fs = require('fs');
  if (fs.existsSync(executablePath)) {
    return executablePath;   // Already cached — fast path
  }

  // ── First-time download ───────────────────────────────────────────────────
  console.log(
    `[browser] Chromium ${BROWSER_CONFIG.milestone} (build ${BROWSER_CONFIG.buildId}) ` +
    `not found in cache.`
  );
  console.log(`[browser] Downloading for platform: ${platform}`);
  console.log(`[browser] Cache directory: ${cacheDir}`);
  console.log(`[browser] This is a one-time download (~300 MB). Please wait…\n`);

  let lastPercent = -1;

  await install({
    cacheDir,
    browser:  BROWSER_CONFIG.product,
    buildId:  BROWSER_CONFIG.buildId,
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure Chromium is cached, then spawn it in --app mode.
 *
 * @param {object} options
 * @param {string} options.url       The URL to open in the app window.
 * @param {string} options.cacheDir  Absolute path to the Chromium cache dir.
 *
 * @returns {Promise<import('child_process').ChildProcess>}
 *   The spawned Chromium process.  Listen to .on('exit') for window close.
 */
async function launch({ url, cacheDir }) {
  const executablePath = await ensureChromium(cacheDir);

  console.log(`[browser] Launching Chromium → ${url}`);

  const child = spawn(executablePath, buildLaunchArgs(url), {
    detached: false,   // Keep Chromium as a child of this process
    stdio:    'ignore', // Chromium is chatty; silence it
  });

  child.on('error', (err) => {
    console.error(`[browser] Failed to spawn Chromium: ${err.message}`);
  });

  return child;
}

module.exports = { launch, BROWSER_CONFIG };
