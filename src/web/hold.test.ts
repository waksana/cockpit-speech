import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { HOLD_DELAY, HoldGesture } from './hold.ts';

const point = { pointerId: 1, clientX: 20, clientY: 20, button: 0, isPrimary: true };
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  let allowed = true;
  let phase = 'idle';
  let captured: number | undefined;
  let bounds = { left: 10, top: 10, right: 110, bottom: 50 };
  const surface = {
    setPointerCapture(id: number) { captured = id; },
    hasPointerCapture(id: number) { return captured === id; },
    releasePointerCapture(id: number) { captured = undefined; gesture.lost(id); },
  };
  const gesture = new HoldGesture({
    allowed: () => allowed && phase === 'idle',
    bounds: () => bounds,
    phase: () => phase,
    start: () => { calls.push('start'); phase = 'permission'; },
    stop: () => { calls.push('stop'); phase = 'transcribing'; },
    cancel: () => { calls.push('cancel'); phase = 'idle'; },
    focus: () => calls.push('focus'),
  });
  t.after(gesture.cancel);
  return { gesture, surface, calls, captured: () => captured,
    bounds: (value: typeof bounds) => { bounds = value; },
    allowed: (value: boolean) => { allowed = value; },
    phase: (value: string) => { phase = value; } };
}
test('short tap focuses the real editor without acquiring a microphone', t => {
  const f = fixture(t);
  assert.equal(f.gesture.down(point, f.surface), true);
  t.mock.timers.tick(HOLD_DELAY - 1);
  f.gesture.up(point);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.calls, ['focus']);
  assert.equal(f.captured(), undefined);
  assert.equal(f.gesture.getSnapshot(), false);
});
test('long hold starts once, then release inside stops only a ready recording', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface);
  t.mock.timers.tick(HOLD_DELAY);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.calls, ['start']);
  f.phase('recording');
  f.gesture.up(point);
  f.gesture.lost(point.pointerId);
  f.gesture.up(point);
  assert.deepEqual(f.calls, ['start', 'stop'], 'normal capture release never cancels a committed gesture');
});
test('leaving any edge is irreversible even when capture continues and the pointer returns', async t => {
  for (const stage of ['waiting', 'permission', 'recording', 'retry']) {
    for (const outside of [{ clientX: 9 }, { clientX: 110 }, { clientY: 9 }, { clientY: 50 }]) {
      await t.test(`${stage} ${JSON.stringify(outside)}`, t => {
        const f = fixture(t);
        f.gesture.down(point, f.surface);
        if (stage !== 'waiting') { t.mock.timers.tick(HOLD_DELAY); f.phase(stage); }
        f.gesture.move({ ...point, ...outside });
        f.gesture.move(point);
        f.gesture.up(point);
        t.mock.timers.tick(1000);
        assert.deepEqual(f.calls, stage === 'waiting' ? [] : ['start', 'cancel']);
        assert.equal(f.captured(), undefined);
      });
    }
  }
});
test('release checks coordinates even when no move event was delivered', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.phase('recording');
  f.gesture.up({ ...point, clientX: 200 });
  assert.deepEqual(f.calls, ['start', 'cancel']);
});
test('unrelated scrolling preserves a hold, but moving the input away cancels it', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY); f.phase('recording');
  f.gesture.checkBounds();
  assert.deepEqual(f.calls, ['start']);
  f.bounds({ left: 10, top: 30, right: 110, bottom: 70 });
  f.gesture.checkBounds();
  assert.deepEqual(f.calls, ['start', 'cancel']);
  f.bounds({ left: 10, top: 10, right: 110, bottom: 50 });
  f.gesture.checkBounds(); f.gesture.up(point);
  assert.deepEqual(f.calls, ['start', 'cancel']);
});
test('release during permission aborts rather than scheduling a later stop', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.gesture.up(point); f.phase('recording');
  f.gesture.up(point);
  assert.deepEqual(f.calls, ['start', 'cancel']);
});
test('capture loss, system cancellation and disposal cancel active holds and pending timers', async t => {
  for (const started of [false, true]) {
    for (const reason of ['capture', 'system', 'dispose']) {
      await t.test(`${reason} started=${started}`, t => {
        const f = fixture(t);
        f.gesture.down(point, f.surface);
        if (started) t.mock.timers.tick(HOLD_DELAY);
        if (reason === 'capture') f.gesture.lost(point.pointerId);
        else f.gesture.cancel();
        f.gesture.up(point); t.mock.timers.tick(1000);
        assert.deepEqual(f.calls, started ? ['start', 'cancel'] : []);
      });
    }
  }
});
test('content/focus/gates block entry and are checked again before starting', t => {
  const f = fixture(t);
  f.allowed(false);
  assert.equal(f.gesture.down(point, f.surface), false);
  f.allowed(true);
  assert.equal(f.gesture.down({ ...point, button: 2 }, f.surface), false);
  assert.equal(f.gesture.down({ ...point, isPrimary: false }, f.surface), false);
  f.gesture.down(point, f.surface);
  f.allowed(false);
  t.mock.timers.tick(HOLD_DELAY);
  f.gesture.up(point);
  assert.deepEqual(f.calls, []);
});
test('a second pointer cancels the first; unrelated releases cannot stop it', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.gesture.up({ ...point, pointerId: 2 });
  assert.deepEqual(f.calls, ['start']);
  assert.equal(f.gesture.down({ ...point, pointerId: 2, isPrimary: false }, f.surface), false);
  f.gesture.up(point);
  assert.deepEqual(f.calls, ['start', 'cancel']);
});
test('a recording failure keeps the existing retry on release, but exit destroys it', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.phase('retry'); f.gesture.up(point);
  assert.deepEqual(f.calls, ['start']);
});
