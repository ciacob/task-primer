'use strict';

/**
 * shared/messages.js
 *
 * Canonical IPC message types used across all process boundaries:
 *   main <-> worker-process
 *   main <-> server-process
 *   server <-> browser (WebSocket)
 *
 * Every message envelope has the shape:
 *   { type: MSG_TYPE, payload?: any, id?: string }
 *
 * `id` is optional and used for request/response correlation when needed.
 */

// ─── Commands: main → worker ──────────────────────────────────────────────────
const CMD = {
  ASSIGN:  'CMD_ASSIGN',   // payload: { task: object }
  PAUSE:   'CMD_PAUSE',
  RESUME:  'CMD_RESUME',
  ABORT:   'CMD_ABORT',
  STATUS:  'CMD_STATUS',   // request a STATUS_UPDATE reply
  RESET:   'CMD_RESET',    // return to IDLE from a terminal state
};

// ─── Events: worker → main ───────────────────────────────────────────────────
const EVT = {
  READY:          'EVT_READY',          // worker booted and idle
  STATUS_UPDATE:  'EVT_STATUS_UPDATE',  // payload: WorkerStatus
  TASK_DONE:      'EVT_TASK_DONE',      // payload: { result: any }
  TASK_ERROR:     'EVT_TASK_ERROR',     // payload: { message, stack }
  TASK_PROGRESS:  'EVT_TASK_PROGRESS',  // payload: { percent, message? }
};

// ─── Internal: server-process ↔ main ─────────────────────────────────────────
const SRV = {
  // server → main  (forwarded REST commands)
  FORWARD_CMD:    'SRV_FORWARD_CMD',    // payload: { type: CMD.*, payload? }
  READY:          'SRV_READY',          // payload: { port, host }
  // main → server  (state pushes)
  STATE_PUSH:     'SRV_STATE_PUSH',     // payload: WorkerStatus
};

// ─── Worker state machine values ─────────────────────────────────────────────
const STATE = {
  IDLE:     'idle',
  RUNNING:  'running',
  PAUSED:   'paused',
  DONE:     'done',
  ABORTED:  'aborted',
  ERROR:    'error',
};

/**
 * Factory: build a well-formed message envelope.
 * @param {string} type
 * @param {any}    [payload]
 * @param {string} [id]
 */
function msg(type, payload, id) {
  const envelope = { type };
  if (payload !== undefined) envelope.payload = payload;
  if (id       !== undefined) envelope.id      = id;
  return envelope;
}

module.exports = { CMD, EVT, SRV, STATE, msg };
