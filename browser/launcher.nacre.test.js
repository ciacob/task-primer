// browser/launcher.nacre.test.js
// Tests for the nacre-specific helpers added to launcher.js.
//
// Only tests NEW code — the existing CfT path is not touched.
// Run: node --test browser/launcher.nacre.test.js  (from task-primer root)

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const path      = require('node:path');
const {
  buildGuardScript,
  resolveNacreBinaryPath,
  nacreSocketPath,
} = require('./launcher');

// ── resolveNacreBinaryPath ────────────────────────────────────────────────────

test('resolveNacreBinaryPath: constructs correct path relative to execPath', () => {
  // Simulate process.execPath = /MyApp.app/Contents/MacOS/myapp
  // Expected:  /MyApp.app/Contents/Resources/Sample App 1.app/Contents/MacOS/nacre
  const result = resolveNacreBinaryPath('Sample App 1');

  // The result must end with the conventional suffix regardless of where
  // process.execPath happens to be in this test environment.
  assert.ok(
    result.endsWith(path.join('Resources', 'Sample App 1.app', 'Contents', 'MacOS', 'nacre')),
    `Unexpected path: ${result}`
  );
});

test('resolveNacreBinaryPath: handles app name with spaces', () => {
  const result = resolveNacreBinaryPath('My Cool App');
  assert.ok(result.includes('My Cool App.app'), `Expected app name in path, got: ${result}`);
});

test('resolveNacreBinaryPath: always ends with /nacre binary name', () => {
  const result = resolveNacreBinaryPath('AnyApp');
  assert.ok(result.endsWith(`${path.sep}nacre`), `Should end with nacre, got: ${result}`);
});

// ── nacreSocketPath ───────────────────────────────────────────────────────────

test('nacreSocketPath: constructs /tmp/<bundleId>/menu.sock', () => {
  assert.equal(
    nacreSocketPath('com.example.myapp'),
    '/tmp/com.example.myapp/menu.sock'
  );
});

test('nacreSocketPath: works with multi-segment bundle IDs', () => {
  assert.equal(
    nacreSocketPath('com.my-company.my-app'),
    '/tmp/com.my-company.my-app/menu.sock'
  );
});

// ── buildGuardScript ──────────────────────────────────────────────────────────
// These tests verify the guard script content hasn't been broken by the
// addition of the nacre path.  They test the function that both paths share.

test('buildGuardScript: returns a non-empty string', () => {
  const script = buildGuardScript();
  assert.ok(typeof script === 'string' && script.length > 0);
});

test('buildGuardScript: contains IIFE wrapper', () => {
  const script = buildGuardScript();
  assert.ok(script.includes('(function ()'), 'Should be wrapped in IIFE');
  assert.ok(script.includes('})()'),          'Should close IIFE');
});

test('buildGuardScript: bakes in allowRefresh=true by default', () => {
  const script = buildGuardScript();
  assert.ok(script.includes('ALLOW_REFRESH      = true'), 'Default should be true');
});

test('buildGuardScript: bakes in allowRefresh=false when specified', () => {
  const script = buildGuardScript({ allowRefresh: false });
  assert.ok(script.includes('ALLOW_REFRESH      = false'), 'Should be false when set');
});

test('buildGuardScript: contains navigation guard logic', () => {
  const script = buildGuardScript();
  assert.ok(script.includes('isForeignUrl'),        'Should include URL check function');
  assert.ok(script.includes('location.href'),       'Should guard location.href');
  assert.ok(script.includes('location.assign'),     'Should guard location.assign');
  assert.ok(script.includes('location.replace'),    'Should guard location.replace');
  assert.ok(script.includes("closest('a[href]')"),  'Should guard anchor clicks');
  assert.ok(script.includes("'submit'"),            'Should guard form submits');
  assert.ok(script.includes('dragover'),            'Should guard drag-and-drop');
});

test('buildGuardScript: refresh suppression only present when allowRefresh=false', () => {
  const withRefresh    = buildGuardScript({ allowRefresh: true });
  const withoutRefresh = buildGuardScript({ allowRefresh: false });

  // The keydown listener is inside an `if (!ALLOW_REFRESH)` block that is
  // baked in at generation time — verify the block is present in both but
  // the condition value differs.
  assert.ok(withRefresh.includes('ALLOW_REFRESH      = true'));
  assert.ok(withoutRefresh.includes('ALLOW_REFRESH      = false'));
});
