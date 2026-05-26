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

const { fork }    = require('child_process');
const path        = require('path');
const yargs       = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { CMD, EVT, SRV, STATE, msg } = require('./shared/messages');

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
  .option('port', {
    type:        'number',
    default:     3000,
    description: 'Port for the web server',
  })
  .option('host', {
    type:        'string',
    default:     '127.0.0.1',
    description: 'Host/interface for the web server',
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
const SERVER_URL           = `http://${argv.host}:${argv.port}`;

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
      SERVER_PORT: String(argv.port),
      SERVER_HOST: argv.host,
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
  const { launch, BROWSER_CONFIG } = require('./browser/launcher');

  // Resolve cache directory relative to the project root so it works
  // both in development and when packaged with pkg (see README).
  const pkgConfig = require('./package.json').taskPrimer?.browser || {};
  const cacheDir  = path.resolve(
    __dirname,
    pkgConfig.cacheDir || '.browsers'
  );

  try {
    browserProc = await launch({ url: SERVER_URL, cacheDir });

    log('browser', `launched (pid=${browserProc.pid})`);

    browserProc.on('exit', (code, signal) => {
      log('browser', `window closed (code=${code}, signal=${signal})`);

      if (argv.autoexit) {
        log('main', '--autoexit: browser window closed, shutting down');
        shutdown('browser-exit');
      }
    });

  } catch (err) {
    log('browser', `launch failed: ${err.message}`);
    log('browser', `open manually: ${SERVER_URL}`);
  }
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

log('main', [
  `starting`,
  `port=${argv.port}`,
  `ui=${argv.ui}`,
  `autoexit=${argv.autoexit}`,
  `worker-crash=${WORKER_CRASH_POLICY}`,
].join('  '));

workerProc = spawnWorker();
serverProc = spawnServer();
// Browser is launched inside spawnServer()'s SRV.READY handler,
// ensuring the server is accepting connections before Chromium loads the page.
