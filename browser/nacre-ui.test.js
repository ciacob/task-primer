// browser/nacre-ui.test.js
// Tests for NacreUI and NacreUIStub.
//
// Run: node --test browser/nacre-ui.test.js  (from task-primer root)

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { NacreUI, NacreUIStub } = require('./nacre-ui');

// ── Mock socket ───────────────────────────────────────────────────────────────

function makeMockSocket() {
  const written = [];
  return {
    written,
    write(data) { written.push(data); },
    on() {},
  };
}

function lastWritten(sock) {
  const last = sock.written[sock.written.length - 1];
  return last ? JSON.parse(last.replace(/\n$/, '')) : null;
}

// ── NacreUI ───────────────────────────────────────────────────────────────────

test('NacreUI: isNacre is true', () => {
  const ui = new NacreUI(makeMockSocket());
  assert.equal(ui.isNacre, true);
});

test('NacreUI: setMenu sends set_menu frame', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  const menus = [{ label: 'File', items: [] }];
  ui.setMenu(menus);
  const sent = lastWritten(sock);
  assert.equal(sent.type, 'set_menu');
  assert.deepEqual(sent.menus, menus);
});

test('NacreUI: setMenu warns and skips for non-array', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  ui.setMenu('not an array');
  assert.equal(sock.written.length, 0);
});

test('NacreUI: patchMenu sends patch_menu frame', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  const patches = [{ id: 'file.new', label: 'New Window' }];
  ui.patchMenu(patches);
  const sent = lastWritten(sock);
  assert.equal(sent.type, 'patch_menu');
  assert.deepEqual(sent.patches, patches);
});

test('NacreUI: patchMenu warns and skips for non-array', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  ui.patchMenu({ id: 'x' });
  assert.equal(sock.written.length, 0);
});

test('NacreUI: setDevTools sends set_devtools frame', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  ui.setDevTools(true);
  assert.deepEqual(lastWritten(sock), { type: 'set_devtools', enabled: true });
});

test('NacreUI: setDevTools coerces to boolean', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  ui.setDevTools(1);
  assert.equal(lastWritten(sock).enabled, true);
  ui.setDevTools(0);
  assert.equal(lastWritten(sock).enabled, false);
});

test('NacreUI: frames are newline-terminated', () => {
  const sock = makeMockSocket();
  const ui   = new NacreUI(sock);
  ui.setDevTools(false);
  assert.ok(sock.written[0].endsWith('\n'), 'Frame must end with newline');
});

test('NacreUI: _handleInbound emits menuAction', () => {
  const ui = new NacreUI(makeMockSocket());
  let received;
  ui.on('menuAction', (id) => { received = id; });
  ui._handleInbound({ type: 'menu_action', id: 'file.new' });
  assert.equal(received, 'file.new');
});

test('NacreUI: _handleInbound emits fileOpen', () => {
  const ui = new NacreUI(makeMockSocket());
  let received;
  ui.on('fileOpen', (paths) => { received = paths; });
  ui._handleInbound({ type: 'file_open', paths: ['/tmp/a.txt'] });
  assert.deepEqual(received, ['/tmp/a.txt']);
});

test('NacreUI: _handleInbound emits appReopen', () => {
  const ui = new NacreUI(makeMockSocket());
  let fired = false;
  ui.on('appReopen', () => { fired = true; });
  ui._handleInbound({ type: 'app_reopen' });
  assert.ok(fired);
});

test('NacreUI: _handleInbound emits windowClosed', () => {
  const ui = new NacreUI(makeMockSocket());
  let fired = false;
  ui.on('windowClosed', () => { fired = true; });
  ui._handleInbound({ type: 'window_closed' });
  assert.ok(fired);
});

test('NacreUI: _handleInbound ignores unknown types silently', () => {
  const ui = new NacreUI(makeMockSocket());
  assert.doesNotThrow(() => ui._handleInbound({ type: 'something_new' }));
});

test('NacreUI: multiple listeners all fire', () => {
  const ui = new NacreUI(makeMockSocket());
  const log = [];
  ui.on('menuAction', (id) => log.push('a:' + id));
  ui.on('menuAction', (id) => log.push('b:' + id));
  ui._handleInbound({ type: 'menu_action', id: 'edit.copy' });
  assert.deepEqual(log, ['a:edit.copy', 'b:edit.copy']);
});

// ── NacreUIStub ───────────────────────────────────────────────────────────────

test('NacreUIStub: isNacre is false', () => {
  assert.equal(new NacreUIStub().isNacre, false);
});

test('NacreUIStub: setMenu does not throw', () => {
  assert.doesNotThrow(() => new NacreUIStub().setMenu([{ label: 'File', items: [] }]));
});

test('NacreUIStub: patchMenu does not throw', () => {
  assert.doesNotThrow(() => new NacreUIStub().patchMenu([{ id: 'x' }]));
});

test('NacreUIStub: setDevTools does not throw', () => {
  assert.doesNotThrow(() => new NacreUIStub().setDevTools(true));
});

test('NacreUIStub: _handleInbound does not throw', () => {
  assert.doesNotThrow(() =>
    new NacreUIStub()._handleInbound({ type: 'menu_action', id: 'x' })
  );
});
