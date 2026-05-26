'use strict';

/**
 * server/routes/worker.js
 *
 * Fastify plugin exposing the REST API for worker control.
 *
 * All routes forward commands to main via the `forwardCmd` function
 * injected through Fastify's decorator system. Main is the single
 * source of truth; the server never talks to the worker directly.
 *
 * Endpoints:
 *   GET  /worker/status          — current worker state snapshot
 *   POST /worker/assign          — assign a task  { modulePath, config? }
 *   POST /worker/pause           — pause running task
 *   POST /worker/resume          — resume paused task
 *   POST /worker/abort           — abort current task
 *   POST /worker/reset           — reset to IDLE after terminal state
 */

const { CMD, msg } = require('../../shared/messages');

async function workerRoutes(fastify) {
  // GET /worker/status
  fastify.get('/status', async (request, reply) => {
    return fastify.workerState();
  });

  // POST /worker/assign
  fastify.post('/assign', {
    schema: {
      body: {
        type: 'object',
        required: ['modulePath'],
        properties: {
          modulePath: { type: 'string' },
          config:     { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { modulePath, config } = request.body;
    fastify.forwardCmd(msg(CMD.ASSIGN, { modulePath, config }));
    reply.code(202);
    return { accepted: true, command: 'assign' };
  });

  // POST /worker/pause
  fastify.post('/pause', async (request, reply) => {
    fastify.forwardCmd(msg(CMD.PAUSE));
    reply.code(202);
    return { accepted: true, command: 'pause' };
  });

  // POST /worker/resume
  fastify.post('/resume', async (request, reply) => {
    fastify.forwardCmd(msg(CMD.RESUME));
    reply.code(202);
    return { accepted: true, command: 'resume' };
  });

  // POST /worker/abort
  fastify.post('/abort', async (request, reply) => {
    fastify.forwardCmd(msg(CMD.ABORT));
    reply.code(202);
    return { accepted: true, command: 'abort' };
  });

  // POST /worker/reset
  fastify.post('/reset', async (request, reply) => {
    fastify.forwardCmd(msg(CMD.RESET));
    reply.code(202);
    return { accepted: true, command: 'reset' };
  });
}

module.exports = workerRoutes;
