'use strict';

/**
 * server/ws/status-feed.js
 *
 * A Fastify plugin that registers a WebSocket endpoint at /ws/status.
 * All connected clients receive real-time worker state updates pushed
 * from the main process via the `broadcast` function exported below.
 *
 * The plugin follows Fastify's plugin encapsulation model so it can
 * be replaced or extended independently of the REST routes.
 */

const fp = require('fastify-plugin');

// In-memory set of live WebSocket connections
const clients = new Set();

/**
 * Broadcast a JSON-serialisable payload to every connected browser client.
 * Called by server-process.js whenever main pushes a SRV_STATE_PUSH message.
 */
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Fastify plugin registration.
 * Requires @fastify/websocket to be registered on the parent instance first.
 */
async function statusFeedPlugin(fastify) {
  fastify.get('/ws/status', { websocket: true }, (socket) => {
    clients.add(socket);

    socket.on('close', () => clients.delete(socket));

    socket.on('error', () => clients.delete(socket));

    // Optionally: send current state snapshot on connect (server-process
    // may call broadcast right after a new connection is known — or the
    // client can call GET /worker/status via REST immediately after connecting).
  });
}

module.exports = fp(statusFeedPlugin, { name: 'status-feed' });
module.exports.broadcast = broadcast;
