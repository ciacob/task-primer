/**
 * ui/app.js
 *
 * Rendering layer. Reads from the DOM, calls window.adapter, nothing else.
 * Replace this file (and index.html) to swap in React, Vue, etc.
 * The adapter contract is the only interface this file depends on.
 */

(function () {
  'use strict';

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const badge       = document.getElementById('state-badge');
  const statusMsg   = document.getElementById('status-message');
  const progressBar = document.getElementById('progress-bar');
  const progressLbl = document.getElementById('progress-label');
  const log         = document.getElementById('log');
  const connDot     = document.getElementById('conn-dot');
  const connLabel   = document.getElementById('conn-label');

  const btnStart  = document.getElementById('btn-start');
  const btnPause  = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnAbort  = document.getElementById('btn-abort');
  const btnReset  = document.getElementById('btn-reset');

  // ─── State ─────────────────────────────────────────────────────────────────
  let lastPercent = 0;

  // ─── Log helper ────────────────────────────────────────────────────────────
  function logEntry(text, kind) {
    const div = document.createElement('div');
    div.className = 'entry' + (kind ? ' ' + kind : '');
    const ts = new Date().toLocaleTimeString();
    div.textContent = `[${ts}]  ${text}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    // Keep log bounded
    while (log.children.length > 200) log.removeChild(log.firstChild);
  }

  // ─── Render from state ─────────────────────────────────────────────────────
  function render(state) {
    if (!state) return;

    const s = state.state || 'idle';

    // Badge
    badge.textContent = s;
    badge.className   = s;

    // Message
    if (state.message) statusMsg.textContent = state.message;

    // Progress (only update if present in this state push)
    if (typeof state.percent === 'number') {
      lastPercent = state.percent;
    }
    progressBar.style.width = lastPercent + '%';
    progressLbl.textContent = lastPercent + '%';

    // Buttons: which are valid in this state?
    btnStart.disabled  = s !== 'idle';
    btnPause.disabled  = s !== 'running';
    btnResume.disabled = s !== 'paused';
    btnAbort.disabled  = s !== 'running' && s !== 'paused';
    btnReset.disabled  = !['done', 'aborted', 'error'].includes(s);

    // Log notable transitions
    if (state._logEntry) logEntry(state._logEntry, state._logKind);
  }

  // ─── Button handlers ───────────────────────────────────────────────────────
  btnStart.addEventListener('click', async () => {
    logEntry('Assigning example task…');
    await adapter.assign('worker/example-task.js', { steps: 50 });
  });

  btnPause.addEventListener('click', async () => {
    logEntry('Pausing…');
    await adapter.pause();
  });

  btnResume.addEventListener('click', async () => {
    logEntry('Resuming…');
    await adapter.resume();
  });

  btnAbort.addEventListener('click', async () => {
    logEntry('Aborting…', 'error');
    await adapter.abort();
  });

  btnReset.addEventListener('click', async () => {
    logEntry('Resetting to idle…');
    await adapter.reset();
  });

  // ─── Wire up adapter ───────────────────────────────────────────────────────
  adapter.onStateChange((state) => {
    // Decorate with log entries for notable events
    if (state.state === 'done')    { state._logEntry = 'Task completed.'; state._logKind = 'done'; }
    if (state.state === 'error')   { state._logEntry = 'Error: ' + (state.message || '?'); state._logKind = 'error'; }
    if (state.state === 'aborted') { state._logEntry = 'Task aborted.'; state._logKind = 'error'; }
    if (state.state === 'running' && state.message) state._logEntry = state.message;

    // Update progress from TASK_PROGRESS pushes
    if (typeof state.percent === 'number') {
      progressBar.style.width = state.percent + '%';
      progressLbl.textContent = state.percent + '%';
      lastPercent = state.percent;
    }

    render(state);

    // Mark connected
    connDot.className   = 'connected';
    connLabel.textContent = 'connected';
  });

  // Reflect WS reconnection visually
  const _origConnect = adapter._connectWS.bind(adapter);
  adapter._connectWS = function () {
    connDot.className   = '';
    connLabel.textContent = 'reconnecting…';
    _origConnect();
  };

  adapter.connect();
  logEntry('UI ready. Waiting for worker…');
})();
