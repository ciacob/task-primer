'use strict';

/**
 * browser/nacre-ui.js
 *
 * Provides the NacreUI class used by main.js to drive the native macOS UI
 * (menu bar, developer tools) and receive UI events from nacre.
 *
 * Two implementations, same interface:
 *
 *   NacreUI        — real implementation; wraps the already-open nacre socket.
 *                    Constructed by launchNacre() and returned to main.js.
 *
 *   NacreUIStub    — no-op implementation for CfT / npm mode.
 *                    All send methods log a warning and return.
 *                    Event handlers are registered but never called.
 *                    main.js uses this when browser.product !== 'nacre'.
 *
 * Public interface (both classes):
 *
 *   // Outbound — drive native UI
 *   ui.setMenu(menus)           → set_menu
 *   ui.patchMenu(patches)       → patch_menu
 *   ui.setDevTools(enabled)     → set_devtools
 *
 *   // Inbound — native UI events
 *   ui.on('menuAction',  (id)     => {})
 *   ui.on('fileOpen',    (paths)  => {})
 *   ui.on('appReopen',   ()       => {})
 *   ui.on('windowClosed',()       => {})   // already handled by main.js; also exposed here
 *
 *   // Mode query
 *   ui.isNacre   → true | false
 */

const { EventEmitter } = require('events');

// ── Real implementation ───────────────────────────────────────────────────────

class NacreUI extends EventEmitter {

  /**
   * @param {net.Socket} sock  The already-connected nacre Unix socket,
   *                           as returned by connectToNacre() in launcher.js.
   */
  constructor(sock) {
    super();
    this._sock = sock;
    this.isNacre = true;
  }

  // ── Outbound ────────────────────────────────────────────────────────────────

  /**
   * Replace the entire menu bar.
   * @param {Array} menus  Array of MenuDescriptor objects.
   */
  setMenu(menus) {
    if (!Array.isArray(menus)) {
      console.warn('[nacre-ui] setMenu: expected an array of menu descriptors');
      return;
    }
    this._send({ type: 'set_menu', menus });
  }

  /**
   * Update specific menu items by id without rebuilding the whole bar.
   * @param {Array} patches  Array of { id, label?, enabled?, checked? }.
   */
  patchMenu(patches) {
    if (!Array.isArray(patches)) {
      console.warn('[nacre-ui] patchMenu: expected an array of patch objects');
      return;
    }
    this._send({ type: 'patch_menu', patches });
  }

  /**
   * Enable or disable the WebKit developer tools (Web Inspector).
   * @param {boolean} enabled
   */
  setDevTools(enabled) {
    this._send({ type: 'set_devtools', enabled: Boolean(enabled) });
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Called by launchNacre() to deliver a parsed inbound nacre message.
   * Translates from the wire protocol to EventEmitter events.
   * @param {object} msg  Parsed JSON frame from the nacre socket.
   */
  _handleInbound(msg) {
    switch (msg.type) {
      case 'menu_action':
        this.emit('menuAction', msg.id);
        break;
      case 'file_open':
        this.emit('fileOpen', msg.paths);
        break;
      case 'app_reopen':
        this.emit('appReopen');
        break;
      case 'window_closed':
        this.emit('windowClosed');
        break;
      default:
        // Unknown event — ignore silently
        break;
    }
  }

  _send(message) {
    try {
      this._sock.write(JSON.stringify(message) + '\n');
    } catch (err) {
      console.warn(`[nacre-ui] socket write error: ${err.message}`);
    }
  }
}

// ── No-op stub (CfT / npm mode) ───────────────────────────────────────────────

class NacreUIStub extends EventEmitter {

  constructor() {
    super();
    this.isNacre = false;
  }

  setMenu(_menus) {
    console.warn('[nacre-ui] setMenu: no-op — not running in nacre mode');
  }

  patchMenu(_patches) {
    console.warn('[nacre-ui] patchMenu: no-op — not running in nacre mode');
  }

  setDevTools(_enabled) {
    console.warn('[nacre-ui] setDevTools: no-op — not running in nacre mode');
  }

  // _handleInbound is never called on the stub, but defined for safety
  _handleInbound(_msg) {}
}

module.exports = { NacreUI, NacreUIStub };
