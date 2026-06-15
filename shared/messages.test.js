// shared/messages.test.js
// Tests for the IPC message contract: constant groups and the msg() factory.
//
// Run: node --test shared/messages.test.js  (from task-primer root)

'use strict';

const { test }  = require('node:test');
const assert    = require('node:assert/strict');
const {
  CMD, EVT, UI_CMD, NOTIFY, INTERNAL, SRV, STATE, msg,
} = require('./messages');

// ── msg() factory ─────────────────────────────────────────────────────────────

test('msg: type-only envelope', () => {
  const m = msg('SOME_TYPE');
  assert.equal(m.type, 'SOME_TYPE');
  assert.ok(!('payload' in m), 'payload should be absent when not provided');
  assert.ok(!('id' in m),      'id should be absent when not provided');
});

test('msg: envelope with payload', () => {
  const m = msg('T', { foo: 1 });
  assert.equal(m.type, 'T');
  assert.deepEqual(m.payload, { foo: 1 });
  assert.ok(!('id' in m));
});

test('msg: envelope with payload and id', () => {
  const m = msg('T', { x: 2 }, 'req-1');
  assert.equal(m.id, 'req-1');
  assert.deepEqual(m.payload, { x: 2 });
});

test('msg: payload=undefined does not add payload key', () => {
  const m = msg('T', undefined);
  assert.ok(!('payload' in m));
});

test('msg: payload=null IS included (intentional falsy value)', () => {
  const m = msg('T', null);
  assert.ok('payload' in m);
  assert.equal(m.payload, null);
});

test('msg: returns a plain object (not a class instance)', () => {
  assert.equal(Object.getPrototypeOf(msg('T')), Object.prototype);
});

// ── CMD ───────────────────────────────────────────────────────────────────────

test('CMD: all keys are unique strings', () => {
  const values = Object.values(CMD);
  const unique  = new Set(values);
  assert.equal(unique.size, values.length, 'CMD values must be unique');
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('CMD: contains expected keys', () => {
  ['ASSIGN', 'PAUSE', 'RESUME', 'ABORT', 'STATUS', 'RESET'].forEach((k) => {
    assert.ok(k in CMD, `CMD.${k} missing`);
  });
});

// ── EVT ───────────────────────────────────────────────────────────────────────

test('EVT: all keys are unique strings', () => {
  const values = Object.values(EVT);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('EVT: contains expected keys', () => {
  ['READY', 'STATUS_UPDATE', 'TASK_DONE', 'TASK_ERROR', 'TASK_PROGRESS'].forEach((k) => {
    assert.ok(k in EVT, `EVT.${k} missing`);
  });
});

// ── UI_CMD ────────────────────────────────────────────────────────────────────

test('UI_CMD: all keys are unique strings', () => {
  const values = Object.values(UI_CMD);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('UI_CMD: contains SET_MENU, PATCH_MENU, SET_DEVTOOLS', () => {
  ['SET_MENU', 'PATCH_MENU', 'SET_DEVTOOLS'].forEach((k) => {
    assert.ok(k in UI_CMD, `UI_CMD.${k} missing`);
  });
});

// ── NOTIFY ────────────────────────────────────────────────────────────────────

test('NOTIFY: all keys are unique strings', () => {
  const values = Object.values(NOTIFY);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('NOTIFY: contains MENU_ACTION, FILE_OPEN, APP_REOPEN', () => {
  ['MENU_ACTION', 'FILE_OPEN', 'APP_REOPEN'].forEach((k) => {
    assert.ok(k in NOTIFY, `NOTIFY.${k} missing`);
  });
});

// ── INTERNAL ──────────────────────────────────────────────────────────────────

test('INTERNAL: all keys are unique strings', () => {
  const values = Object.values(INTERNAL);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('INTERNAL: contains SET_IS_NACRE', () => {
  assert.ok('SET_IS_NACRE' in INTERNAL, 'INTERNAL.SET_IS_NACRE missing');
});

test('INTERNAL.SET_IS_NACRE value starts with INTERNAL_ prefix', () => {
  assert.ok(
    INTERNAL.SET_IS_NACRE.startsWith('INTERNAL_'),
    `Expected INTERNAL_ prefix, got: ${INTERNAL.SET_IS_NACRE}`
  );
});

// ── SRV ───────────────────────────────────────────────────────────────────────

test('SRV: all keys are unique strings', () => {
  const values = Object.values(SRV);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => assert.equal(typeof v, 'string'));
});

test('SRV: contains FORWARD_CMD, READY, STATE_PUSH', () => {
  ['FORWARD_CMD', 'READY', 'STATE_PUSH'].forEach((k) => {
    assert.ok(k in SRV, `SRV.${k} missing`);
  });
});

// ── STATE ─────────────────────────────────────────────────────────────────────

test('STATE: all values are unique lowercase strings', () => {
  const values = Object.values(STATE);
  assert.equal(new Set(values).size, values.length);
  values.forEach((v) => {
    assert.equal(typeof v, 'string');
    assert.equal(v, v.toLowerCase(), `STATE value "${v}" should be lowercase`);
  });
});

test('STATE: contains idle, running, paused, done, aborted, error', () => {
  ['IDLE', 'RUNNING', 'PAUSED', 'DONE', 'ABORTED', 'ERROR'].forEach((k) => {
    assert.ok(k in STATE, `STATE.${k} missing`);
  });
});

// ── Cross-group uniqueness ─────────────────────────────────────────────────────

test('no value is shared across CMD, EVT, UI_CMD, NOTIFY, INTERNAL, SRV', () => {
  const all = [
    ...Object.values(CMD),
    ...Object.values(EVT),
    ...Object.values(UI_CMD),
    ...Object.values(NOTIFY),
    ...Object.values(INTERNAL),
    ...Object.values(SRV),
  ];
  const unique = new Set(all);
  assert.equal(
    unique.size, all.length,
    'Message type values must be globally unique across all groups'
  );
});
