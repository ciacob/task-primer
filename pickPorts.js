'use strict';

/**
 * pickPorts.js
 *
 * Finds two free ports and writes them to package.json as:
 *   taskPrimer.webPort       — the Fastify web server port
 *   taskPrimer.browser.debugPort — the CDP remote debugging port
 *
 * Usage:
 *   node pickPorts.js              # only runs if both ports are currently null
 *   node pickPorts.js --override   # always picks and writes new ports
 *
 * Ports are picked randomly within PORT_RANGE and probed with net.createServer()
 * before being written, so the chosen values are guaranteed free at the time of
 * writing. Both ports are confirmed free before anything is written — no partial
 * updates.
 *
 * This script is also called automatically by main.js on the first --ui launch
 * when either port is null. Running it manually with --override is useful when
 * ports that were free at install time have since been claimed by other processes.
 */

const net  = require('net');
const fs   = require('fs');
const path = require('path');

const PKG_PATH  = path.join(__dirname, 'package.json');
const PORT_MIN  = 3000;
const PORT_MAX  = 9999;
const MAX_TRIES = 20;   // attempts before giving up

// ─── CLI ──────────────────────────────────────────────────────────────────────

const override = process.argv.includes('--override');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomPort() {
  return Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
}

/**
 * Probe whether a port is free by briefly binding a TCP server to it.
 * Resolves true if free, false if in use or on any error.
 */
function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find a free port, trying up to MAX_TRIES random candidates.
 * Rejects if no free port is found within the attempts budget.
 *
 * @param {Set<number>} exclude  Ports already claimed in this run.
 */
async function findFreePort(exclude = new Set()) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = randomPort();
    if (exclude.has(candidate)) continue;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error(
    `Could not find a free port in range ${PORT_MIN}–${PORT_MAX} ` +
    `after ${MAX_TRIES} attempts. Run with --override to try again.`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  const tp  = pkg.taskPrimer || {};

  const currentWebPort   = tp.webPort;
  const currentDebugPort = tp.browser && tp.browser.debugPort;

  const bothSet = currentWebPort != null && currentDebugPort != null;

  if (bothSet && !override) {
    console.log(
      `Ports already set — webPort: ${currentWebPort}, debugPort: ${currentDebugPort}\n` +
      `Run with --override to pick new ones.`
    );
    return;
  }

  if (override && bothSet) {
    console.log(`--override: replacing webPort ${currentWebPort}, debugPort ${currentDebugPort}`);
  }

  console.log(`Picking free ports in range ${PORT_MIN}–${PORT_MAX}…`);

  // Pick both before writing — ensures we never do a partial update
  const claimed  = new Set();
  const webPort  = await findFreePort(claimed);
  claimed.add(webPort);
  const debugPort = await findFreePort(claimed);

  console.log(`  webPort:   ${webPort}`);
  console.log(`  debugPort: ${debugPort}`);

  // Write back to package.json, preserving formatting.
  // We do a targeted string replacement rather than JSON.stringify so that
  // comments-style keys (the "notes" arrays) and indentation are preserved.
  let updated = raw;

  // Replace webPort value (null → number, or number → number for --override)
  updated = updated.replace(
    /("webPort"\s*:\s*)(?:null|\d+)/,
    `$1${webPort}`
  );

  // Replace debugPort value inside the browser block
  updated = updated.replace(
    /("debugPort"\s*:\s*)(?:null|\d+)/,
    `$1${debugPort}`
  );

  fs.writeFileSync(PKG_PATH, updated, 'utf8');
  console.log(`Written to package.json.`);
}

main().catch((err) => {
  console.error(`[pickPorts] Error: ${err.message}`);
  process.exit(1);
});
