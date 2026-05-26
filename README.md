# task-primer

A resident Node.js work-delegation application built as a **primer** — a clean,
modular foundation onto which real applications can be layered.

```
┌──────────────────────────────────────────────────────────────┐
│                          main.js                             │
│                (process orchestrator, IPC hub)               │
│                                                              │
│   ┌──────────────────┐      ┌─────────────────────────────┐  │
│   │  worker-process  │      │       server-process        │  │
│   │  ┌────────────┐  │ IPC  │   Fastify + WebSocket       │  │
│   │  │ TaskShell  │  │◄────►│   REST  /worker/*           │  │
│   │  │ (state     │  │      │   WS    /ws/status          │  │
│   │  │  machine)  │  │      │   Static /  (UI)            │  │
│   │  └─────┬──────┘  │      └─────────────┬───────────────┘  │
│   │        │         │                    │                  │
│   │  ┌─────▼──────┐  │                    │ WebSocket        │
│   │  │ task module│  │                    ▼                  │
│   │  │ (any CJS   │  │     ┌──────────────────────────────┐  │
│   │  │  module)   │  │     │  Chromium --app window       │  │
│   │  └────────────┘  │     │  (pinned build, our process) │  │
│   └──────────────────┘     │  adapter.js + app.js         │  │
│                            └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
npm install

node main.js                           # headless, port 3000
node main.js --ui                      # download Chromium (once), open app window
node main.js --ui --autoexit           # also exit when the window is closed
node main.js --ui --port 8080          # custom port
node main.js --worker-crash=restart    # auto-restart worker on crash
```

Or via npm scripts:

```bash
npm start             # headless
npm run start:ui      # with browser window
npm run start:dev     # browser + autoexit + auto-restart worker
```

---

## CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Web server port |
| `--host` | `127.0.0.1` | Web server bind address |
| `--ui` | `false` | Download (once) and launch the pinned Chromium build as an app window |
| `--autoexit` | `false` | Exit the application when the Chromium window is closed. Requires `--ui` |
| `--worker-crash` | `report` | `report` or `restart` — what to do if the worker process dies unexpectedly |

---

## Browser window (`--ui`)

The `--ui` flag does not open the user's default browser. Instead it downloads
a **pinned Chrome for Testing** build into `.browsers/` and launches it as a
dedicated app window (`--app` mode — no address bar, no tabs). This has several
deliberate consequences:

- **The browser process is a direct child of `main.js`.** Its exit is detectable
  via a normal Node.js `ChildProcess` `exit` event — no WebSocket heuristics
  needed. This is what makes `--autoexit` reliable.
- **The UI is always tested against a known engine.** No "works in my browser
  but not yours" surface.
- **The window feels like a native app,** not a browser tab.

### First run

The first `--ui` invocation downloads Chromium (~300 MB) and caches it locally:

```
[browser] Chromium 124 (build 1274542) not found in cache.
[browser] Downloading for platform: linux
[browser] This is a one-time download (~300 MB). Please wait…
[browser] Downloading… 5%  …  100%
[browser] Download complete.
[browser] Launching Chromium → http://127.0.0.1:3000
```

Subsequent runs skip straight to the launch line. The cache lives in `.browsers/`
(git-ignored) in the project root.

### Updating the pinned build

The pinned build ID is stored in `package.json` under `taskPrimer.browser`:

```json
"taskPrimer": {
  "browser": {
    "product":   "chrome",
    "buildId":   "1274542",
    "milestone": 124,
    "cacheDir":  ".browsers"
  }
}
```

To update: find the new build ID at
https://googlechromelabs.github.io/chrome-for-testing/, update `buildId` (and
`milestone` for documentation), then delete `.browsers/` so the new build is
downloaded on the next `--ui` run.

---

## REST API

All endpoints are on `http://localhost:3000/worker/`.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/worker/status` | — | Current worker state snapshot |
| `POST` | `/worker/assign` | `{ modulePath, config? }` | Assign and start a task |
| `POST` | `/worker/pause` | — | Pause a running task |
| `POST` | `/worker/resume` | — | Resume a paused task |
| `POST` | `/worker/abort` | — | Abort the current task immediately |
| `POST` | `/worker/reset` | — | Return to `idle` after a terminal state |
| `GET` | `/health` | — | Server liveness check |

### Worker state shape

```json
{
  "state":   "idle | running | paused | done | aborted | error",
  "message": "human-readable status string or null",
  "percent": 0-100 or null
}
```

### Example: assign the bundled task

```bash
curl -X POST http://localhost:3000/worker/assign \
  -H "Content-Type: application/json" \
  -d '{"modulePath": "worker/example-task.js", "config": {"steps": 50}}'
```

### WebSocket live feed

Connect to `ws://localhost:3000/ws/status` to receive every state change as a
JSON push in real time — same shape as the REST status response.

---

## Writing a task module

Any task module must export an object with a `start(context)` method.
`pause`, `resume`, and `abort` are optional but recommended.

```js
// my-task.js
module.exports = {
  _paused: false,

  start(context) {
    // context.config        — the config object passed in the assign call
    // context.isCancelled() — returns true when abort has been requested
    // context.progress(percent, message?) — report progress (0–100)
    // context.done(result?)               — signal successful completion
    // context.fail(error)                 — signal failure

    let i = 0;
    const total = context.config.total ?? 100;

    const tick = () => {
      if (context.isCancelled()) return;
      if (this._paused) return void setTimeout(tick, 100);
      i++;
      context.progress(Math.round(i / total * 100), `step ${i}`);
      if (i >= total) return context.done({ processed: total });
      setTimeout(tick, 50);
    };

    setTimeout(tick, 0);
  },

  pause()  { this._paused = true;  },
  resume() { this._paused = false; },
  abort()  { /* cancel any timers / streams / open handles here */ },
};
```

Assign it via REST:

```bash
curl -X POST http://localhost:3000/worker/assign \
  -H "Content-Type: application/json" \
  -d '{"modulePath": "tasks/my-task.js", "config": {"total": 200}}'
```

`modulePath` is resolved relative to the project root.

---

## Architecture & seams

Every boundary is an explicit, replaceable interface:

| Seam | File(s) | Replace to… |
|------|---------|-------------|
| IPC message contract | `shared/messages.js` | Change transport (e.g. Redis pub/sub) |
| Worker state machine | `worker/task-shell.js` | Add priorities, queuing, timeouts |
| Worker IPC harness | `worker/worker-process.js` | Swap to worker_threads, cluster, etc. |
| Task interface | any module matching the Task Shell interface | Plug in real work |
| Web server | `server/server-process.js` | Swap Fastify for anything |
| REST routes | `server/routes/worker.js` | Version the API, add auth, etc. |
| WebSocket feed | `server/ws/status-feed.js` | Swap for SSE, socket.io, etc. |
| UI transport | `ui/adapter.js` | Change API shape without touching UI |
| UI rendering | `ui/app.js` + `ui/index.html` | Drop in React, Vue, Svelte, etc. |
| Browser launcher | `browser/launcher.js` | Swap Chromium build, flags, or launch strategy |

---

## Project structure

```
task-primer/
├── main.js                    # Entry point — orchestrates all child processes
├── package.json               # taskPrimer.browser block holds the pinned build config
├── .gitignore                 # Excludes node_modules/ and .browsers/
├── shared/
│   └── messages.js            # IPC message type constants and envelope factory
├── worker/
│   ├── worker-process.js      # Child process entry — IPC harness
│   ├── task-shell.js          # State machine + context injection
│   └── example-task.js        # Sample task (configurable-step counter)
├── server/
│   ├── server-process.js      # Child process entry — Fastify web server
│   ├── routes/
│   │   └── worker.js          # REST route handlers
│   └── ws/
│       └── status-feed.js     # WebSocket broadcast plugin
├── browser/
│   └── launcher.js            # Chromium download, cache, and spawn
└── ui/
    ├── index.html             # Minimal control UI
    ├── adapter.js             # UIAdapter — all comms facade
    └── app.js                 # Rendering layer (calls adapter only)
```

---

## pkg compatibility

The project uses only CJS (`require`/`module.exports`) throughout. Two areas
require attention when bundling with `pkg`:

**Task modules** — loaded via a runtime-computed `require(modulePath)` in
`task-shell.js`. pkg cannot trace these statically; they must either be shipped
as external files alongside the binary or loaded from a known asset path
configured at build time.

**Chromium binary** — lives in `.browsers/` on disk, entirely outside any
bundle. When packaging, set `taskPrimer.browser.cacheDir` to a path relative
to `process.execPath` so the cache sits next to the distributed binary:

```js
// In main.js, replace the cacheDir resolution with:
const cacheDir = path.resolve(path.dirname(process.execPath), '.browsers');
```

**Static UI assets** — mark `ui/` as an asset directory in your `pkg`
configuration so `@fastify/static` can serve the files at runtime.
