'use strict';

/**
 * browser/launcher.js
 *
 * Responsible for five things (Chrome for Testing path):
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
 * ── nacre path ────────────────────────────────────────────────────────────────
 *
 *   When taskPrimer.browser.product === 'nacre', this module takes a different
 *   path:
 *     - Resolves the nacre binary at the conventional relative path from the
 *       running executable (process.execPath).
 *     - Spawns the nacre binary, passing --app=<url>, window geometry flags,
 *       and --nacre-socket=<path> so nacre knows where to listen.
 *     - Connects to the nacre Unix domain socket.
 *     - Sends set_url, set_script, set_devtools, and optionally set_menu.
 *     - Returns a fake EventEmitter that emits 'windowClosed' when nacre sends
 *       the window_closed message, and 'exit' when the nacre process exits.
 *       This fake handle is API-compatible with the ChildProcess returned by
 *       the CfT path, so main.js requires zero changes.
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

// ─── Pure helpers (no external dependencies) ─────────────────────────────────
// These are extracted before the external requires so they can be tested
// without node_modules installed.

/**
 * Build the Chromium / WKWebView navigation guard script.
 * Used by both the CfT path (CDP injection) and the nacre path (set_script).
 *
 * @param {object}  opts
 * @param {boolean} opts.allowRefresh  default true
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

  // ── window.location overrides (navigation guard) ────────────────────────────
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
    Object.defineProperty(window, 'location', { get: () => locationProxy, configurable: false });
  } catch (_) {}

  // ── <a> click interception ──────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;
    if (isForeignUrl(anchor.href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      block('anchor click', anchor.href);
    }
  }, true);

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
  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer && e.dataTransfer.types.includes('text/uri-list')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    }
  }, true);

  document.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.types.includes('text/uri-list')) {
      e.preventDefault();
      block('drag-and-drop', e.dataTransfer.getData('text/uri-list'));
    }
  }, true);

  // ── Refresh suppression ─────────────────────────────────────────────────────
  if (!ALLOW_REFRESH) {
    document.addEventListener('keydown', function (e) {
      const isReload = (e.key === 'r' && (e.metaKey || e.ctrlKey)) || e.key === 'F5';
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

/**
 * Derive the conventional path to the nacre binary from the running
 * executable's location.
 *
 * Convention (set by the orchestrator build script):
 *
 *   MyApp.app/
 *     Contents/
 *       MacOS/
 *         myapp                ← process.execPath
 *       Resources/
 *         <appName>.app/
 *           Contents/
 *             MacOS/
 *               nacre          ← always this relative path
 *
 * @param {string} appName  Value of taskPrimer.appName in package.json.
 * @returns {string}        Absolute path to the nacre binary.
 */
function resolveNacreBinaryPath(appName) {
  return path.resolve(
    path.dirname(process.execPath),
    `../Resources/${appName}.app/Contents/MacOS/nacre`
  );
}

/**
 * Derive the nacre Unix domain socket path from the app's bundle identifier.
 *
 * Must match the formula used by nacre's SocketPathHelper.defaultPath():
 *   /tmp/<bundleId>/menu.sock
 *
 * @param {string} bundleId  Value of taskPrimer.appBundleId in package.json.
 * @returns {string}
 */
function nacreSocketPath(bundleId) {
  return `/tmp/${bundleId}/menu.sock`;
}

// ─── External dependencies (loaded below pure helpers) ────────────────────────

const path                = require('path');
const fs                  = require('fs');
const http                = require('http');
const { spawn }           = require('child_process');
const { EventEmitter }    = require('events');
const net                 = require('net');

// ws and @puppeteer/browsers are lazy-required inside the functions that use
// them so that the pure helper functions (buildGuardScript, resolveNacreBinaryPath,
// nacreSocketPath) can be imported and tested without node_modules installed.
function requireWS()          { return require('ws'); }
function requirePuppeteer()   { return require('@puppeteer/browsers'); }

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
 * Find any existing Chrome for Testing executable in cacheDir, regardless of
 * version. Used when autoUpdate is false — we use whatever is already cached
 * rather than resolving the channel and potentially triggering a new download.
 *
 * Returns the executable path if a build is found, null otherwise.
 *
 * Cache layout: <cacheDir>/chrome/<platform>-<buildId>/chrome-<platform>/...
 *
 * @param {string} cacheDir
 * @param {string} platform
 * @returns {string|null}
 */
function findAnyCachedBuild(cacheDir, platform) {
  const chromeDir = path.join(cacheDir, 'chrome');
  if (!fs.existsSync(chromeDir)) return null;

  // Each entry is a directory named "<platform>-<buildId>"
  const entries = fs.readdirSync(chromeDir).filter((e) => {
    return e.startsWith(platform + '-') &&
           fs.statSync(path.join(chromeDir, e)).isDirectory();
  });

  if (entries.length === 0) return null;

  // If multiple builds are cached, use the most recently modified one
  entries.sort((a, b) => {
    const ta = fs.statSync(path.join(chromeDir, a)).mtimeMs;
    const tb = fs.statSync(path.join(chromeDir, b)).mtimeMs;
    return tb - ta;
  });

  const buildId     = entries[0].slice(platform.length + 1); // strip "<platform>-"
  const { computeExecutablePath: _cep } = requirePuppeteer();
  const execPath    = _cep({ cacheDir, browser: 'chrome', buildId });

  return fs.existsSync(execPath) ? execPath : null;
}

/**
 * Ensure the requested Chrome for Testing build is present in cacheDir.
 *
 * autoUpdate behaviour:
 *   false (default) — if any build is already cached, use it without touching
 *                     the network. Only downloads on a completely empty cache.
 *                     The developer controls updates by deleting .browsers/ or
 *                     temporarily setting autoUpdate: true.
 *   true            — resolves the channel (e.g. 'stable') to the current
 *                     release and downloads it if the resolved version is not
 *                     already cached. Old builds are not deleted automatically.
 *
 * @param {string}  cacheDir
 * @param {string}  buildId     Channel name ('stable') or exact version string.
 * @param {boolean} autoUpdate  Whether to check for a newer version.
 * @returns {Promise<string>}   Absolute path to the browser executable.
 */
async function ensureChromium(cacheDir, buildId, autoUpdate) {
  const { install, resolveBuildId, detectBrowserPlatform, computeExecutablePath } = requirePuppeteer();
  const platform = detectBrowserPlatform();

  if (!platform) {
    throw new Error(
      'Could not detect a supported platform for Chrome for Testing download. ' +
      'Supported: linux64, mac-arm64, mac-x64, win32, win64.'
    );
  }

  // autoUpdate: false — use any cached build, skip network entirely
  if (!autoUpdate) {
    const cached = findAnyCachedBuild(cacheDir, platform);
    if (cached) {
      console.log('[browser] Using cached build (autoUpdate: false):', cached);
      return cached;
    }
    // Cache is empty — fall through to download regardless of autoUpdate setting
    console.log('[browser] No cached build found — downloading for the first time…');
  }

  const resolvedBuildId = await resolveBuildId('chrome', platform, buildId);

  const executablePath = computeExecutablePath({
    cacheDir,
    browser: 'chrome',
    buildId: resolvedBuildId,
  });

  if (fs.existsSync(executablePath)) {
    return executablePath;
  }

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

// ─── shouldCloseTarget (pure helper, also used by attachCDP) ────────────────

/**
 * Decide whether a CDP target should be closed immediately after it is created.
 *
 * Extracted as a pure top-level function so it can be unit-tested independently
 * of the CDP connection lifecycle.
 *
 * @param {string}  type        CDP target type ('page', 'other', …)
 * @param {string}  url         Target URL at creation time.
 * @param {string}  appOrigin   The served app origin (e.g. 'http://127.0.0.1:3000').
 * @param {boolean} devTools    Whether DevTools windows should be allowed.
 * @returns {string|null}  Reason string to close, or null to keep.
 */
function shouldCloseTarget(type, url, appOrigin, devTools) {
  // DevTools targets
  if (url && url.startsWith('devtools://')) {
    return devTools ? null : 'DevTools suppressed (security.devTools: false)';
  }

  // Non-page targets (service workers, shared workers, etc.) — never close
  if (type !== 'page') return null;

  // Blank or unparseable URL — transient about:blank before navigation.
  // Close it; legitimate same-origin popups arrive with their actual URL set.
  let targetOrigin;
  try {
    const parsed = new URL(url);
    targetOrigin = (parsed.origin === 'null' || !parsed.origin) ? null : parsed.origin;
  } catch (_) {
    targetOrigin = null;
  }

  if (!targetOrigin) return 'blank or unparseable URL';
  if (targetOrigin === appOrigin) return null;  // same-origin — allowed
  return 'foreign origin (' + targetOrigin + ')';
}

// ─── CDP attach (CfT path only) ───────────────────────────────────────────────

/**
 * Poll the CDP /json/version HTTP endpoint until Chrome is ready to accept
 * WebSocket connections.
 *
 * @param {number} port        CDP debug port.
 * @param {number} maxWaitMs   Timeout in milliseconds (default 10 s).
 * @returns {Promise<string>}  The browser-level WebSocket debugger URL.
 */
function waitForCDP(port, maxWaitMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;

    function attempt() {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const { webSocketDebuggerUrl } = JSON.parse(body);
            if (webSocketDebuggerUrl) return resolve(webSocketDebuggerUrl);
          } catch (_) {}
          retry();
        });
      }).on('error', retry);
    }

    function retry() {
      if (Date.now() >= deadline) {
        return reject(new Error(`CDP not ready on port ${port} after ${maxWaitMs} ms`));
      }
      setTimeout(attempt, 200);
    }

    attempt();
  });
}

/**
 * Install the navigation guard into a specific CDP page target.
 *
 * @param {string} targetId
 * @param {number} debugPort
 * @param {string} guardScript
 */
async function installGuard(targetId, debugPort, guardScript) {
  const wsUrl = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${debugPort}/json`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const targets = JSON.parse(body);
          const t = targets.find((t) => t.id === targetId);
          if (t && t.webSocketDebuggerUrl) return resolve(t.webSocketDebuggerUrl);
          reject(new Error('Target not found in /json'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  await new Promise((resolve, reject) => {
    const WebSocket = requireWS();
    const pageWs   = new WebSocket(wsUrl);
    let   msgId    = 1;

    pageWs.once('open', () => {
      pageWs.send(JSON.stringify({
        id:     msgId++,
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: guardScript },
      }));
    });

    pageWs.once('message', () => {
      pageWs.close();
      resolve();
    });

    pageWs.once('error', reject);
  });
}

/**
 * Attach a CDP client to the running Chrome instance.
 * Manages target lifecycle and emits 'windowClosed' on childProc.
 *
 * @param {ChildProcess} childProc
 * @param {number}       debugPort
 * @param {string}       appUrl
 * @param {object}       guardOpts       { allowRefresh }
 * @param {object}       lifeCycleOpts   { devTools }
 */
async function attachCDP(childProc, debugPort, appUrl, guardOpts, lifeCycleOpts) {
  const browserWsUrl      = await waitForCDP(debugPort);
  const WebSocket         = requireWS();
  const browserWs         = new WebSocket(browserWsUrl);
  let   browserMsgId      = 1;
  const browserPendingCmds = new Map();

  const guardScript = buildGuardScript(guardOpts);

  function browserSend(method, params = {}) {
    return new Promise((resolve) => {
      const id = browserMsgId++;
      browserPendingCmds.set(id, resolve);
      browserWs.send(JSON.stringify({ id, method, params }));
    });
  }

  async function installGuardForTarget(targetId) {
    try {
      await installGuard(targetId, debugPort, guardScript);
    } catch (err) {
      console.warn('[browser] CDP: installGuard error (non-fatal):', err.message);
    }
  }

  // ── Browser-level message dispatch ────────────────────────────────────────

  const seenTargets = new Set();

  // The targetId of the page that loaded our app URL. We only emit
  // 'windowClosed' when THIS target is destroyed.
  let appTargetId = null;

  const { devTools = true } = lifeCycleOpts || {};
  const appOrigin = new URL(appUrl).origin;

  // Decide whether a newly created target should be kept or closed immediately.
  // Delegated to the exported pure function; closured vars are passed explicitly.
  function shouldClose(type, url) {
    return shouldCloseTarget(type, url, appOrigin, devTools);
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
        installGuardForTarget(targetId);
      }
      return;
    }

    if (msg.method === 'Target.targetDestroyed') {
      const { targetId } = msg.params;

      // Only shut down when the app window itself is destroyed
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

// ─── nacre path ───────────────────────────────────────────────────────────────

/**
 * Connect to nacre's Unix domain socket, retrying until the socket file
 * appears (nacre may take a moment to start up).
 *
 * @param {string} socketPath
 * @param {number} maxWaitMs   Timeout in milliseconds (default 10 s).
 * @returns {Promise<net.Socket>}
 */
function connectToNacre(socketPath, maxWaitMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;

    function attempt() {
      const sock = net.createConnection(socketPath);

      sock.once('connect', () => resolve(sock));

      sock.once('error', (err) => {
        sock.destroy();
        if (Date.now() >= deadline) {
          return reject(new Error(
            `Could not connect to nacre socket at "${socketPath}" ` +
            `after ${maxWaitMs} ms: ${err.message}`
          ));
        }
        setTimeout(attempt, 200);
      });
    }

    attempt();
  });
}

/**
 * Spawn the nacre binary and wire up the socket protocol.
 *
 * Returns a fake EventEmitter that is API-compatible with the ChildProcess
 * returned by the CfT launch() function.  main.js uses only:
 *   .on('windowClosed', fn)
 *   .on('exit', fn)
 *   .pid
 *   .killed  (checked in shutdown())
 *   .kill()  (called in shutdown())
 *
 * @param {object}      options
 * @param {string}      options.url            URL to load in WKWebView.
 * @param {string}      options.appName        taskPrimer.appName — used to resolve nacre path.
 * @param {string}      options.appBundleId    taskPrimer.appBundleId — used for socket path.
 * @param {number|null} options.windowWidth    Initial window width.
 * @param {number|null} options.windowHeight   Initial window height.
 * @param {number|null} options.windowX        Initial window X.
 * @param {number|null} options.windowY        Initial window Y.
 * @param {boolean}     options.devTools       Whether to enable Web Inspector (default false).
 * @param {boolean}     options.allowRefresh   Whether to allow Cmd+R reload (default true).
 * @returns {Promise<EventEmitter>}  Fake browser handle.
 */
async function launchNacre({
  url,
  appName,
  appBundleId,
  windowWidth  = null,
  windowHeight = null,
  windowX      = null,
  windowY      = null,
  devTools     = false,
  allowRefresh = true,
}) {
  const nacreBin    = resolveNacreBinaryPath(appName);
  const sockPath    = nacreSocketPath(appBundleId);

  // Build argv to pass to nacre — all standard CfT flags nacre already
  // understands, plus --nacre-socket so it knows where to listen.
  const nacreArgs = [
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-translate',
    '--disable-infobars',
    `--nacre-socket=${sockPath}`,
  ];

  if (windowWidth != null && windowHeight != null) {
    nacreArgs.push(`--window-size=${Math.round(windowWidth)},${Math.round(windowHeight)}`);
  }
  if (windowX != null && windowY != null) {
    nacreArgs.push(`--window-position=${Math.round(windowX)},${Math.round(windowY)}`);
  }

  console.log(`[browser] Launching nacre → ${url}`);

  const child = spawn(nacreBin, nacreArgs, {
    detached: false,
    stdio:    'ignore',
  });

  child.on('error', (err) => {
    console.error(`[browser] Failed to spawn nacre: ${err.message}`);
  });

  // Create the fake handle that main.js will use.
  // We proxy .pid, .killed, and .kill() from the real child process.
  const handle = new EventEmitter();
  Object.defineProperty(handle, 'pid',    { get: () => child.pid });
  Object.defineProperty(handle, 'killed', { get: () => child.killed });
  handle.kill = (signal) => child.kill(signal);

  // Forward the real process exit event
  child.on('exit', (code, signal) => {
    handle.emit('exit', code, signal);
  });

  // Connect to the nacre socket and set up the protocol
  let sock;
  try {
    sock = await connectToNacre(sockPath);
    console.log(`[browser] Connected to nacre socket at ${sockPath}`);
  } catch (err) {
    console.warn(`[browser] nacre socket connection failed: ${err.message}`);
    return handle;
  }

  // Newline-delimited JSON framing — same protocol as nacre's SocketServer
  function sendToNacre(message) {
    try {
      sock.write(JSON.stringify(message) + '\n');
    } catch (err) {
      console.warn(`[browser] nacre socket write error: ${err.message}`);
    }
  }

  // Send initial configuration messages
  sendToNacre({ type: 'set_url',      url });
  sendToNacre({ type: 'set_devtools', enabled: devTools });
  sendToNacre({ type: 'set_script',   script: buildGuardScript({ allowRefresh }) });

  // Build the NacreUI instance that owns this socket for outbound sends
  // and delivers inbound events to main.js.
  const { NacreUI } = require('./nacre-ui');
  const ui = new NacreUI(sock);

  // Handle inbound messages from nacre — route through NacreUI
  let buffer = '';
  sock.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch (_) { continue; }

      // Deliver to NacreUI (emits menuAction, fileOpen, appReopen, windowClosed)
      ui._handleInbound(msg);

      // Also emit windowClosed on the process handle so main.js --autoexit works
      if (msg.type === 'window_closed') {
        console.log('[browser] nacre: window closed');
        handle.emit('windowClosed');
      }
    }
  });

  sock.on('error', (err) => {
    console.warn(`[browser] nacre socket error: ${err.message}`);
  });

  sock.on('close', () => {
    console.log('[browser] nacre socket closed');
    // If the socket closes unexpectedly, treat it as a window close
    handle.emit('windowClosed');
    ui.emit('windowClosed');
  });

  // Return both the process handle (for main.js lifecycle management)
  // and the NacreUI instance (for UI driving and event observation).
  return { handle, ui };
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
 * @param {boolean} [options.autoUpdate]    Re-download if a newer stable is available (default: false).
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
  autoUpdate      = false,
  debugPort       = 9222,
  windowWidth     = null,
  windowHeight    = null,
  windowX         = null,
  windowY         = null,
  devTools        = true,
  allowRefresh    = true,
}) {
  const executablePath = await ensureChromium(cacheDir, buildId, autoUpdate);


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

module.exports = { launch, launchNacre, buildGuardScript, buildLaunchArgs, shouldCloseTarget, resolveNacreBinaryPath, nacreSocketPath };
