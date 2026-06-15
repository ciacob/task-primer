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

// ─── UI commands: worker → main ───────────────────────────────────────────────
// Sent by task modules via context.ui.* to drive the native macOS UI.
// main.js forwards these to the nacre socket.
// In CfT / npm mode these are received by main but silently no-op'd.
const UI_CMD = {
  SET_MENU:     'UI_CMD_SET_MENU',     // payload: { menus: MenuDescriptor[] }
  PATCH_MENU:   'UI_CMD_PATCH_MENU',   // payload: { patches: MenuPatch[] }
  SET_DEVTOOLS: 'UI_CMD_SET_DEVTOOLS', // payload: { enabled: boolean }
};

// ─── UI notifications: main → worker ─────────────────────────────────────────
// Sent by main.js when nacre emits native UI events.
// worker-process.js delivers these to context.ui.on* handlers.
// In CfT / npm mode these are never sent.
const NOTIFY = {
  MENU_ACTION: 'NOTIFY_MENU_ACTION',  // payload: { id: string }
  FILE_OPEN:   'NOTIFY_FILE_OPEN',    // payload: { paths: string[] }
  APP_REOPEN:  'NOTIFY_APP_REOPEN',   // payload: (none)
};

// ─── Internal bootstrap messages ───────────────────────────────────────────────
// One-time configuration messages that do not fit the CMD/EVT/NOTIFY groups.
const INTERNAL = {
  // main → worker: informs the worker whether the app is running in nacre mode.
  // Sent once immediately after EVT.READY so context.ui.isNacre is accurate
  // before the first task is assigned.
  SET_IS_NACRE: 'INTERNAL_SET_IS_NACRE',
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

module.exports = { CMD, EVT, UI_CMD, NOTIFY, INTERNAL, SRV, STATE, msg };
