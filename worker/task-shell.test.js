// worker/task-shell.test.js
// Tests for the TaskShell state machine, context API (non-UI), and
// public command methods. The UI surface (context.ui, dispatchNotify)
// is covered separately in task-shell.ui.test.js.
//
// TaskShell is fully injectable: emit is a callback, uiDelegate is an
// object — no IPC, no process.send, no filesystem access needed.
//
// Run: node --test worker/task-shell.test.js  (from task-primer root)

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');
const TaskShell = require('./task-shell');
const { STATE, EVT, msg } = require('../shared/messages');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeShell() {
  const emitted = [];
  const shell   = new TaskShell((e) => emitted.push(e));
  return { shell, emitted };
}

// A minimal synchronous task: calls done() immediately
const SYNC_TASK_PATH = path.resolve(__dirname, '../worker/example-task.js');

// Inline task factories — returned objects conform to the task interface
function taskThatCallsDone(delay = 0) {
  return {
    start(ctx) { setTimeout(() => ctx.done({ ok: true }), delay); },
  };
}

function taskThatCallsFail(error) {
  return {
    start(ctx) { ctx.fail(error); },
  };
}

function taskThatThrows(msg) {
  return {
    start() { throw new Error(msg); },
  };
}

// Inject a fake task module by temporarily shimming require
function withFakeTask(fakeTask, fn) {
  // We bypass require() by going straight to TaskShell internals for
  // testing purposes — assign the task and call start directly.
  return fn(fakeTask);
}

// Build a shell, inject a fake task, and run it
function shellWithTask(fakeTask) {
  const { shell, emitted } = makeShell();

  // Patch assign to use the fake task object instead of loading from disk
  const origBuildContext = shell._buildContext.bind(shell);

  shell._injectTask = function (task, config) {
    if (shell._state !== STATE.IDLE) {
      shell._emit(msg(EVT.TASK_ERROR, { message: `Cannot assign task while in state: ${shell._state}`, stack: null }));
      return;
    }
    shell._task      = task;
    shell._cancelled = false;
    shell._uiHandlers = { menuAction: [], fileOpen: [], appReopen: [], windowClosed: [] };
    if (!shell._transition(STATE.RUNNING)) return;
    const context = origBuildContext(config || {});
    try { shell._task.start(context); }
    catch (err) { context.fail(err); }
  };

  return { shell, emitted };
}

// ── Initial state ─────────────────────────────────────────────────────────────

test('TaskShell starts in IDLE state', () => {
  const { shell } = makeShell();
  assert.equal(shell.state, STATE.IDLE);
});

// ── assign() ─────────────────────────────────────────────────────────────────

test('assign: transitions to RUNNING and emits STATUS_UPDATE', () => {
  const { shell, emitted } = shellWithTask(taskThatCallsDone(10000));
  shell._injectTask(taskThatCallsDone(10000));
  assert.equal(shell.state, STATE.RUNNING);
  const statusEvts = emitted.filter(e => e.type === EVT.STATUS_UPDATE);
  assert.ok(statusEvts.length >= 1);
  assert.equal(statusEvts[statusEvts.length - 1].payload.state, STATE.RUNNING);
  shell.abort(); // cleanup
});

test('assign: emits TASK_ERROR when called in non-IDLE state', () => {
  const { shell, emitted } = shellWithTask(taskThatCallsDone(10000));
  shell._injectTask(taskThatCallsDone(10000));
  shell._injectTask(taskThatCallsDone(10000)); // second call while RUNNING
  const errors = emitted.filter(e => e.type === EVT.TASK_ERROR);
  assert.ok(errors.length >= 1);
  assert.ok(errors[0].payload.message.includes('Cannot assign'));
  shell.abort();
});

test('assign: catches synchronous throw and emits TASK_ERROR', () => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask(taskThatThrows('boom'));
  const errors = emitted.filter(e => e.type === EVT.TASK_ERROR);
  assert.ok(errors.some(e => e.payload.message.includes('boom')));
});

test('assign: task calling done() transitions to DONE', (_, done) => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask({
    start(ctx) { setImmediate(() => ctx.done({ result: 42 })); },
  });
  setImmediate(() => {
    assert.equal(shell.state, STATE.DONE);
    const doneEvt = emitted.find(e => e.type === EVT.TASK_DONE);
    assert.ok(doneEvt);
    assert.deepEqual(doneEvt.payload.result, { result: 42 });
    done();
  });
});

test('assign: task calling fail() transitions to ERROR', () => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask(taskThatCallsFail(new Error('task failed')));
  assert.equal(shell.state, STATE.ERROR);
  const errEvt = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(errEvt.payload.message.includes('task failed'));
});

test('assign: fail() with string error', () => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask(taskThatCallsFail('string error'));
  assert.equal(shell.state, STATE.ERROR);
  const errEvt = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.equal(errEvt.payload.message, 'string error');
});

// ── context.progress() ────────────────────────────────────────────────────────

test('context.progress: emits TASK_PROGRESS while RUNNING', (_, done) => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask({
    start(ctx) {
      ctx.progress(42, 'halfway');
      setImmediate(() => ctx.done());
    },
  });
  setImmediate(() => {
    const prog = emitted.find(e => e.type === EVT.TASK_PROGRESS);
    assert.ok(prog);
    assert.equal(prog.payload.percent, 42);
    assert.equal(prog.payload.message, 'halfway');
    done();
  });
});

test('context.progress: does not emit when state is not RUNNING or PAUSED', () => {
  const { shell, emitted } = makeShell();
  // Call progress directly on a fresh shell (IDLE state)
  const ctx = shell._buildContext({});
  ctx.progress(50, 'test');
  assert.equal(emitted.filter(e => e.type === EVT.TASK_PROGRESS).length, 0);
});

// ── context.isCancelled() ────────────────────────────────────────────────────

test('context.isCancelled: returns false initially', () => {
  const { shell } = shellWithTask(null);
  const ctx = shell._buildContext({});
  assert.equal(ctx.isCancelled(), false);
});

test('context.isCancelled: returns true after abort()', () => {
  const { shell } = shellWithTask(null);
  let capturedCtx;
  shell._injectTask({
    start(ctx) { capturedCtx = ctx; },
  });
  shell.abort();
  assert.equal(capturedCtx.isCancelled(), true);
});

// ── pause() ───────────────────────────────────────────────────────────────────

test('pause: transitions RUNNING → PAUSED', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.pause();
  assert.equal(shell.state, STATE.PAUSED);
  shell.abort();
});

test('pause: emits TASK_ERROR from IDLE state', () => {
  const { shell, emitted } = makeShell();
  shell.pause();
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err.payload.message.includes('Cannot pause'));
});

test('pause: calls task.pause() if defined', () => {
  const { shell } = shellWithTask(null);
  let paused = false;
  shell._injectTask({
    start() {},
    pause() { paused = true; },
  });
  shell.pause();
  assert.ok(paused);
  shell.abort();
});

// ── resume() ──────────────────────────────────────────────────────────────────

test('resume: transitions PAUSED → RUNNING', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.pause();
  shell.resume();
  assert.equal(shell.state, STATE.RUNNING);
  shell.abort();
});

test('resume: emits TASK_ERROR from RUNNING state', () => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.resume(); // invalid from RUNNING
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err.payload.message.includes('Cannot resume'));
  shell.abort();
});

test('resume: calls task.resume() if defined', () => {
  const { shell } = shellWithTask(null);
  let resumed = false;
  shell._injectTask({
    start() {},
    resume() { resumed = true; },
  });
  shell.pause();
  shell.resume();
  assert.ok(resumed);
  shell.abort();
});

// ── abort() ───────────────────────────────────────────────────────────────────

test('abort: transitions RUNNING → ABORTED', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.abort();
  assert.equal(shell.state, STATE.ABORTED);
});

test('abort: transitions PAUSED → ABORTED', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.pause();
  shell.abort();
  assert.equal(shell.state, STATE.ABORTED);
});

test('abort: emits TASK_ERROR from IDLE state', () => {
  const { shell, emitted } = makeShell();
  shell.abort();
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err.payload.message.includes('Cannot abort'));
});

test('abort: calls task.abort() if defined', () => {
  const { shell } = shellWithTask(null);
  let aborted = false;
  shell._injectTask({
    start() {},
    abort() { aborted = true; },
  });
  shell.abort();
  assert.ok(aborted);
});

test('abort: sets isCancelled() to true', () => {
  const { shell } = shellWithTask(null);
  let capturedCtx;
  shell._injectTask({ start(ctx) { capturedCtx = ctx; } });
  shell.abort();
  assert.equal(capturedCtx.isCancelled(), true);
});

// ── reset() ───────────────────────────────────────────────────────────────────

test('reset: transitions DONE → IDLE', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsFail('x')); // → ERROR
  // Force to DONE via internal transition for testing
  shell._state = STATE.DONE;
  shell.reset();
  assert.equal(shell.state, STATE.IDLE);
});

test('reset: transitions ABORTED → IDLE', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.abort();
  shell.reset();
  assert.equal(shell.state, STATE.IDLE);
});

test('reset: transitions ERROR → IDLE', () => {
  const { shell } = shellWithTask(null);
  shell._injectTask(taskThatCallsFail('err'));
  shell.reset();
  assert.equal(shell.state, STATE.IDLE);
});

test('reset: emits TASK_ERROR from RUNNING state', () => {
  const { shell, emitted } = shellWithTask(null);
  shell._injectTask(taskThatCallsDone(10000));
  shell.reset();
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err.payload.message.includes('Cannot reset'));
  shell.abort();
});

// ── status() ─────────────────────────────────────────────────────────────────

test('status: emits STATUS_UPDATE with current state', () => {
  const { shell, emitted } = makeShell();
  shell.status();
  const su = emitted.filter(e => e.type === EVT.STATUS_UPDATE);
  assert.ok(su.length >= 1);
  assert.equal(su[su.length - 1].payload.state, STATE.IDLE);
});

// ── State transition guard ────────────────────────────────────────────────────

test('invalid transition: emits TASK_ERROR with descriptive message', () => {
  const { shell, emitted } = makeShell();
  // Force an invalid transition directly
  shell._transition(STATE.PAUSED); // IDLE → PAUSED is invalid
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err, 'Should emit TASK_ERROR for invalid transition');
  assert.ok(err.payload.message.includes('Invalid state transition'));
  assert.ok(err.payload.message.includes(STATE.IDLE));
  assert.ok(err.payload.message.includes(STATE.PAUSED));
});

// ── context.config ────────────────────────────────────────────────────────────

test('context.config is the object passed to assign', () => {
  const { shell } = shellWithTask(null);
  let captured;
  shell._injectTask({ start(ctx) { captured = ctx.config; } }, { steps: 7 });
  assert.deepEqual(captured, { steps: 7 });
  shell.abort();
});

test('context.config defaults to {} when no config provided', () => {
  const { shell } = shellWithTask(null);
  let captured;
  shell._injectTask({ start(ctx) { captured = ctx.config; } });
  assert.deepEqual(captured, {});
  shell.abort();
});

// ── Real task module load (integration smoke) ─────────────────────────────────

test('assign: loads example-task.js from disk and starts it', (_, done) => {
  const { shell, emitted } = makeShell();
  shell.assign({ modulePath: SYNC_TASK_PATH, config: { steps: 2 } });
  assert.equal(shell.state, STATE.RUNNING);
  // Wait long enough for 2 steps at 200ms each + done
  setTimeout(() => {
    assert.equal(shell.state, STATE.DONE);
    done();
  }, 600);
});

test('assign: emits TASK_ERROR for non-existent module path', () => {
  const { shell, emitted } = makeShell();
  shell.assign({ modulePath: '/no/such/module.js' });
  const err = emitted.find(e => e.type === EVT.TASK_ERROR);
  assert.ok(err, 'Should emit TASK_ERROR');
  assert.ok(err.payload.message.includes('Failed to load'));
});
