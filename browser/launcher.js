'use strict';

/**
 * browser/launcher.js
 *
 * Responsible for five things:
 *   1. Resolving the correct Chrome for Testing binary for the current platform
 *   2. Downloading it (once) if not already cached in <cacheDir>
 *   3. Renaming the .app bundle on macOS (once) so the Dock, menu bar, and
 *      Mission Control show the application's own name
 *   4. Spawning the browser in --app mode with CDP enabled, returning the handle
 *   5. Attaching a CDP client that:
 *        a) emits a 'windowClosed' event when the user closes the browser window
 *        b) injects a navigation guard script into every new page target so the
 *           app window cannot be navigated away from the served origin
 *
 * ── Window close detection via CDP ───────────────────────────────────────────
 *
 *   In --app mode on macOS, clicking the red close button hides the window but
 *   does not necessarily exit the Chrome process. The ChildProcess 'exit' event
 *   only fires on full process termination (Cmd+Q, kill signal, etc.), making
 *   it unsuitable for detecting "user is done with the UI".
 *
 *   Chrome DevTools Protocol (CDP) provides the correct signal:
 *   Target.targetDestroyed fires immediately when the app window is closed,
 *   regardless of whether the underlying process exits.
 *
 *   The launcher:
 *     - Adds --remote-debugging-port=<debugPort> to the launch args
 *     - After spawn, polls the CDP /json/version endpoint until Chrome is ready
 *     - Opens a WebSocket to the browser-level CDP target
 *     - Subscribes to Target.setDiscoverTargets and listens for targetDestroyed
 *     - Emits 'windowClosed' on the ChildProcess handle when the target is gone
 *
 *   Callers should listen to BOTH events for full coverage:
 *     browserProc.on('windowClosed', ...) — window closed (red button)
 *     browserProc.on('exit', ...)         — full process quit (Cmd+Q, kill)
 *
 *   The CDP client is intentionally minimal — no library dependency, just the
 *   'ws' package already present in the project.
 *
 * ── macOS app rename ─────────────────────────────────────────────────────────
 *
 *   Patches CFBundleName and CFBundleDisplayName in the .app bundle's
 *   Info.plist using macOS's built-in plutil tool, then re-registers the
 *   bundle with Launch Services (lsregister) to flush the Dock's name cache.
 *   Both tools are macOS system utilities — no extra dependency.
 *
 *   A sentinel file (<bundle>/Contents/.last-rename) records the last name
 *   written. The patch is skipped if the sentinel matches the desired name.
 *
 *   Note: menu bar *entries* (File, Edit, View, …) are Chrome internals and
 *   cannot be customised. Only the bold app name at the far left is affected.
 *
 * ── Build resolution ─────────────────────────────────────────────────────────
 *
 *   buildId 'stable' is resolved at download time to the current cross-platform
 *   stable release via @puppeteer/browsers. See package.json taskPrimer.browser
 *   for pin/update instructions.
 *
 * ── pkg compatibility ────────────────────────────────────────────────────────
 *
 *   Binary lives in <cacheDir> outside any bundle. This file uses only
 *   @puppeteer/browsers, ws (already a project dependency), and Node built-ins.
 *   All bundle cleanly with pkg.
 */

const path                = require('path');
const fs                  = require('fs');
const http                = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket           = require('ws');
const {
  install,
  resolveBuildId,
  detectBrowserPlatform,
  computeExecutablePath,
} = require('@puppeteer/browsers');

// ─── Launch flags ─────────────────────────────────────────────────────────────

/**
 * Build the Chromium launch argument list.
 *
 * Fixed flags (always applied):
 *   --app=<url>              Frameless app window — no address bar, no tab strip.
 *   --no-first-run           Skip first-launch setup prompts.
 *   --no-default-browser-check  No "make Chrome your default" prompt.
 *   --disable-extensions     No extension UI.
 *   --disable-translate      No translation bar.
 *   --disable-infobars       Suppresses the "Chrome for Testing" notification bar.
 *   --remote-debugging-port  Enables CDP for window-close detection + guard injection.
 *
 * Configurable flags (driven by taskPrimer config in package.json):
 *   --window-size=W,H        Initial window dimensions in CSS pixels.
 *   --window-position=X,Y    Initial window position from top-left of primary screen.
 *
 * DevTools suppression and new-window blocking are handled via CDP target
 * lifecycle management (Target.closeTarget) rather than flags.
 *
 * Linux: --no-sandbox added because most container/CI environments lack the
 * kernel namespace support Chrome's sandbox requires.
 *
 * @param {string} url
 * @param {number} debugPort
 * @param {object} opts
 * @param {number|null} opts.windowWidth
 * @param {number|null} opts.windowHeight
 * @param {number|null} opts.windowX
 * @param {number|null} opts.windowY
 */
function buildLaunchArgs(url, debugPort, opts = {}) {
  const {
    windowWidth  = null,
    windowHeight = null,
    windowX      = null,
    windowY      = null,
  } = opts;

  const args = [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-translate',
    '--disable-infobars',
    `--remote-debugging-port=${debugPort}`,
  ];

  // Window geometry — only applied when both dimensions are provided.
  // --window-size expects integers (CSS pixels); fractional values are truncated.
  if (windowWidth != null && windowHeight != null) {
    args.push(`--window-size=${Math.round(windowWidth)},${Math.round(windowHeight)}`);
  }

  // --window-position is best-effort: reliable on macOS and Windows, may be
  // ignored by some Wayland compositors on Linux.
  if (windowX != null && windowY != null) {
    args.push(`--window-position=${Math.round(windowX)},${Math.round(windowY)}`);
  }

  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  return args;
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * Ensure the requested Chrome for Testing build is present in cacheDir.
 * Downloads if missing; skips silently if already cached.
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
 * Patch Info.plist and flush the Launch Services cache so the Dock, menu bar,
 * and Mission Control all reflect appName instead of "Google Chrome for Testing".
 *
 * No-ops silently on non-macOS. Warns but does not throw on failure.
 *
 * @param {string} executablePath  Absolute path to the browser binary.
 * @param {string} appName         Desired application name.
 */
function renameAppBundle(executablePath, appName) {
  if (process.platform !== 'darwin') { return; }
  if (!appName) { return; }

  // Binary is at <bundle>/Contents/MacOS/<name>
  // Two levels up lands in Contents/, where Info.plist lives.
  const bundleContents = path.resolve(executablePath, '..', '..');
  const bundlePath     = path.resolve(bundleContents, '..');   // the .app itself
  const plistPath      = path.join(bundleContents, 'Info.plist');
  const sentinelPath   = path.join(bundleContents, '.last-rename');

  if (!fs.existsSync(plistPath)) {
    console.warn('[browser] Info.plist not found — skipping app rename.');
    return;
  }

  // Skip if already patched with this exact name
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

    // Flush the Launch Services database so the Dock picks up the new name.
    // lsregister is a macOS system tool — always present, no dependency.
    const lsregister =
      '/System/Library/Frameworks/CoreServices.framework' +
      '/Versions/A/Frameworks/LaunchServices.framework' +
      '/Versions/A/Support/lsregister';

    execSync(`"${lsregister}" -f "${bundlePath}"`);

    // Write sentinel so we don't re-patch on every launch
    fs.writeFileSync(sentinelPath, appName, 'utf8');

    console.log(`[browser] App bundle renamed to "${appName}" (Dock cache flushed).`);
  } catch (err) {
    // Cosmetic failure — warn but don't abort the launch
    console.warn(`[browser] App rename failed (non-fatal): ${err.message}`);
  }
}


// ─── Navigation guard script ──────────────────────────────────────────────────

/**
 * Returns a script string to inject via Page.addScriptToEvaluateOnNewDocument.
 *
 * The script runs before any page code and enforces three categories of
 * restriction, each independently configurable:
 *
 *   Navigation guard (always on):
 *     Prevents the window from navigating away from the served origin.
 *     Covers: location.href/assign/replace, <a> clicks, <form> submits,
 *     and drag-and-drop of foreign URLs.
 *     Same-origin navigation is always allowed.
 *
 *   allowRefresh (default: true):
 *     When false, intercepts Cmd/Ctrl+R and F5 keydown events in the capture
 *     phase so the user cannot manually reload the page.
 *     Note: this does not prevent programmatic location.reload() calls,
 *     which downstream developers may need for legitimate purposes.
 *
 * Config values are baked into the script string at generation time so the
 * injected code has no runtime dependency on any external state.
 *
 * @param {object} opts
 * @param {boolean} opts.allowRefresh     default true
 * @returns {string}
 */
function buildGuardScript({ allowRefresh = true } = {}) {
  return `
(function () {
  'use strict';

  const ALLOWED_ORIGIN     = window.location.origin;
  const ALLOW_REFRESH      = ${allowRefresh};

  function isForeignUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin !== ALLOWED_ORIGIN;
    } catch (_) {
      return false;
    }
  }

  function block(reason, url) {
    console.warn('[task-primer] Blocked (' + reason + '):', url);
    return false;
  }

  // ── window.location property overrides ─────────────────────────────────────
  // We shadow the native location object with a Proxy so assignments to
  // .href and calls to .assign/.replace are intercepted.
  const nativeLocation = window.location;
  const locationProxy  = new Proxy(nativeLocation, {
    set(target, prop, value) {
      if (prop === 'href' && isForeignUrl(value)) {
        return block('location.href', value);
      }
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      if (prop === 'assign') {
        return function (url) {
          if (isForeignUrl(url)) { block('location.assign', url); return; }
          target.assign(url);
        };
      }
      if (prop === 'replace') {
        return function (url) {
          if (isForeignUrl(url)) { block('location.replace', url); return; }
          target.replace(url);
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });

  try {
    Object.defineProperty(window, 'location', {
      get: () => locationProxy,
      configurable: false,
    });
  } catch (_) {
    // Some environments (e.g. sandboxed iframes) disallow this — skip silently
  }

  // ── <a> click interception ──────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;
    if (isForeignUrl(anchor.href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      block('anchor click', anchor.href);
    }
  }, true); // capture phase — runs before any app listener

  // ── <form> submit interception ──────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    const action = e.target.action || window.location.href;
    if (isForeignUrl(action)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      block('form submit', action);
    }
  }, true);

  // ── Drag-and-drop interception ──────────────────────────────────────────────
  // A URL dragged from another window and dropped on the app would normally
  // trigger a navigation. We block the drop entirely; dragover must also be
  // prevented otherwise the browser ignores the drop handler.
  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer && e.dataTransfer.types.includes('text/uri-list')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    }
  }, true);

  document.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.types.includes('text/uri-list')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      block('drag-and-drop', e.dataTransfer.getData('text/uri-list'));
    }
  }, true);


  // ── Refresh interception (allowRefresh) ─────────────────────────────────────
  // Blocks Cmd/Ctrl+R and F5 in the capture phase so they cannot reload the
  // page. Does not affect programmatic location.reload() calls.
  if (!ALLOW_REFRESH) {
    document.addEventListener('keydown', function (e) {
      const isReload = e.key === 'F5' ||
                       ((e.metaKey || e.ctrlKey) && e.key === 'r') ||
                       ((e.metaKey || e.ctrlKey) && e.key === 'R');
      if (isReload) {
        e.preventDefault();
        e.stopImmediatePropagation();
        block('keyboard reload', e.key);
      }
    }, true);
  }

})();
`;
}

// ─── CDP client ───────────────────────────────────────────────────────────────

/**
 * Poll the CDP /json/version endpoint until Chrome is ready.
 *
 * @param {number} port
 * @param {number} [retries=20]
 * @param {number} [delayMs=200]
 * @returns {Promise<string>} The browser-level WebSocket debugger URL.
 */
function waitForCDP(port, retries = 20, delayMs = 200) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const try_ = () => {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            if (info.webSocketDebuggerUrl) {
              resolve(info.webSocketDebuggerUrl);
            } else {
              retry();
            }
          } catch (_) {
            retry();
          }
        });
      }).on('error', retry);
    };

    const retry = () => {
      attempts++;
      if (attempts >= retries) {
        reject(new Error(`CDP not ready after ${retries} attempts on port ${port}`));
        return;
      }
      setTimeout(try_, delayMs);
    };

    try_();
  });
}

/**
 * Attach a CDP client to the browser and emit 'windowClosed' on childProc
 * when the app window's target is destroyed.
 *
 * Uses only the 'ws' package already present in the project — no cdp library.
 *
 * @param {import('child_process').ChildProcess} childProc
 * @param {number} debugPort
 */
async function attachCDP(childProc, debugPort, appUrl, guardOpts, lifeCycleOpts) {
  let wsUrl;
  try {
    wsUrl = await waitForCDP(debugPort);
  } catch (err) {
    console.warn(`[browser] CDP attach failed (non-fatal): ${err.message}`);
    console.warn('[browser] Window-close detection will fall back to process exit.');
    return;
  }

  // ── Browser-level WebSocket (target management + lifecycle events) ───────────

  const browserWs         = new WebSocket(wsUrl);
  let   browserMsgId      = 1;
  const browserPendingCmds = new Map();

  // Promised CDP command on the browser endpoint
  function browserSend(method, params) {
    return new Promise((resolve) => {
      const id = browserMsgId++;
      browserPendingCmds.set(id, resolve);
      browserWs.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  // ── Per-page CDP connection ───────────────────────────────────────────────
  //
  // Rather than multiplexing page-level commands through the browser session
  // (which requires careful sessionId / id namespace management), we connect
  // a dedicated WebSocket directly to each page target's own debugger URL.
  // Chrome exposes these at GET http://127.0.0.1:<port>/json/list.
  // This gives a clean, isolated channel where every command is properly
  // sequenced and responses are unambiguous.

  function getPageTargetWsUrl(debugPort, targetId) {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${debugPort}/json/list`, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            const targets = JSON.parse(body);
            const target  = targets.find(t => t.id === targetId);
            if (target && target.webSocketDebuggerUrl) {
              resolve(target.webSocketDebuggerUrl);
            } else {
              reject(new Error(`No WS URL for target ${targetId}`));
            }
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  // Attach a dedicated WebSocket to a page target, inject the guard, reload.
  const guardedTargets = new Set();

  async function installGuard(targetId) {
    if (guardedTargets.has(targetId)) return;
    guardedTargets.add(targetId);

    console.log('[browser] CDP: connecting to page target', targetId);

    let pageWsUrl;
    try {
      pageWsUrl = await getPageTargetWsUrl(debugPort, targetId);
    } catch (err) {
      console.warn(`[browser] CDP: could not get page WS URL (non-fatal): ${err.message}`);
      return;
    }

    const pageWs         = new WebSocket(pageWsUrl);
    let   pageMsgId      = 1;
    const pagePendingCmds = new Map();

    function pageSend(method, params) {
      return new Promise((resolve) => {
        const id = pageMsgId++;
        pagePendingCmds.set(id, resolve);
        pageWs.send(JSON.stringify({ id, method, params: params || {} }));
      });
    }

    pageWs.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.id !== undefined && pagePendingCmds.has(msg.id)) {
        const resolve = pagePendingCmds.get(msg.id);
        pagePendingCmds.delete(msg.id);
        resolve(msg.result || {});
      }
    });

    await new Promise((resolve, reject) => {
      pageWs.on('open', resolve);
      pageWs.on('error', reject);
    });

    // Sequence matters: enable Page domain first, then register the script,
    // then reload — each step awaited so ordering is guaranteed.
    await pageSend('Page.enable', {});
    await pageSend('Page.addScriptToEvaluateOnNewDocument', {
      source: buildGuardScript(guardOpts),
    });
    await pageSend('Page.reload', { ignoreCache: false });

    console.log('[browser] CDP: navigation guard injected, page reloading');

    // Page WS can be closed after setup — the guard persists in the target
    pageWs.close();
  }

  // ── Browser-level message dispatch ────────────────────────────────────────

  const seenTargets = new Set();

  // The targetId of the page that loaded our app URL. We only emit
  // 'windowClosed' when THIS target is destroyed.
  let appTargetId = null;

  const { devTools = true } = lifeCycleOpts || {};
  const appOrigin = new URL(appUrl).origin;

  // Decide whether a newly created target should be kept or closed immediately.
  // Returns a string reason if it should be closed, null if it should be kept.
  function shouldClose(type, url) {
    // DevTools targets — close when devTools is false
    if (url && url.startsWith('devtools://')) {
      return devTools ? null : 'DevTools suppressed (security.devTools: false)';
    }

    // Non-page targets (service workers, shared workers, etc.) — never close
    if (type !== 'page') return null;

    // Unparseable or blank URL — could be a transient about:blank before
    // navigation. Close it; legitimate same-origin popups will have the
    // actual URL set at targetCreated time.
    let targetOrigin;
    try {
      const parsed = new URL(url);
      // about:blank has origin 'null' as a string — treat as foreign
      targetOrigin = (parsed.origin === 'null' || !parsed.origin) ? null : parsed.origin;
    } catch (_) {
      targetOrigin = null;
    }

    if (!targetOrigin) {
      return 'blank or unparseable URL';
    }

    if (targetOrigin === appOrigin) {
      // Same-origin page target
      return null; // Allowed
    }

    // Foreign-origin page target — always close
    return 'foreign origin (' + targetOrigin + ')';
  }

  browserWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }

    // Resolve browser-level request/response pairs
    if (msg.id !== undefined && browserPendingCmds.has(msg.id)) {
      const resolve = browserPendingCmds.get(msg.id);
      browserPendingCmds.delete(msg.id);
      resolve(msg.result || {});
      return;
    }

    // setDiscoverTargets causes Chrome to emit targetCreated for all existing
    // targets immediately — so this handles both existing and future pages.
    if (msg.method === 'Target.targetCreated') {
      const { targetId, type, url } = msg.params.targetInfo;
      if (seenTargets.has(targetId)) return;
      seenTargets.add(targetId);

      // Identify our app target — the first page at our origin
      if (!appTargetId && type === 'page') {
        try {
          if (new URL(url).origin === appOrigin) {
            appTargetId = targetId;
            console.log('[browser] CDP: identified app target', targetId);
          }
        } catch (_) {}
      }

      // Lifecycle management: close targets we don't want
      const closeReason = shouldClose(type, url);
      if (closeReason) {
        console.log('[browser] CDP: closing target — ' + closeReason);
        browserWs.send(JSON.stringify({
          id:     browserMsgId++,
          method: 'Target.closeTarget',
          params: { targetId },
        }));
        return;
      }

      // Allowed page target — install navigation guard
      if (type === 'page') {
        installGuard(targetId).catch(err => {
          console.warn('[browser] CDP: installGuard error (non-fatal):', err.message);
        });
      }
      return;
    }

    if (msg.method === 'Target.targetDestroyed') {
      const { targetId } = msg.params;

      // Only shut down when the app window itself is destroyed, not when
      // the user closes a DevTools panel or an auxiliary target exits.
      if (targetId !== appTargetId) return;

      console.log('[browser] CDP: app window closed.');
      childProc.emit('windowClosed');
      browserWs.close();
    }
  });

  // ── Startup ───────────────────────────────────────────────────────────────

  browserWs.on('open', () => {
    // setDiscoverTargets immediately fires targetCreated for all existing targets
    // AND keeps firing it for any future ones — one call covers both cases.
    browserWs.send(JSON.stringify({
      id:     browserMsgId++,
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    }));
  });

  // ── Error / close handlers ────────────────────────────────────────────────

  browserWs.on('error', (err) => {
    console.warn(`[browser] CDP WebSocket error (non-fatal): ${err.message}`);
  });

  browserWs.on('close', () => {
    if (childProc && !childProc.killed) {
      childProc.emit('windowClosed');
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure the browser is cached, rename the app bundle if needed, spawn, and
 * attach the CDP window-close detector.
 *
 * @param {object}  options
 * @param {string}  options.url             URL to open in the app window.
 * @param {string}  options.cacheDir        Absolute path to the browser cache dir.
 * @param {string}  options.buildId         Channel name or exact version (default: 'stable').
 * @param {string}  [options.appName]       Desired macOS app name. Null to skip.
 * @param {number}  [options.debugPort]     CDP remote debugging port (default: 9222).
 * @param {number|null} [options.windowWidth]   Initial window width in CSS pixels.
 * @param {number|null} [options.windowHeight]  Initial window height in CSS pixels.
 * @param {number|null} [options.windowX]       Initial window X position.
 * @param {number|null} [options.windowY]       Initial window Y position.
 * @param {boolean} [options.devTools]      Allow DevTools (default: true). When false, DevTools targets are closed immediately via CDP.
 * @param {boolean} [options.allowRefresh]  Allow keyboard page reload (default: true).
 *
 * @returns {Promise<import('child_process').ChildProcess>}
 *   The spawned browser process. Listen to:
 *     .on('windowClosed', fn)  — user closed the app window (red button)
 *     .on('exit', fn)          — full process termination (Cmd+Q, kill)
 */
async function launch({
  url,
  cacheDir,
  buildId         = 'stable',
  appName         = null,
  debugPort       = 9222,
  windowWidth     = null,
  windowHeight    = null,
  windowX         = null,
  windowY         = null,
  devTools        = true,
  allowRefresh    = true,
}) {
  const executablePath = await ensureChromium(cacheDir, buildId);

  renameAppBundle(executablePath, appName);

  console.log(`[browser] Launching Chrome for Testing → ${url}`);

  // Options forwarded to buildLaunchArgs (flag-based, window geometry only)
  const launchOpts    = { windowWidth, windowHeight, windowX, windowY };

  // Options forwarded to buildGuardScript (injected JS restrictions)
  const guardOpts     = { allowRefresh };

  // Options forwarded to attachCDP for target lifecycle management
  const lifeCycleOpts = { devTools };

  const child = spawn(executablePath, buildLaunchArgs(url, debugPort, launchOpts), {
    detached: false,
    stdio:    'ignore',
  });

  child.on('error', (err) => {
    console.error(`[browser] Failed to spawn browser: ${err.message}`);
  });

  // Attach CDP asynchronously — don't block the caller waiting for it
  attachCDP(child, debugPort, url, guardOpts, lifeCycleOpts).catch((err) => {
    console.warn(`[browser] CDP setup error (non-fatal): ${err.message}`);
  });

  return child;
}

module.exports = { launch };
