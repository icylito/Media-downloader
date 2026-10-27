'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { STATE, STATES, canGo, isTerminal, isActive } = require('../main/states');

test('every state has a label and a known kind', () => {
  const kinds = ['pending', 'active', 'ok', 'error'];
  for (const [key, def] of Object.entries(STATES)) {
    assert.ok(def.label && def.label.length > 1, `state ${key} needs a label`);
    assert.ok(kinds.includes(def.kind), `state ${key} has unknown kind ${def.kind}`);
  }
  // every STATE constant is in the table and vice versa
  assert.deepEqual(new Set(Object.values(STATE)), new Set(Object.keys(STATES)));
});

test('normal lifecycle is fully traversable', () => {
  assert.equal(canGo(STATE.QUEUED, STATE.RESOLVING), true);
  assert.equal(canGo(STATE.RESOLVING, STATE.DOWNLOADING), true);
  assert.equal(canGo(STATE.DOWNLOADING, STATE.MUXING), true);
  assert.equal(canGo(STATE.MUXING, STATE.EMBEDDING), true);
  assert.equal(canGo(STATE.EMBEDDING, STATE.DONE), true);
  assert.equal(canGo(STATE.DOWNLOADING, STATE.DONE), true); // progressive formats skip post steps
  assert.equal(canGo(STATE.RESOLVING, STATE.SKIPPED), true); // index hit
  assert.equal(canGo(STATE.QUEUED, STATE.DOWNLOADING), true); // playlists skip the pre-flight
});

test('cancel paths exist from every live state', () => {
  for (const key of [STATE.QUEUED, STATE.RESOLVING, STATE.DOWNLOADING, STATE.MUXING, STATE.EXTRACTING, STATE.EMBEDDING]) {
    assert.equal(canGo(key, STATE.CANCELING) || key === STATE.QUEUED, true, `cancel unreachable from ${key}`);
  }
  assert.equal(canGo(STATE.CANCELING, STATE.CANCELED), true);
});

test('terminal states are final', () => {
  for (const key of [STATE.DONE, STATE.SKIPPED, STATE.CANCELED, STATE.FAILED]) {
    assert.equal(isTerminal(key), true);
    for (const next of Object.values(STATE)) {
      assert.equal(canGo(key, next), key === next, `${key} must not transition to ${next}`);
    }
  }
});

test('impossible transitions are rejected', () => {
  assert.equal(canGo(STATE.QUEUED, STATE.DONE), false);
  assert.equal(canGo(STATE.RESOLVING, STATE.MUXING), false);
  assert.equal(canGo(STATE.CANCELING, STATE.DOWNLOADING), false);
  assert.equal(canGo(STATE.FAILED, STATE.DOWNLOADING), false);
  assert.equal(canGo(STATE.DOWNLOADING, STATE.SKIPPED), false); // skip only via the index path
});

test('playlist items return to downloading for the next entry', () => {
  // yt-dlp restarts the pipeline per playlist item; post-processing states
  // must be able to fall back to downloading or the row freezes
  for (const key of [STATE.MUXING, STATE.EXTRACTING, STATE.EMBEDDING]) {
    assert.equal(canGo(key, STATE.DOWNLOADING), true, `${key} cannot restart for item N+1`);
  }
});

test('isActive covers exactly the in-flight states', () => {
  for (const key of Object.keys(STATES)) {
    assert.equal(isActive(key), ['resolving', 'downloading', 'muxing', 'extracting', 'embedding', 'canceling'].includes(key));
  }
});
