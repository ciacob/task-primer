'use strict';

/**
 * worker/worker-process.js
 *
 * Entry point for the worker child process (spawned via child_process.fork).
 *
 * Responsibilities:
 *   - Listen for IPC messages from main (CMD_*)
 *   - Translate them into TaskShell commands
 *   - Forward TaskShell events back to main (EVT_*)
 *   - Handle uncaught exceptions and report them without dying silently
 *
 * This file is intentionally thin — all business logic lives in TaskShell.
 */

const path      = require('path');
const TaskShell = require('./task-shell');
const { CMD, EVT, msg } = require('../shared/messages');

// ─── Boot ────────────────────────────────────────────────────────────────────

const shell = new TaskShell((envelope) => {
  // Relay everything the shell emits back to main
  if (process.send) process.send(envelope);
});

// Announce readiness
if (process.send) process.send(msg(EVT.READY));

// ─── IPC message handler ─────────────────────────────────────────────────────

process.on('message', (envelope) => {
  if (!envelope || !envelope.type) return;

  switch (envelope.type) {

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

    default:
      // Unknown command — report but don't crash
      if (process.send) {
        process.send(msg(EVT.TASK_ERROR, {
          message: `Worker received unknown command type: "${envelope.type}"`,
          stack: null,
        }));
      }
  }
});

// ─── Safety net ──────────────────────────────────────────────────────────────

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
