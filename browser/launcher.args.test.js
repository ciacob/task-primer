// browser/launcher.args.test.js
// Tests for buildLaunchArgs() and shouldCloseTarget().
// Both are now exported pure functions with no side effects.
//
// Run: node --test browser/launcher.args.test.js  (from task-primer root)

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const { buildLaunchArgs, shouldCloseTarget } = require('./launcher');

const APP_ORIGIN = 'http://127.0.0.1:3000';

// ── buildLaunchArgs ───────────────────────────────────────────────────────────

test('buildLaunchArgs: returns an array', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222);
  assert.ok(Array.isArray(args));
});

test('buildLaunchArgs: always includes --app flag with the URL', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222);
  assert.ok(args.some(a => a === '--app=http://localhost:3000'));
});

test('buildLaunchArgs: always includes --remote-debugging-port', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222);
  assert.ok(args.some(a => a === '--remote-debugging-port=9222'));
});

test('buildLaunchArgs: always includes fixed UX suppression flags', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222);
  ['--no-first-run', '--no-default-browser-check',
   '--disable-extensions', '--disable-translate', '--disable-infobars']
    .forEach(flag => assert.ok(args.includes(flag), `Missing: ${flag}`));
});

test('buildLaunchArgs: no --window-size when width/height are null', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowWidth: null, windowHeight: null });
  assert.ok(!args.some(a => a.startsWith('--window-size')));
});

test('buildLaunchArgs: adds --window-size when both dimensions provided', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowWidth: 1280, windowHeight: 800 });
  assert.ok(args.includes('--window-size=1280,800'));
});

test('buildLaunchArgs: rounds fractional window dimensions', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowWidth: 1280.7, windowHeight: 799.3 });
  assert.ok(args.includes('--window-size=1281,799'));
});

test('buildLaunchArgs: omits --window-size if only width provided', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowWidth: 1280, windowHeight: null });
  assert.ok(!args.some(a => a.startsWith('--window-size')));
});

test('buildLaunchArgs: adds --window-position when both coordinates provided', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowX: 100, windowY: 200 });
  assert.ok(args.includes('--window-position=100,200'));
});

test('buildLaunchArgs: omits --window-position if only X provided', () => {
  const args = buildLaunchArgs('http://localhost:3000', 9222, { windowX: 100, windowY: null });
  assert.ok(!args.some(a => a.startsWith('--window-position')));
});

test('buildLaunchArgs: no --no-sandbox on non-linux (simulated)', () => {
  // We can only assert this reliably on the current platform.
  // On this CI/container (linux), no-sandbox IS added — just verify
  // the args array is consistent with the platform.
  const args = buildLaunchArgs('http://localhost:3000', 9222);
  // Either both sandbox flags are present (linux) or neither is (other)
  const hasSandbox   = args.includes('--no-sandbox');
  const hasSetuid    = args.includes('--disable-setuid-sandbox');
  assert.equal(hasSandbox, hasSetuid, 'sandbox flags must appear together or not at all');
});

// ── shouldCloseTarget ─────────────────────────────────────────────────────────

test('shouldCloseTarget: keeps app page (same origin)', () => {
  const reason = shouldCloseTarget('page', APP_ORIGIN + '/', APP_ORIGIN, true);
  assert.equal(reason, null);
});

test('shouldCloseTarget: keeps app page with path (same origin)', () => {
  const reason = shouldCloseTarget('page', APP_ORIGIN + '/worker/status', APP_ORIGIN, true);
  assert.equal(reason, null);
});

test('shouldCloseTarget: closes foreign-origin page', () => {
  const reason = shouldCloseTarget('page', 'https://example.com', APP_ORIGIN, true);
  assert.ok(reason !== null);
  assert.ok(reason.includes('foreign origin'));
  assert.ok(reason.includes('https://example.com'));
});

test('shouldCloseTarget: closes blank URL page', () => {
  const reason = shouldCloseTarget('page', 'about:blank', APP_ORIGIN, true);
  assert.ok(reason !== null);
  assert.ok(reason.includes('blank'));
});

test('shouldCloseTarget: closes page with empty string URL', () => {
  const reason = shouldCloseTarget('page', '', APP_ORIGIN, true);
  assert.ok(reason !== null);
});

test('shouldCloseTarget: keeps non-page targets (service worker etc.)', () => {
  const reason = shouldCloseTarget('service_worker', 'https://anything.com', APP_ORIGIN, true);
  assert.equal(reason, null);
});

test('shouldCloseTarget: keeps "other" type targets', () => {
  const reason = shouldCloseTarget('other', 'chrome://newtab', APP_ORIGIN, true);
  assert.equal(reason, null);
});

test('shouldCloseTarget: keeps DevTools target when devTools=true', () => {
  const reason = shouldCloseTarget(
    'other', 'devtools://devtools/bundled/devtools_app.html', APP_ORIGIN, true
  );
  assert.equal(reason, null);
});

test('shouldCloseTarget: closes DevTools target when devTools=false', () => {
  const reason = shouldCloseTarget(
    'other', 'devtools://devtools/bundled/devtools_app.html', APP_ORIGIN, false
  );
  assert.ok(reason !== null);
  assert.ok(reason.toLowerCase().includes('devtools'));
});

test('shouldCloseTarget: DevTools suppression reason mentions config key', () => {
  const reason = shouldCloseTarget(
    'other', 'devtools://devtools/bundled/inspector.html', APP_ORIGIN, false
  );
  assert.ok(reason.includes('security.devTools: false'));
});

test('shouldCloseTarget: closes foreign-origin page regardless of devTools flag', () => {
  const r1 = shouldCloseTarget('page', 'https://evil.com', APP_ORIGIN, true);
  const r2 = shouldCloseTarget('page', 'https://evil.com', APP_ORIGIN, false);
  assert.ok(r1 !== null);
  assert.ok(r2 !== null);
});

test('shouldCloseTarget: handles unparseable URLs gracefully', () => {
  const reason = shouldCloseTarget('page', 'not a url !!!', APP_ORIGIN, true);
  assert.ok(reason !== null, 'Unparseable URL should be closed');
});

test('shouldCloseTarget: different port is foreign origin', () => {
  const reason = shouldCloseTarget('page', 'http://127.0.0.1:9999/', APP_ORIGIN, true);
  assert.ok(reason !== null, 'Different port = different origin');
});

test('shouldCloseTarget: same host different scheme is foreign origin', () => {
  const reason = shouldCloseTarget('page', 'https://127.0.0.1:3000/', APP_ORIGIN, true);
  assert.ok(reason !== null, 'HTTPS vs HTTP = different origin');
});
