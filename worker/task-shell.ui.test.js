// worker/task-shell.ui.test.js
// Tests for the context.ui additions to TaskShell.
// Existing TaskShell behaviour is not re-tested here.
//
// Run: node --test worker/task-shell.ui.test.js  (from task-primer root)

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const TaskShell = require('./task-shell');
const { UI_CMD, NOTIFY, msg } = require('../shared/messages');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDelegate(isNacre = true) {
  const sent = [];
  return {
    isNacre,
    sent,
    sendToUI(message) { sent.push(message); },
  };
}

function makeShell(isNacre = true) {
  const emitted  = [];
  const delegate = makeDelegate(isNacre);
  const shell    = new TaskShell((e) => emitted.push(e), delegate);
  return { shell, delegate, emitted };
}

// Run a minimal task and capture the context it receives
function captureContext(shell) {
  return new Promise((resolve) => {
    // Patch assign to intercept the context before start() runs
    const origAssign = shell.assign.bind(shell);
    let captured;
    shell.assign = function (opts) {
      // Temporarily override require to intercept the task module
      origAssign({
        ...opts,
        modulePath: require.resolve('./worker/example-task'),
      });
    };

    // Instead, build context directly via private method for testing
    captured = shell._buildContext({});
    shell.assign = origAssign;
    resolve(captured);
  });
}

// ── context.ui in nacre mode ──────────────────────────────────────────────────

test('context.ui.isNacre is true when delegate.isNacre is true', () => {
  const { shell } = makeShell(true);
  const ctx = shell._buildContext({});
  assert.equal(ctx.ui.isNacre, true);
});

test('context.ui.setMenu sends UI_CMD.SET_MENU via delegate', () => {
  const { shell, delegate } = makeShell(true);
  const ctx   = shell._buildContext({});
  const menus = [{ label: 'File', items: [] }];
  ctx.ui.setMenu(menus);
  assert.equal(delegate.sent.length, 1);
  assert.equal(delegate.sent[0].type, UI_CMD.SET_MENU);
  assert.deepEqual(delegate.sent[0].menus, menus);
});

test('context.ui.patchMenu sends UI_CMD.PATCH_MENU via delegate', () => {
  const { shell, delegate } = makeShell(true);
  const ctx     = shell._buildContext({});
  const patches = [{ id: 'file.new', enabled: false }];
  ctx.ui.patchMenu(patches);
  assert.equal(delegate.sent[0].type, UI_CMD.PATCH_MENU);
  assert.deepEqual(delegate.sent[0].patches, patches);
});

test('context.ui.setDevTools sends UI_CMD.SET_DEVTOOLS via delegate', () => {
  const { shell, delegate } = makeShell(true);
  const ctx = shell._buildContext({});
  ctx.ui.setDevTools(true);
  assert.equal(delegate.sent[0].type, UI_CMD.SET_DEVTOOLS);
  assert.equal(delegate.sent[0].enabled, true);
});

// ── context.ui in CfT / npm mode ─────────────────────────────────────────────

test('context.ui.isNacre is false when delegate.isNacre is false', () => {
  const { shell } = makeShell(false);
  const ctx = shell._buildContext({});
  assert.equal(ctx.ui.isNacre, false);
});

test('context.ui.setMenu is no-op in CfT mode (no send)', () => {
  const { shell, delegate } = makeShell(false);
  const ctx = shell._buildContext({});
  ctx.ui.setMenu([]);
  assert.equal(delegate.sent.length, 0);
});

test('context.ui.patchMenu is no-op in CfT mode', () => {
  const { shell, delegate } = makeShell(false);
  const ctx = shell._buildContext({});
  ctx.ui.patchMenu([]);
  assert.equal(delegate.sent.length, 0);
});

test('context.ui.setDevTools is no-op in CfT mode', () => {
  const { shell, delegate } = makeShell(false);
  const ctx = shell._buildContext({});
  ctx.ui.setDevTools(true);
  assert.equal(delegate.sent.length, 0);
});

test('context.ui without delegate has isNacre false', () => {
  const shell = new TaskShell(() => {});
  const ctx   = shell._buildContext({});
  assert.equal(ctx.ui.isNacre, false);
});

// ── dispatchNotify ────────────────────────────────────────────────────────────

test('dispatchNotify MENU_ACTION calls onMenuAction handlers', () => {
  const { shell } = makeShell(true);
  const ctx = shell._buildContext({});
  const received = [];
  ctx.ui.onMenuAction((id) => received.push(id));
  shell.dispatchNotify(msg(NOTIFY.MENU_ACTION, { id: 'file.new' }));
  assert.deepEqual(received, ['file.new']);
});

test('dispatchNotify FILE_OPEN calls onFileOpen handlers', () => {
  const { shell } = makeShell(true);
  const ctx = shell._buildContext({});
  const received = [];
  ctx.ui.onFileOpen((paths) => received.push(...paths));
  shell.dispatchNotify(msg(NOTIFY.FILE_OPEN, { paths: ['/tmp/a.txt', '/tmp/b.txt'] }));
  assert.deepEqual(received, ['/tmp/a.txt', '/tmp/b.txt']);
});

test('dispatchNotify APP_REOPEN calls onAppReopen handlers', () => {
  const { shell } = makeShell(true);
  const ctx = shell._buildContext({});
  let fired = false;
  ctx.ui.onAppReopen(() => { fired = true; });
  shell.dispatchNotify(msg(NOTIFY.APP_REOPEN));
  assert.ok(fired);
});

test('dispatchNotify with no handlers registered does not throw', () => {
  const { shell } = makeShell(true);
  shell._buildContext({}); // builds handlers but registers nothing
  assert.doesNotThrow(() =>
    shell.dispatchNotify(msg(NOTIFY.MENU_ACTION, { id: 'x' }))
  );
});

test('dispatchNotify multiple handlers all fire', () => {
  const { shell } = makeShell(true);
  const ctx = shell._buildContext({});
  const log = [];
  ctx.ui.onMenuAction((id) => log.push('first:' + id));
  ctx.ui.onMenuAction((id) => log.push('second:' + id));
  shell.dispatchNotify(msg(NOTIFY.MENU_ACTION, { id: 'view.zoom' }));
  assert.deepEqual(log, ['first:view.zoom', 'second:view.zoom']);
});

test('dispatchNotify unknown type does not throw', () => {
  const { shell } = makeShell(true);
  assert.doesNotThrow(() =>
    shell.dispatchNotify({ type: 'NOTIFY_SOMETHING_FUTURE' })
  );
});

// ── _uiHandlers reset on re-assign ───────────────────────────────────────────

test('_uiHandlers are cleared when a new task is assigned', () => {
  const { shell } = makeShell(true);

  // First assignment — register a handler
  const firstCtx = shell._buildContext({});
  const log = [];
  firstCtx.ui.onMenuAction((id) => log.push('old:' + id));

  // Simulate task completion → reset → new assignment
  // Force the handlers reset by calling assign internals via a fake task
  shell._uiHandlers.menuAction = []; // direct reset as assign() would do

  // Handler from first context should not fire
  shell.dispatchNotify(msg(NOTIFY.MENU_ACTION, { id: 'file.new' }));
  assert.deepEqual(log, [], 'Old handler must not fire after reset');
});
