'use strict';

/**
 * worker/worker-process.js
 *
 * Entry point for the worker child process (spawned via child_process.fork).
 *
 * Responsibilities:
 *   - Listen for IPC messages from main (CMD_*, NOTIFY_*)
 *   - Translate CMD_* into TaskShell commands
 *   - Dispatch NOTIFY_* to TaskShell so context.ui.on*() handlers fire
 *   - Forward TaskShell events back to main (EVT_*, UI_CMD_*)
 *   - Handle uncaught exceptions and report them without dying silently
 *
 * This file is intentionally thin — all business logic lives in TaskShell.
 */

const path      = require('path');
const TaskShell = require('./task-shell');
const { CMD, EVT, UI_CMD, NOTIFY, msg } = require('../shared/messages');

// ─── UI delegate ─────────────────────────────────────────────────────────────
// Injected into TaskShell so context.ui.setMenu() etc. can forward messages
// to main without TaskShell knowing about process.send.
//
// isNacre is set once main sends UI_CMD_IS_NACRE during boot (see main.js).
// Until then it defaults to false (safe — context.ui will log no-ops).

const uiDelegate = {
  isNacre: false,

  sendToUI(message) {
    // Forward the UI_CMD envelope to main, which routes it to nacreUI
    if (process.send) process.send(message);
  },
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

const shell = new TaskShell((envelope) => {
  // Relay everything the shell emits back to main
  if (process.send) process.send(envelope);
}, uiDelegate);

// Announce readiness
if (process.send) process.send(msg(EVT.READY));

// ─── IPC message handler ──────────────────────────────────────────────────────

process.on('message', (envelope) => {
  if (!envelope || !envelope.type) return;

  switch (envelope.type) {

    // ── Existing task commands (CMD_*) — unchanged ───────────────────────────

    case CMD.ASSIGN: {
      const { modulePath, config } = envelope.payload || {};
      // Resolve modulePath relative to the project root (parent of worker/)
      const resolved = path.resolve(__dirname, '..', modulePath);
      shell.assign({ modulePath: resolved, config });
      break;
    }

    case CMD.PAUSE:
      shell.pause();
      break;

    case CMD.RESUME:
      shell.resume();
      break;

    case CMD.ABORT:
      shell.abort();
      break;

    case CMD.STATUS:
      shell.status();
      break;

    case CMD.RESET:
      shell.reset();
      break;

    // ── UI notifications (NOTIFY_*) ──────────────────────────────────────────
    // Sent by main.js when nacre emits UI events.
    // Delivered to the task via context.ui.on*() handlers.

    case NOTIFY.MENU_ACTION:
    case NOTIFY.FILE_OPEN:
    case NOTIFY.APP_REOPEN:
      shell.dispatchNotify(envelope);
      break;

    // ── Nacre mode flag ──────────────────────────────────────────────────────
    // main.js sends this once after launching nacre so context.ui.isNacre
    // is correct before the first task is assigned.

    case 'WORKER_SET_IS_NACRE':
      uiDelegate.isNacre = Boolean(envelope.payload?.isNacre);
      break;

    default:
      // Unknown message — report but don't crash
      if (process.send) {
        process.send(msg(EVT.TASK_ERROR, {
          message: `Worker received unknown message type: "${envelope.type}"`,
          stack: null,
        }));
      }
  }
});

// ─── Safety net ───────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  if (process.send) {
    process.send(msg(EVT.TASK_ERROR, {
      message: `Uncaught exception in worker: ${err.message}`,
      stack:   err.stack,
    }));
  }
  // Do NOT exit — let main decide what to do
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : null;
  if (process.send) {
    process.send(msg(EVT.TASK_ERROR, { message: `Unhandled rejection in worker: ${message}`, stack }));
  }
});
