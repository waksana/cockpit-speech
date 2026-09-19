import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { KeyboardHold, keyboardSurfaceAvailable } from './keyboard.ts';
import { keyboardDOM } from './keyboard.fixture.test.ts';

function fixture(t: TestContext) {
  const dom = keyboardDOM();
  const editor = dom.editor();
  const keyboard = new KeyboardHold();
  let phase = 'idle', starts = 0, releases = 0, interrupts = 0, cancels = 0;
  let available = true, empty = true, canContinue = true, canStart = true;
  const target = {
    editor: () => editor as unknown as HTMLTextAreaElement,
    available: () => available, empty: () => empty, canContinue: () => canContinue,
    canStart: () => canStart && phase === 'idle', phase: () => phase,
    start() { starts++; phase = 'permission'; }, release() { releases++; phase = 'stopping'; },
    interrupt() { interrupts++; phase = phase === 'permission' ? 'idle' : 'stopping'; },
    cancel() { cancels++; phase = 'idle'; },
  };
  const register = (value = target) => keyboard.register(value, dom.document as unknown as Document, dom.window as unknown as Window);
  const unregister = register();
  t.after(keyboard.dispose);
  return {
    ...dom, editor, keyboard, target, register, unregister,
    phase: (value: string) => { phase = value; },
    gate: (value: Partial<{ available: boolean; empty: boolean; canContinue: boolean; canStart: boolean }>) => {
      available = value.available ?? available; empty = value.empty ?? empty;
      canContinue = value.canContinue ?? canContinue; canStart = value.canStart ?? canStart;
    },
    counts: () => ({ starts, releases, interrupts, cancels }),
  };
}

test('F8 starts immediately without editor focus and releases once only after readiness', t => {
  const f = fixture(t);
  assert.equal(f.key('keydown').defaultPrevented, true);
  f.key('keydown', { repeat: true });
  f.phase('recording');
  f.key('keyup'); f.key('keyup');
  assert.deepEqual(f.counts(), { starts: 1, releases: 1, interrupts: 0, cancels: 0 });
});

test('a fresh non-repeat down after a missing keyup interrupts rather than sending the old take', t => {
  const f = fixture(t);
  f.key('keydown'); f.phase('recording');
  f.key('keydown'); f.key('keyup');
  assert.deepEqual(f.counts(), { starts: 1, releases: 0, interrupts: 1, cancels: 0 });
  f.phase('idle'); f.key('keydown'); f.phase('recording'); f.key('keyup');
  assert.equal(f.counts().releases, 1);
});

test('startup release cancels; repeat, modifiers, IME and consumed keys never start', t => {
  const f = fixture(t);
  for (const patch of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true },
    { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'F7' }]) {
    f.key('keydown', patch); f.key('keyup');
  }
  assert.equal(f.counts().starts, 0);
  f.document.dispatchEvent(new Event('compositionstart'));
  f.key('keydown'); f.key('keyup');
  f.document.dispatchEvent(new Event('compositionend'));
  const consumed = Object.assign(new Event('keydown', { cancelable: true }), { key: 'F8' });
  consumed.preventDefault(); f.document.dispatchEvent(consumed); f.key('keyup');
  assert.equal(f.counts().starts, 0);
  f.key('keydown'); f.key('keyup');
  assert.deepEqual(f.counts(), { starts: 1, releases: 0, interrupts: 0, cancels: 1 });
});

test('page-wide focus permits other controls; unavailable editors and native modal exclusion still block', t => {
  const f = fixture(t);
  const allowed = () => keyboardSurfaceAvailable(f.target.editor());
  assert.equal(allowed(), true);
  f.editor.focus(); assert.equal(allowed(), true);
  f.document.activeElement = { closest: () => ({}) }; assert.equal(allowed(), true);
  f.document.activeElement = f.document.body;
  for (const change of ['hidden', 'detached', 'display', 'visibility', 'offscreen', 'disabled', 'readonly', 'blur', 'tab', 'modal']) {
    const restore = { ...f.editor, style: { ...f.editor.style } };
    if (change === 'hidden') f.editor.hidden = true;
    if (change === 'detached') f.editor.isConnected = false;
    if (change === 'display') f.editor.style.display = 'none';
    if (change === 'visibility') f.editor.style.visibility = 'hidden';
    if (change === 'offscreen') f.editor.rect = { left: 0, right: 200, top: 900, bottom: 980 };
    if (change === 'disabled') f.editor.disabled = true;
    if (change === 'readonly') f.editor.readOnly = true;
    if (change === 'blur') f.document.focused = false;
    if (change === 'tab') f.document.visibilityState = 'hidden';
    if (change === 'modal') f.document.overlays = [{ contains: () => false }];
    assert.equal(allowed(), false, change);
    f.key('keydown'); f.key('keyup');
    Object.assign(f.editor, restore);
    f.document.focused = true; f.document.visibilityState = 'visible'; f.document.overlays = [];
  }
  assert.equal(f.counts().starts, 0);
  f.document.overlays = [f.editor];
  assert.equal(allowed(), true, 'a current writable editor inside the native modal remains eligible');
});

test('focus moving between ordinary controls does not revoke a ready keyboard hold', t => {
  const f = fixture(t);
  f.document.activeElement = { closest: () => ({}) };
  f.key('keydown'); f.phase('recording');
  f.document.activeElement = { closest: () => ({}) };
  f.document.dispatchEvent(new Event('focusin'));
  f.key('keyup');
  assert.deepEqual(f.counts(), { starts: 1, releases: 1, interrupts: 0, cancels: 0 });
});

test('unavailable, nonempty and competing capture gates do not consume F8', t => {
  const f = fixture(t);
  for (const gate of ['available', 'empty', 'canStart'] as const) {
    f.gate({ [gate]: false });
    assert.equal(f.key('keydown').defaultPrevented, false);
    f.key('keyup'); f.gate({ [gate]: true });
  }
  assert.equal(f.counts().starts, 0);
});

test('interruption drains without sending and keeps a latch through missing and late keyup', async t => {
  for (const reason of ['blur', 'pagehide', 'resize', 'hidden', 'modal', 'pointer', 'composition', 'other-key', 'unavailable', 'external-text', 'unmount']) {
    await t.test(reason, t => {
      const f = fixture(t);
      f.key('keydown'); f.phase('recording');
      if (['blur', 'pagehide', 'resize'].includes(reason)) f.window.dispatchEvent(new Event(reason));
      if (reason === 'hidden') { f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange')); }
      if (reason === 'modal') { f.document.overlays = [{ contains: () => false }]; f.mutate(); }
      if (reason === 'pointer') f.document.dispatchEvent(new Event('pointerdown'));
      if (reason === 'composition') f.document.dispatchEvent(new Event('compositionstart'));
      if (reason === 'other-key') f.key('keydown', { key: 'Tab' });
      if (reason === 'unavailable') { f.gate({ available: false }); f.keyboard.refresh(); }
      if (reason === 'external-text') { f.gate({ canContinue: false }); f.keyboard.refresh(); }
      if (reason === 'unmount') f.unregister();
      f.key('keydown', { repeat: true }); f.key('keydown');
      f.key('keyup'); f.key('keyup');
      assert.deepEqual(f.counts(), { starts: 1, releases: 0, interrupts: 1, cancels: 0 });
    });
  }
});

test('Escape cancels, failed captures retain retry, and modified keyup cannot authorize', t => {
  const f = fixture(t);
  f.key('keydown'); f.phase('recording'); f.key('keydown', { key: 'Escape' }); f.key('keyup');
  assert.equal(f.counts().cancels, 1);
  f.key('keydown'); f.phase('retry'); f.key('keyup');
  assert.equal(f.counts().cancels, 1, 'release must not destroy retained failed audio');
  f.phase('idle'); f.key('keydown'); f.phase('recording'); f.key('keyup', { altKey: true });
  assert.equal(f.counts().releases, 0);
});

test('multiple composers, duplicate registration, rebinding and disposal never duplicate or redirect', t => {
  const f = fixture(t);
  const second = { ...f.target, editor: () => f.editor as unknown as HTMLTextAreaElement };
  const removeSecond = f.register(second);
  f.key('keydown'); f.key('keyup');
  assert.equal(f.counts().starts, 0, 'ambiguous visible composers are not arbitrarily selected');
  removeSecond();
  f.key('keydown'); f.phase('recording'); f.unregister();
  const removeReplacement = f.register(second);
  f.phase('idle');
  f.key('keydown', { repeat: true }); f.key('keyup');
  assert.equal(f.counts().starts, 1);
  f.key('keydown'); f.phase('recording'); f.key('keyup');
  assert.equal(f.counts().releases, 1);
  assert.equal(f.observers(), 1, 'rebindings share one listener/observer set');
  removeReplacement(); f.keyboard.dispose();
  f.key('keydown'); f.key('keyup');
  assert.equal(f.counts().starts, 2);
  assert.equal(f.observers(), 0);
});
