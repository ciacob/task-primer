'use strict';

/**
 * server/server-process.js
 *
 * Entry point for the web server child process (spawned via child_process.fork).
 *
 * Fastify scoping note:
 *   In Fastify, child plugins (registered with fastify.register()) inherit
 *   decorators from their parent scope. The routes plugin accesses
 *   `fastify.forwardCmd` and `fastify.workerState` which are decorated on the
 *   root instance before any child plugins are registered — so they are always
 *   visible. No fp() wrapper is needed for this pattern.
 *
 *   The /worker prefix is applied at registration; route definitions inside
 *   routes/worker.js use relative paths (/status, /assign, etc.).
 */

const path    = require('path');
const Fastify = require('fastify');

const { SRV, msg } = require('../shared/messages');

const PORT = parseInt(process.env.SERVER_PORT || '3000', 10);
const HOST = process.env.SERVER_HOST || '127.0.0.1';

// Module-level state cache — mutated by IPC handler
let latestWorkerState = { state: 'idle', message: null, percent: null };

const fastify = Fastify({ logger: false });

async function boot() {

  // ── Root decorators (must be registered before any plugin that uses them) ──
  fastify.decorate('forwardCmd', (envelope) => {
    if (process.send) process.send(msg(SRV.FORWARD_CMD, envelope));
  });

  fastify.decorate('workerState', () => latestWorkerState);

  // ── Third-party plugins ────────────────────────────────────────────────────
  await fastify.register(require('@fastify/websocket'));

  await fastify.register(require('@fastify/static'), {
    root:        path.resolve(__dirname, '..', 'ui'),
    prefix:      '/',
    decorateReply: false,
  });

  // ── Application plugins ────────────────────────────────────────────────────

  // WebSocket status feed at /ws/status
  await fastify.register(require('./ws/status-feed'));

  // Worker REST routes at /worker/*
  await fastify.register(require('./routes/worker'), { prefix: '/worker' });

  // ── Misc ──────────────────────────────────────────────────────────────────
  fastify.get('/health', async () => ({ ok: true }));

  // Public config endpoint — exposes the subset of package.json values
  // that the UI needs (e.g. appName for document.title). Add keys here
  // as the UI grows; never expose sensitive values through this route.
  const taskPrimerCfg = require('../package.json').taskPrimer || {};
  fastify.get('/config', async () => ({
    appName: taskPrimerCfg.appName || 'Task Primer',
  }));

  await fastify.listen({ port: PORT, host: HOST });

  if (process.send) {
    process.send(msg(SRV.READY, { port: PORT, host: HOST }));
  }
}

boot().catch((err) => {
  console.error('[server] Boot error:', err);
  process.exit(1);
});

// IPC: receive state pushes from main, fan out to WebSocket clients
process.on('message', (envelope) => {
  if (!envelope || !envelope.type) return;
  if (envelope.type === SRV.STATE_PUSH) {
    latestWorkerState = envelope.payload || latestWorkerState;
    require('./ws/status-feed').broadcast(latestWorkerState);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});
