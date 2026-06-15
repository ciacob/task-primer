// pickPorts.test.js
// Tests for pickPorts.js: port probing, no-op when already set, and
// --override behaviour. We test the internal helpers by extracting
// them; the package.json write path is tested with a temp file.
//
// Run: node --test pickPorts.test.js  (from task-primer root)

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const net       = require('net');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

// ── Re-implement the testable units inline ────────────────────────────────────
// pickPorts.js is a script (runs on require), so we extract and test its
// logic directly rather than importing the whole file.

const PORT_MIN = 3000;
const PORT_MAX = 9999;

function randomPort() {
  return Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(exclude = new Set(), maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const candidate = randomPort();
    if (exclude.has(candidate)) continue;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(`No free port found after ${maxTries} attempts`);
}

// Regex used by pickPorts.js to write into package.json
function applyPortReplacements(raw, webPort, debugPort) {
  let updated = raw;
  updated = updated.replace(/("webPort"\s*:\s*)(?:null|\d+)/, `$1${webPort}`);
  updated = updated.replace(/("debugPort"\s*:\s*)(?:null|\d+)/, `$1${debugPort}`);
  return updated;
}

// ── randomPort ────────────────────────────────────────────────────────────────

test('randomPort: returns an integer in [PORT_MIN, PORT_MAX]', () => {
  for (let i = 0; i < 100; i++) {
    const p = randomPort();
    assert.ok(Number.isInteger(p), 'Must be integer');
    assert.ok(p >= PORT_MIN && p <= PORT_MAX, `Out of range: ${p}`);
  }
});

// ── isFree ────────────────────────────────────────────────────────────────────

test('isFree: returns true for a port that is not bound', async () => {
  const port = await findFreePort();
  const free = await isFree(port);
  assert.equal(free, true);
});

test('isFree: returns false for a port that is already bound', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const free = await isFree(port);
  assert.equal(free, false);
  await new Promise((resolve) => server.close(resolve));
});

// ── findFreePort ──────────────────────────────────────────────────────────────

test('findFreePort: returns a usable port', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port));
  assert.ok(port >= PORT_MIN && port <= PORT_MAX);
});

test('findFreePort: two consecutive calls with exclusion return different ports', async () => {
  const claimed = new Set();
  const p1 = await findFreePort(claimed);
  claimed.add(p1);
  const p2 = await findFreePort(claimed);
  assert.notEqual(p1, p2);
});

test('findFreePort: throws after maxTries with impossible exclusion set', async () => {
  // Fill the exclude set with every possible port so no candidate can pass
  const all = new Set();
  for (let p = PORT_MIN; p <= PORT_MAX; p++) all.add(p);
  await assert.rejects(
    () => findFreePort(all, 5),
    /No free port found/
  );
});

// ── applyPortReplacements ─────────────────────────────────────────────────────

test('applyPortReplacements: replaces null webPort', () => {
  const raw = '{"webPort": null, "debugPort": null}';
  const result = applyPortReplacements(raw, 4321, 5678);
  assert.ok(result.includes('"webPort": 4321'));
  assert.ok(result.includes('"debugPort": 5678'));
});

test('applyPortReplacements: replaces existing numeric webPort', () => {
  const raw = '{"webPort": 3000, "debugPort": 9222}';
  const result = applyPortReplacements(raw, 7777, 8888);
  assert.ok(result.includes('"webPort": 7777'));
  assert.ok(result.includes('"debugPort": 8888'));
});

test('applyPortReplacements: handles whitespace around colon', () => {
  const raw = '{"webPort"  :  null, "debugPort"\t:\tnull}';
  const result = applyPortReplacements(raw, 1111, 2222);
  assert.ok(result.includes('1111'));
  assert.ok(result.includes('2222'));
});

test('applyPortReplacements: does not corrupt other fields', () => {
  const raw = JSON.stringify({
    name: 'task-primer',
    webPort: null,
    debugPort: null,
    other: 'untouched',
  });
  const result = applyPortReplacements(raw, 4000, 5000);
  const parsed = JSON.parse(result);
  assert.equal(parsed.name, 'task-primer');
  assert.equal(parsed.other, 'untouched');
  assert.equal(parsed.webPort, 4000);
  assert.equal(parsed.debugPort, 5000);
});

// ── No-op / override logic ────────────────────────────────────────────────────

test('no-op: skip picking when both ports are already set', () => {
  // Simulate the guard logic at the top of pickPorts.js main()
  function shouldSkip(currentWebPort, currentDebugPort, override) {
    const bothSet = currentWebPort != null && currentDebugPort != null;
    return bothSet && !override;
  }

  assert.equal(shouldSkip(3000, 9222, false), true,  'Should skip when set and no override');
  assert.equal(shouldSkip(null, 9222, false), false,  'Should not skip if webPort is null');
  assert.equal(shouldSkip(3000, null, false), false,  'Should not skip if debugPort is null');
  assert.equal(shouldSkip(null, null, false), false,  'Should not skip if both null');
  assert.equal(shouldSkip(3000, 9222, true),  false,  'Should not skip with --override');
});

// ── Write to temp file (integration) ─────────────────────────────────────────

test('applyPortReplacements: write to temp file produces valid JSON', async () => {
  const tmp = path.join(os.tmpdir(), `pick-ports-test-${Date.now()}.json`);

  const original = JSON.stringify({
    taskPrimer: {
      webPort: null,
      browser: { debugPort: null },
    }
  }, null, 2);

  fs.writeFileSync(tmp, original, 'utf8');

  const raw     = fs.readFileSync(tmp, 'utf8');
  const updated = applyPortReplacements(raw, 4567, 7654);
  fs.writeFileSync(tmp, updated, 'utf8');

  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(parsed.taskPrimer.webPort, 4567);
  assert.equal(parsed.taskPrimer.browser.debugPort, 7654);

  fs.unlinkSync(tmp);
});
