'use strict';

/**
 * worker/task-shell.js
 *
 * The Task Shell sits between the worker IPC harness and the actual task module.
 * It owns the state machine and provides the `context` object injected into tasks.
 *
 * Responsibilities:
 *   - Enforce valid state transitions
 *   - Build and inject the `context` API into the task
 *   - Catch synchronous and asynchronous task errors
 *   - Emit structured events upward via a supplied `emit` function
 *
 * It does NOT know about IPC, process.send, or WebSockets — those concerns
 * live in worker-process.js. This makes TaskShell unit-testable in isolation.
 */

const { STATE, EVT, msg } = require('../shared/messages');

// Valid transitions: currentState → Set of allowed next states
const TRANSITIONS = {
  [STATE.IDLE]:    new Set([STATE.RUNNING]),
  [STATE.RUNNING]: new Set([STATE.PAUSED, STATE.DONE, STATE.ABORTED, STATE.ERROR]),
  [STATE.PAUSED]:  new Set([STATE.RUNNING, STATE.ABORTED]),
  [STATE.DONE]:    new Set([STATE.IDLE]),
  [STATE.ABORTED]: new Set([STATE.IDLE]),
  [STATE.ERROR]:   new Set([STATE.IDLE]),
};

class TaskShell {
  /**
   * @param {Function} emit  — callback(messageEnvelope) to send events upward
   */
  constructor(emit) {
    this._emit      = emit;
    this._state     = STATE.IDLE;
    this._task      = null;
    this._cancelled = false;
  }

  get state() { return this._state; }

  // ─── State machine ──────────────────────────────────────────────────────────

  _transition(next, reason) {
    const allowed = TRANSITIONS[this._state];
    if (!allowed || !allowed.has(next)) {
      this._emit(msg(EVT.TASK_ERROR, {
        message: `Invalid state transition: ${this._state} → ${next}`,
        stack:   new Error().stack,
      }));
      return false;
    }
    this._state = next;
    this._pushStatus(reason);
    return true;
  }

  _pushStatus(message) {
    this._emit(msg(EVT.STATUS_UPDATE, {
      state:   this._state,
      message: message || null,
    }));
  }

  // ─── Context object injected into tasks ────────────────────────────────────

  _buildContext(taskConfig) {
    return {
      config: taskConfig || {},
      isCancelled: () => this._cancelled,

      progress: (percent, message) => {
        if (this._state !== STATE.RUNNING && this._state !== STATE.PAUSED) return;
        this._emit(msg(EVT.TASK_PROGRESS, { percent, message: message || null }));
      },

      done: (result) => {
        this._cancelled = false;
        if (this._transition(STATE.DONE)) {
          this._emit(msg(EVT.TASK_DONE, { result: result || null }));
        }
      },

      fail: (error) => {
        this._cancelled = false;
        const isError = error instanceof Error;
        if (this._transition(STATE.ERROR, isError ? error.message : String(error))) {
          this._emit(msg(EVT.TASK_ERROR, {
            message: isError ? error.message : String(error),
            stack:   isError ? error.stack   : null,
          }));
        }
      },
    };
  }

  // ─── Public commands ────────────────────────────────────────────────────────

  /**
   * Load and start a task module.
   * @param {object} options
   * @param {string} options.modulePath  — absolute path to the task module
   * @param {object} [options.config]    — task-specific config passed via context
   */
  assign({ modulePath, config } = {}) {
    if (this._state !== STATE.IDLE) {
      this._emit(msg(EVT.TASK_ERROR, {
        message: `Cannot assign task while in state: ${this._state}`,
        stack: null,
      }));
      return;
    }

    let taskModule;
    try {
      taskModule = require(modulePath);
    } catch (err) {
      this._emit(msg(EVT.TASK_ERROR, {
        message: `Failed to load task module "${modulePath}": ${err.message}`,
        stack:   err.stack,
      }));
      return;
    }

    this._task      = taskModule;
    this._cancelled = false;

    if (!this._transition(STATE.RUNNING)) return;

    const context = this._buildContext(config);

    try {
      this._task.start(context);
    } catch (err) {
      context.fail(err);
    }
  }

  pause() {
    if (this._state !== STATE.RUNNING) {
      this._emit(msg(EVT.TASK_ERROR, { message: `Cannot pause from state: ${this._state}`, stack: null }));
      return;
    }
    if (this._transition(STATE.PAUSED)) {
      try { this._task && this._task.pause && this._task.pause(); }
      catch (err) { /* pause errors are non-fatal */ }
    }
  }

  resume() {
    if (this._state !== STATE.PAUSED) {
      this._emit(msg(EVT.TASK_ERROR, { message: `Cannot resume from state: ${this._state}`, stack: null }));
      return;
    }
    if (this._transition(STATE.RUNNING)) {
      try { this._task && this._task.resume && this._task.resume(); }
      catch (err) { /* resume errors are non-fatal */ }
    }
  }

  abort() {
    if (this._state !== STATE.RUNNING && this._state !== STATE.PAUSED) {
      this._emit(msg(EVT.TASK_ERROR, { message: `Cannot abort from state: ${this._state}`, stack: null }));
      return;
    }
    this._cancelled = true;
    try { this._task && this._task.abort && this._task.abort(); }
    catch (err) { /* abort errors are non-fatal */ }
    this._transition(STATE.ABORTED);
  }

  reset() {
    // Return to IDLE from a terminal state so a new task can be assigned
    const terminal = new Set([STATE.DONE, STATE.ABORTED, STATE.ERROR]);
    if (!terminal.has(this._state)) {
      this._emit(msg(EVT.TASK_ERROR, { message: `Cannot reset from state: ${this._state}`, stack: null }));
      return;
    }
    this._task      = null;
    this._cancelled = false;
    this._transition(STATE.IDLE);
  }

  status() {
    this._pushStatus();
  }
}

module.exports = TaskShell;
