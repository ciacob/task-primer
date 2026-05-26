'use strict';

/**
 * browser/launcher.js
 *
 * Responsible for three things only:
 *   1. Resolving the correct Chromium binary for the current platform
 *   2. Downloading it (once) if not already cached in <cacheDir>
 *   3. Spawning it in --app mode and returning the child process handle
 *
 * The returned handle is a standard Node.js ChildProcess. Callers attach
 * .on('exit', ...) to detect window close without any platform heuristics —
 * Chromium is our direct child process, so exit detection is reliable.
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
 *   that works on one platform and silently 404s on another (as we discovered)
 *   is a maintenance trap.
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
 * ── pkg compatibility ────────────────────────────────────────────────────────
 *
 *   The Chromium binary lives in <cacheDir> on disk, outside any bundle.
 *   This file uses only @puppeteer/browsers (pure JS, no native addons)
 *   and Node built-ins. Both bundle cleanly with pkg.
 *
 *   When packaging with pkg, set cacheDir to a path relative to the
 *   executable (e.g. path.join(path.dirname(process.execPath), '.browsers'))
 *   so the cache survives next to the binary rather than relative to __dirname.
 */

const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  computeExecutablePath,
} = require('@puppeteer/browsers');

// ─── Chromium launch flags ────────────────────────────────────────────────────

/**
 * --app=<url>
 *   Opens in a frameless app window — no address bar, no tab strip.
 *   This is the flag that makes Chromium behave like a native app window
 *   rather than a browser. It also ensures a single, clean process tree.
 *
 * --no-first-run / --no-default-browser-check
 *   Suppress first-launch prompts that would block or distract the user.
 *
 * --disable-extensions / --disable-translate
 *   Keep the window clean; no extension UI, no translation prompts.
 *
 * Linux sandbox note:
 *   --no-sandbox is added on Linux because most container and CI environments
 *   disable the kernel namespacing that Chromium's sandbox requires.
 *   Remove it if your Linux environment supports user namespaces.
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
 * Ensure the requested Chromium build is present in cacheDir.
 * Downloads it if missing; skips silently if already cached.
 *
 * @param {string} cacheDir   Absolute path to the cache directory.
 * @param {string} buildId    Channel name ('stable') or exact version string.
 * @returns {Promise<string>} Absolute path to the Chromium executable.
 */
async function ensureChromium(cacheDir, buildId) {
  const platform = detectBrowserPlatform();

  if (!platform) {
    throw new Error(
      'Could not detect a supported platform for Chromium download. ' +
      'Supported: linux64, mac-arm64, mac-x64, win32, win64.'
    );
  }

  // Resolve channel names ('stable', 'beta', etc.) to concrete version strings.
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
  console.log(
    `[browser] Chrome for Testing ${resolvedBuildId} not found in cache.`
  );
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure Chromium is cached, then spawn it in --app mode.
 *
 * @param {object} options
 * @param {string} options.url      The URL to open in the app window.
 * @param {string} options.cacheDir Absolute path to the Chromium cache dir.
 * @param {string} options.buildId  Channel name or exact version (default: 'stable').
 *
 * @returns {Promise<import('child_process').ChildProcess>}
 *   The spawned Chromium process. Listen to .on('exit') for window close.
 */
async function launch({ url, cacheDir, buildId = 'stable' }) {
  const executablePath = await ensureChromium(cacheDir, buildId);

  console.log(`[browser] Launching Chrome for Testing → ${url}`);

  const child = spawn(executablePath, buildLaunchArgs(url), {
    detached: false,   // Keep Chromium as a child of this process
    stdio:    'ignore', // Chromium is chatty on stdout/stderr; silence it
  });

  child.on('error', (err) => {
    console.error(`[browser] Failed to spawn Chromium: ${err.message}`);
  });

  return child;
}

module.exports = { launch };
