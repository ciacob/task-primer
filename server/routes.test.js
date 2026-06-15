// server/routes.test.js
// Tests for the /worker/* REST routes using Fastify's inject() — no real
// server or port needed. The forwardCmd decorator is mocked so no IPC
// connection to main is required.
//
// Run: node --test server/routes.test.js  (from task-primer root)

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Fastify  = require('fastify');

// ── Test fixture: build a Fastify instance with the worker routes ─────────────

function buildApp(overrides = {}) {
  const app = Fastify({ logger: false });

  // Captured commands sent via forwardCmd
  const forwarded = [];

  // Mock state — workerState returns this
  let workerState = overrides.initialState || { state: 'idle', message: null, percent: null };

  app.decorate('forwardCmd', (envelope) => {
    forwarded.push(envelope);
    // Allow tests to inspect what was forwarded
  });

  app.decorate('workerState', () => workerState);

  // Register the routes under /worker prefix (same as production)
  app.register(require('./routes/worker'), { prefix: '/worker' });

  return { app, forwarded, setWorkerState: (s) => { workerState = s; } };
}

// ── GET /worker/status ────────────────────────────────────────────────────────

test('GET /worker/status: returns worker state as JSON', async () => {
  const { app } = buildApp({ initialState: { state: 'idle', message: 'ready', percent: null } });
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/worker/status' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.state, 'idle');
  assert.equal(body.message, 'ready');
});

test('GET /worker/status: reflects updated worker state', async () => {
  const { app, setWorkerState } = buildApp();
  await app.ready();

  setWorkerState({ state: 'running', message: 'step 3', percent: 60 });
  const res = await app.inject({ method: 'GET', url: '/worker/status' });
  const body = JSON.parse(res.payload);
  assert.equal(body.state, 'running');
  assert.equal(body.percent, 60);
});

// ── POST /worker/assign ───────────────────────────────────────────────────────

test('POST /worker/assign: returns 202 and accepted:true', async () => {
  const { app } = buildApp();
  await app.ready();

  const res = await app.inject({
    method:  'POST',
    url:     '/worker/assign',
    payload: { modulePath: 'worker/example-task.js', config: { steps: 5 } },
  });
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.payload);
  assert.equal(body.accepted, true);
  assert.equal(body.command, 'assign');
});

test('POST /worker/assign: forwards CMD_ASSIGN with correct payload', async () => {
  const { app, forwarded } = buildApp();
  await app.ready();

  await app.inject({
    method:  'POST',
    url:     '/worker/assign',
    payload: { modulePath: 'worker/my-task.js', config: { x: 1 } },
  });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].type, 'CMD_ASSIGN');
  assert.equal(forwarded[0].payload.modulePath, 'worker/my-task.js');
  assert.deepEqual(forwarded[0].payload.config, { x: 1 });
});

test('POST /worker/assign: returns 400 when modulePath is missing', async () => {
  const { app } = buildApp();
  await app.ready();

  const res = await app.inject({
    method:  'POST',
    url:     '/worker/assign',
    payload: { config: { steps: 5 } },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /worker/assign: returns 400 for empty body', async () => {
  const { app } = buildApp();
  await app.ready();

  const res = await app.inject({
    method:  'POST',
    url:     '/worker/assign',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(res.statusCode, 400);
});

// ── POST /worker/pause ────────────────────────────────────────────────────────

test('POST /worker/pause: returns 202 and forwards CMD_PAUSE', async () => {
  const { app, forwarded } = buildApp();
  await app.ready();

  const res = await app.inject({ method: 'POST', url: '/worker/pause' });
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.payload).command, 'pause');
  assert.equal(forwarded[0].type, 'CMD_PAUSE');
});

test('POST /worker/pause: no body required', async () => {
  const { app } = buildApp();
  await app.ready();

  // Should not return 400 even with Content-Type: application/json and no body
  const res = await app.inject({
    method: 'POST',
    url:    '/worker/pause',
  });
  assert.equal(res.statusCode, 202);
});

// ── POST /worker/resume ───────────────────────────────────────────────────────

test('POST /worker/resume: returns 202 and forwards CMD_RESUME', async () => {
  const { app, forwarded } = buildApp();
  await app.ready();

  const res = await app.inject({ method: 'POST', url: '/worker/resume' });
  assert.equal(res.statusCode, 202);
  assert.equal(forwarded[0].type, 'CMD_RESUME');
});

// ── POST /worker/abort ────────────────────────────────────────────────────────

test('POST /worker/abort: returns 202 and forwards CMD_ABORT', async () => {
  const { app, forwarded } = buildApp();
  await app.ready();

  const res = await app.inject({ method: 'POST', url: '/worker/abort' });
  assert.equal(res.statusCode, 202);
  assert.equal(forwarded[0].type, 'CMD_ABORT');
});

// ── POST /worker/reset ────────────────────────────────────────────────────────

test('POST /worker/reset: returns 202 and forwards CMD_RESET', async () => {
  const { app, forwarded } = buildApp();
  await app.ready();

  const res = await app.inject({ method: 'POST', url: '/worker/reset' });
  assert.equal(res.statusCode, 202);
  assert.equal(forwarded[0].type, 'CMD_RESET');
});

// ── Unknown routes ────────────────────────────────────────────────────────────

test('GET /worker/nonexistent: returns 404', async () => {
  const { app } = buildApp();
  await app.ready();

  const res = await app.inject({ method: 'GET', url: '/worker/nonexistent' });
  assert.equal(res.statusCode, 404);
});

// ── Each command forwards exactly one envelope ─────────────────────────────────

test('each command route forwards exactly one envelope', async () => {
  const routes = [
    { method: 'POST', url: '/worker/pause' },
    { method: 'POST', url: '/worker/resume' },
    { method: 'POST', url: '/worker/abort' },
    { method: 'POST', url: '/worker/reset' },
  ];

  for (const route of routes) {
    const { app, forwarded } = buildApp();
    await app.ready();
    await app.inject(route);
    assert.equal(forwarded.length, 1, `${route.url} should forward exactly one envelope`);
  }
});
