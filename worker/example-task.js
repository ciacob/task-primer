'use strict';

/**
 * worker/example-task.js
 *
 * A sample task that conforms to the Task Shell interface.
 * Counts from 0 to `total` steps with an artificial delay between each.
 *
 * The Task Shell interface (all methods optional except start):
 *
 *   module.exports = {
 *     start(context)  — begin work; use context to communicate
 *     pause()         — suspend work gracefully
 *     resume()        — continue after pause
 *     abort()         — stop immediately, clean up
 *   }
 *
 * context provides:
 *   context.progress(percent, message?)  — report progress (0–100)
 *   context.done(result?)               — signal successful completion
 *   context.fail(error)                 — signal failure
 *   context.config                      — the task's config object
 *   context.isCancelled()               — poll to check for abort
 */

const TICK_MS    = 200;   // ms between steps
const TOTAL_STEPS = 50;   // steps to completion

module.exports = {
  _timer:   null,
  _step:    0,
  _paused:  false,
  _context: null,

  start(context) {
    this._context = context;
    this._step    = 0;
    this._paused  = false;

    const total = context.config?.steps ?? TOTAL_STEPS;

    const tick = () => {
      if (context.isCancelled()) return;

      if (this._paused) {
        // Re-schedule ourselves to check again later
        this._timer = setTimeout(tick, TICK_MS);
        return;
      }

      this._step += 1;
      const percent = Math.round((this._step / total) * 100);
      context.progress(percent, `Step ${this._step} of ${total}`);

      if (this._step >= total) {
        context.done({ stepsCompleted: total });
        return;
      }

      this._timer = setTimeout(tick, TICK_MS);
    };

    this._timer = setTimeout(tick, TICK_MS);
  },

  pause() {
    this._paused = true;
  },

  resume() {
    this._paused = false;
  },

  abort() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },
};
