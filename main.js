'use strict';

/**
 * main.js
 *
 * The process orchestrator. Entry point for the application.
 *
 * Responsibilities:
 *   - Parse CLI arguments (yargs)
 *   - Fork the worker process and the server process
 *   - Be the single source of truth for worker state
 *   - Route commands: REST (via server IPC) → worker IPC
 *   - Route events:   worker IPC → server IPC (→ WebSocket → browser)
 *   - Handle worker crash/restart policy
 *   - Optionally download + launch the pinned Chromium build (--ui)
 *   - Optionally exit when the browser window is closed (--autoexit)
 *   - Graceful shutdown on SIGINT / SIGTERM
 *
 * Process topology:
 *
 *   main.js  (this file)
 *   ├── worker/worker-process.js   (child_process.fork)
 *   ├── server/server-process.js   (child_process.fork)
 *   └── Chromium --app             (child_process.spawn, only with --ui)
 *
 * Main never imports Fastify, worker logic, or task modules directly.
 * All cross-process communication is via IPC message envelopes defined
 * in shared/messages.js.
 */

const { fork, execFileSync } = require('child_process');
const path        = require('path');
const yargs       = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { CMD, EVT, SRV, UI_CMD, INTERNAL, STATE, msg } = require('./shared/messages');

// ─── CLI arguments ────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .option('ui', {
    type:        'boolean',
    default:     false,
    description: 'Download (once) and launch the pinned Chromium build as an app window',
  })
  .option('autoexit', {
    type:        'boolean',
    default:     false,
    description: 'Exit the application when the Chromium window is closed (requires --ui)',
  })
  .option('worker-crash', {
    choices:     ['restart', 'report'],
    default:     'report',
    description: 'Behaviour when the worker process crashes unexpectedly',
  })
  .check((argv) => {
    if (argv.autoexit && !argv.ui) {
      throw new Error('--autoexit requires --ui (there is no browser process to watch without it)');
    }
    return true;
  })
  .help()
  .argv;

const WORKER_CRASH_POLICY = argv['workerCrash'] || argv['worker-crash'];

// Resolved in boot() after port-picking; used everywhere thereafter.
let SERVER_URL = '';
let WEB_PORT   = 0;
let WEB_HOST   = '127.0.0.1';

// ─── Shared worker state (owned by main) ─────────────────────────────────────

let workerState = {
  state:   STATE.IDLE,
  message: null,
  percent: null,
};

// ─── Process handles ──────────────────────────────────────────────────────────

let workerProc  = null;
let serverProc  = null;
let browserProc = null;   // Only set when --ui is active
let nacreUI     = null;   // NacreUI instance (nacre mode) or NacreUIStub (CfT/npm mode)

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(scope, ...args) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[${ts}] [${scope}]`, ...args);
}

// ─── State management ─────────────────────────────────────────────────────────

function updateState(patch) {
  workerState = { ...workerState, ...patch };
  if (serverProc && serverProc.connected) {
    serverProc.send(msg(SRV.STATE_PUSH, workerState));
  }
}

// ─── Fork: worker ─────────────────────────────────────────────────────────────

function spawnWorker() {
  const wp = fork(path.join(__dirname, 'worker', 'worker-process.js'), [], {
    silent: false,
  });

  wp.on('message', (envelope) => {
    if (!envelope || !envelope.type) return;

    switch (envelope.type) {

      case EVT.READY:
        log('worker', 'ready');
        updateState({ state: STATE.IDLE, message: 'Worker ready' });
        // Inform the worker whether we are in nacre mode so context.ui.isNacre
        // is accurate before the first task is assigned. nacreUI is set during
        // launchBrowser(); if --ui was not passed it stays null (not nacre).
        if (workerProc && workerProc.connected) {
          workerProc.send(
            msg(INTERNAL.SET_IS_NACRE, { isNacre: nacreUI ? nacreUI.isNacre : false })
          );
        }
        break;

      case EVT.STATUS_UPDATE:
        log('worker', 'status →', envelope.payload?.state);
        updateState({
          state:   envelope.payload?.state   ?? workerState.state,
          message: envelope.payload?.message ?? workerState.message,
        });
        break;

      case EVT.TASK_PROGRESS:
        updateState({
          percent: envelope.payload?.percent ?? workerState.percent,
          message: envelope.payload?.message ?? workerState.message,
        });
        break;

      case EVT.TASK_DONE:
        log('worker', 'task done', envelope.payload);
        updateState({ state: STATE.DONE, message: 'Task completed', percent: 100 });
        break;

      case EVT.TASK_ERROR:
        log('worker', 'ERROR:', envelope.payload?.message);
        if (envelope.payload?.stack) log('worker', envelope.payload.stack);
        updateState({ state: STATE.ERROR, message: envelope.payload?.message });
        break;

      // ── UI commands from worker (worker → main → nacre) ──────────────────
      // These arrive when task modules call context.ui.setMenu() etc.
      // nacreUI is always set by the time the worker is running:
      //   nacre mode → real NacreUI wrapping the socket
      //   CfT mode   → NacreUIStub that logs a no-op warning

      case UI_CMD.SET_MENU:
        if (nacreUI) nacreUI.setMenu(envelope.payload?.menus);
        break;

      case UI_CMD.PATCH_MENU:
        if (nacreUI) nacreUI.patchMenu(envelope.payload?.patches);
        break;

      case UI_CMD.SET_DEVTOOLS:
        if (nacreUI) nacreUI.setDevTools(envelope.payload?.enabled);
        break;

      default:
        log('worker', 'unknown event type:', envelope.type);
    }
  });

  wp.on('exit', (code, signal) => {
    log('worker', `exited (code=${code}, signal=${signal})`);

    if (WORKER_CRASH_POLICY === 'restart') {
      log('worker', 'restarting per --worker-crash=restart policy…');
      updateState({ state: STATE.ERROR, message: 'Worker crashed — restarting' });
      setTimeout(() => { workerProc = spawnWorker(); }, 1000);
    } else {
      updateState({ state: STATE.ERROR, message: `Worker exited (code=${code})` });
    }
  });

  return wp;
}

// ─── Fork: server ─────────────────────────────────────────────────────────────

function spawnServer() {
  const sp = fork(path.join(__dirname, 'server', 'server-process.js'), [], {
    silent: false,
    env: {
      ...process.env,
      SERVER_PORT: String(WEB_PORT),
      SERVER_HOST: WEB_HOST,
    },
  });

  sp.on('message', (envelope) => {
    if (!envelope || !envelope.type) return;

    switch (envelope.type) {

      case SRV.READY:
        log('server', `listening on ${SERVER_URL}`);
        // Launch browser only after the server confirms it is ready,
        // so Chromium never hits a "connection refused" on first load.
        if (argv.ui) launchBrowser();
        break;

      case SRV.FORWARD_CMD: {
        const inner = envelope.payload;
        if (!inner || !inner.type) return;
        log('main', `routing command ${inner.type} → worker`);
        if (workerProc && workerProc.connected) {
          workerProc.send(inner);
        } else {
          log('main', 'worker not available to receive command');
        }
        break;
      }

      default:
        log('server', 'unknown message type:', envelope.type);
    }
  });

  sp.on('exit', (code) => {
    log('server', `exited (code=${code})`);
  });

  return sp;
}

// ─── Browser launch (--ui) ────────────────────────────────────────────────────

async function launchBrowser() {
  const { launch, launchNacre }       = require('./browser/launcher');
  const { NacreUIStub }               = require('./browser/nacre-ui');
  const { UI_CMD, NOTIFY }            = require('./shared/messages');

  // Read config from package.json (taskPrimer.*) so all browser options
  // are configurable without touching code. cacheDir is resolved relative
  // to the project root; see README for the pkg packaging note.
  const taskPrimerCfg = require('./package.json').taskPrimer || {};
  const browserCfg    = taskPrimerCfg.browser   || {};
  const windowCfg     = taskPrimerCfg.window    || {};
  const securityCfg   = taskPrimerCfg.security  || {};

  // Window geometry — null means "let the browser decide"
  const windowWidth    = windowCfg.width  != null ? windowCfg.width  : null;
  const windowHeight   = windowCfg.height != null ? windowCfg.height : null;
  const windowX        = windowCfg.x      != null ? windowCfg.x      : null;
  const windowY        = windowCfg.y      != null ? windowCfg.y      : null;

  // Security defaults are dev-friendly (everything allowed)
  const devTools        = securityCfg.devTools        !== false;
  const allowRefresh    = securityCfg.allowRefresh    !== false;

  // ── nacre path ─────────────────────────────────────────────────────────────
  // When browser.product === 'nacre', spawn the embedded nacre binary and
  // drive it over the Unix socket protocol instead of CDP.
  // launchNacre() returns a fake EventEmitter that is API-compatible with the
  // ChildProcess returned by launch() below, so the rest of this function and
  // all of main.js are unchanged.

  if (browserCfg.product === 'nacre') {
    const appName     = taskPrimerCfg.appName     || null;
    const appBundleId = taskPrimerCfg.appBundleId || null;

    if (!appName || !appBundleId) {
      log('browser', 'nacre path requires taskPrimer.appName and taskPrimer.appBundleId in package.json');
      return;
    }

    try {
      const result = await launchNacre({
        url: SERVER_URL, appName, appBundleId,
        windowWidth, windowHeight, windowX, windowY,
        devTools, allowRefresh,
      });

      browserProc = result.handle;
      nacreUI     = result.ui;

      log('browser', `nacre launched (pid=${browserProc.pid})`);

      // Forward nacre UI events to the worker as NOTIFY messages so task
      // modules can observe them via context.ui.on*() handlers.
      nacreUI.on('menuAction', (id) => {
        log('browser', `menu_action: "${id}"`);
        if (workerProc && workerProc.connected) {
          workerProc.send(msg(NOTIFY.MENU_ACTION, { id }));
        }
      });
      nacreUI.on('fileOpen', (paths) => {
        log('browser', `file_open: ${JSON.stringify(paths)}`);
        if (workerProc && workerProc.connected) {
          workerProc.send(msg(NOTIFY.FILE_OPEN, { paths }));
        }
      });
      nacreUI.on('appReopen', () => {
        log('browser', 'app_reopen');
        if (workerProc && workerProc.connected) {
          workerProc.send(msg(NOTIFY.APP_REOPEN));
        }
      });

    } catch (err) {
      log('browser', `nacre launch failed: ${err.message}`);
      log('browser', `open manually: ${SERVER_URL}`);
      return;
    }

  // ── Chrome for Testing path (unchanged) ───────────────────────────────────
  } else {
    // Use a no-op stub so UI_CMD messages from the worker are handled
    // gracefully (logged as no-ops) even in CfT mode.
    nacreUI = new NacreUIStub();
    const cacheDir  = path.resolve(__dirname, browserCfg.cacheDir || '.browsers');
    const buildId   = browserCfg.buildId   || 'stable';
    const autoUpdate = browserCfg.autoUpdate === true;
    const appName   = taskPrimerCfg.appName || null;
    const debugPort = browserCfg.debugPort != null ? browserCfg.debugPort : 9222;

    try {
      browserProc = await launch({
        url: SERVER_URL, cacheDir, buildId, autoUpdate, appName, debugPort,
        windowWidth, windowHeight, windowX, windowY,
        devTools, allowRefresh,
      });

        log('browser', `launched (pid=${browserProc.pid}, cdp=:${debugPort})`);
    } catch (err) {
      log('browser', `launch failed: ${err.message}`);
      log('browser', `open manually: ${SERVER_URL}`);
      return;
    }
  }

  // ── Shared event wiring (nacre and CfT paths both land here) ──────────────
  // browserProc is either a real ChildProcess (CfT) or a fake EventEmitter
  // (nacre) — both expose .on('windowClosed') and .on('exit').

  // 'windowClosed' is emitted by the CDP client in launcher.js when the
  // user closes the app window via the red button. This is the primary
  // signal for --autoexit and fires before (or instead of) 'exit'.
  browserProc.on('windowClosed', () => {
    log('browser', 'window closed');
    if (argv.autoexit) {
      log('main', '--autoexit: browser window closed, shutting down');
      shutdown('browser-exit');
    }
  });

  // 'exit' fires on full process termination (Cmd+Q, kill signal).
  // Guard with a flag so we don't double-shutdown if 'windowClosed' already ran.
  let shuttingDown = false;
  browserProc.on('exit', (code, signal) => {
    log('browser', `process exited (code=${code}, signal=${signal})`);
    if (argv.autoexit && !shuttingDown) {
      shuttingDown = true;
      log('main', '--autoexit: browser process exited, shutting down');
      shutdown('browser-exit');
    }
  });

  // Set the flag when windowClosed fires so exit doesn't double-trigger
  browserProc.on('windowClosed', () => { shuttingDown = true; });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(reason) {
  log('main', `shutting down (reason: ${reason})`);

  // Kill browser first — if Chromium is still open and we kill the server,
  // the user would see a broken page rather than the window just closing.
  if (browserProc && !browserProc.killed) {
    try { browserProc.kill(); } catch (_) {}
  }
  if (workerProc) { try { workerProc.kill(); } catch (_) {} }
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }

  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Boot sequence ────────────────────────────────────────────────────────────

async function boot() {

  // ── Port resolution ──────────────────────────────────────────────────────
  // Priority: CLI flag → package.json → auto-pick (first --ui run)
  const pkg    = require('./package.json');
  const tp     = pkg.taskPrimer || {};
  const pkgWeb = tp.webPort;
  const pkgDbg = tp.browser && tp.browser.debugPort;

  // In the nacre path there is no debugPort — only webPort needs to be set.
  // In the CfT path both ports must be set.
  const isNacrePath = tp.browser && tp.browser.product === 'nacre';
  const portsReady  = isNacrePath ? pkgWeb != null : (pkgWeb != null && pkgDbg != null);

  // If ports are not yet set, run pickPorts.js.
  // In the nacre path this still writes a debugPort (harmlessly) because
  // pickPorts.js always picks two ports. That is fine.
  if (!portsReady) {
    log('main', 'ports not set — running pickPorts.js…');
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'pickPorts.js')], {
        stdio: 'inherit',
      });
    } catch (err) {
      log('main', `pickPorts failed: ${err.message} — using fallback defaults`);
    }
    // Re-read package.json after pickPorts may have written to it
    delete require.cache[require.resolve('./package.json')];
  }

  // Resolve final values from package.json (written by pickPorts.js)
  const freshPkg = require('./package.json').taskPrimer || {};
  WEB_PORT   = freshPkg.webPort  || 3000;
  WEB_HOST   = freshPkg.webHost  || '127.0.0.1';

  SERVER_URL = `http://${WEB_HOST}:${WEB_PORT}`;

  log('main', [
    `starting`,
    `port=${WEB_PORT}`,
    `host=${WEB_HOST}`,
    `ui=${argv.ui}`,
    `autoexit=${argv.autoexit}`,
    `worker-crash=${WORKER_CRASH_POLICY}`,
  ].join('  '));

  workerProc = spawnWorker();
  serverProc = spawnServer();
  // Browser is launched inside spawnServer()'s SRV.READY handler,
  // ensuring the server is accepting connections before Chromium loads the page.
}

boot().catch((err) => {
  console.error('[main] Fatal boot error:', err);
  process.exit(1);
});
