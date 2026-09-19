import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CANCEL_DISTANCE, HOLD_DELAY, HoldGesture } from './hold.ts';

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
  assert.deepEqual(f.calls, [], 'release must not remove the touch target before touchend/click');
  f.gesture.click();
  f.gesture.click();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.calls, ['focus']);
  assert.equal(f.captured(), undefined);
  assert.equal(f.gesture.getSnapshot(), false);
});
test('only a completed, still-eligible short tap can focus from click', async t => {
  for (const kind of ['no-press', 'cancelled', 'interrupted-after-release', 'blocked-after-release', 'outside', 'held', 'new-press']) {
    await t.test(kind, t => {
      const f = fixture(t);
      if (kind !== 'no-press') {
        f.gesture.down(point, f.surface);
        if (kind === 'held') t.mock.timers.tick(HOLD_DELAY);
        if (kind === 'cancelled') f.gesture.cancel();
        f.gesture.up(kind === 'outside' ? { ...point, clientX: 500 } : point);
        if (kind === 'interrupted-after-release') f.gesture.cancel();
        if (kind === 'blocked-after-release') f.allowed(false);
        if (kind === 'new-press') f.gesture.down({ ...point, pointerId: 2 }, f.surface);
      }
      f.gesture.click();
      assert.equal(f.calls.includes('focus'), false);
      f.gesture.cancel();
      f.allowed(true);
      f.gesture.click();
      assert.equal(f.calls.includes('focus'), false, 'a discarded click cannot become eligible later');
    });
  }
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
test('upward cancellation is irreversible even when capture continues and the pointer returns', async t => {
  for (const stage of ['waiting', 'permission', 'recording', 'retry']) {
    for (const outside of [{ clientY: point.clientY - CANCEL_DISTANCE }, { clientY: point.clientY - CANCEL_DISTANCE - 10 }]) {
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
test('release checks upward distance even when no move event was delivered', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.phase('recording');
  f.gesture.up({ ...point, clientY: point.clientY - CANCEL_DISTANCE });
  assert.deepEqual(f.calls, ['start', 'cancel']);
});
test('sideways, downward and small upward movement allow release outside the original input', async t => {
  for (const move of [{ clientX: -100 }, { clientX: 500 }, { clientY: 500 }, { clientY: point.clientY - CANCEL_DISTANCE + 1 }]) {
    await t.test(JSON.stringify(move), t => {
      const f = fixture(t);
      f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY); f.phase('recording');
      f.bounds({ left: 1000, top: 1000, right: 1100, bottom: 1050 });
      f.gesture.move({ ...point, ...move }); f.gesture.up({ ...point, ...move });
      assert.deepEqual(f.calls, ['start', 'stop']);
    });
  }
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
test('a recording failure keeps the existing retry on release, but upward cancellation destroys it', t => {
  const f = fixture(t);
  f.gesture.down(point, f.surface); t.mock.timers.tick(HOLD_DELAY);
  f.phase('retry'); f.gesture.up(point);
  assert.deepEqual(f.calls, ['start']);
});
