/** Visual viewport geometry and resource ownership, independent of a DOM renderer. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewportFrame, watchViewport } from '../src/viewport.js';

test('uses the visible rectangle for keyboard resize and browser panning', () => {
  assert.deepEqual(viewportFrame({ width: 390, height: 410, offsetTop: 92, offsetLeft: 0, scale: 1 }),
    { width: 390, height: 410, top: 92, left: 0 });
  assert.deepEqual(viewportFrame({ width: 844, height: 230, offsetTop: 0, offsetLeft: 12, scale: 1 }),
    { width: 844, height: 230, top: 0, left: 12 });
  assert.deepEqual(viewportFrame({ width: 390, height: 750, offsetTop: 0, offsetLeft: 0, scale: 1 }),
    { width: 390, height: 750, top: 0, left: 0 });
});

test('suspends tracking during pinch zoom and transient empty frames', () => {
  assert.equal(viewportFrame({ width: 195, height: 200, offsetTop: 100, offsetLeft: 20, scale: 2 }), null);
  assert.equal(viewportFrame({ width: 390, height: 0, offsetTop: 0, offsetLeft: 0, scale: 1 }), null);
});

test('coalesces updates and releases listeners and pending frames on disposal', () => {
  const viewport = new EventTarget();
  const page = new EventTarget();
  const pending = new Map();
  let nextId = 0;
  let reads = 0;
  let height = 750;
  const results = [];
  const dispose = watchViewport({
    viewport, page,
    requestFrame(callback) { pending.set(++nextId, callback); return nextId; },
    cancelFrame(id) { pending.delete(id); },
    read() { reads++; return { height }; },
  }, value => { results.push(value); });
  assert.equal(reads, 1);
  height = 410;
  viewport.dispatchEvent(new Event('resize'));
  viewport.dispatchEvent(new Event('scroll'));
  page.dispatchEvent(new Event('resize'));
  assert.equal(pending.size, 1);
  const [id, callback] = pending.entries().next().value;
  pending.delete(id);
  callback();
  assert.deepEqual(results, [{ height: 750 }, { height: 410 }]);
  page.dispatchEvent(new Event('pageshow'));
  assert.equal(pending.size, 1);
  dispose();
  assert.equal(pending.size, 0);
  viewport.dispatchEvent(new Event('resize'));
  page.dispatchEvent(new Event('pageshow'));
  assert.equal(pending.size, 0);
  assert.equal(reads, 2);
});
