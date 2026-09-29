import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reuse an installed Puppeteer (including Chrome DevTools MCP's bundled driver).
// The host Chat Lab must already be running via serve-chat-lab.mjs.
const driver = await import(pathToFileURL(resolve(process.env.PUPPETEER_MODULE)).href);
const puppeteer = driver.puppeteer ?? driver.default;
const root = resolve(import.meta.dirname, '../..');
const fixture = `/@fs${root}/scripts/browser/f8.fixture.mjs`;
const entry = `/@fs${root}/dist/web/index.js`;

test('compiled Speech on pinned v3 Chat Lab: page-wide input and public owner ACK', async t => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
    args: process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  t.after(() => browser.close());
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', dialog => void dialog.accept());
  await page.setViewport({ width: 1280, height: 900 });
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  // Defense in depth: even an accidental fixture regression cannot send cloud audio.
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:5187' || ['data:', 'blob:'].includes(url.protocol)) void request.continue();
    else { failures.push(`Unexpected external request: ${url.origin}`); void request.abort(); }
  });
  const setup = async (scene = 'reading', options = {}) => {
    await page.evaluate(() => {
      if (location.origin === 'http://127.0.0.1:5187') { localStorage.clear(); sessionStorage.clear(); }
    });
    await page.goto(`http://127.0.0.1:5187/chat-lab.html?scene=${scene}`);
    await page.evaluate(async (fixture, entry, options) => {
      const { installSpeechFixture } = await import(fixture);
      window.f = await installSpeechFixture(entry, options);
    }, fixture, entry, options);
    await page.bringToFront();
  };
  const counts = () => page.evaluate(() => ({ ...f.counts(), sends: f.sends.length }));
  const ready = () => page.waitForFunction(() => f.recording());
  const idle = () => page.waitForFunction(() => !document.querySelector('.cockpit-speech-status'));
  const send = async () => {
    const before = await counts();
    await page.keyboard.down('F8');
    await ready();
    await page.keyboard.up('F8');
    await page.waitForFunction(n => f.sends.length === n, {}, before.sends + 1);
    await idle();
    assert.equal((await counts()).captures, before.captures + 1);
  };
  const blocked = async () => {
    const before = await counts();
    await page.keyboard.press('F8');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await counts(), before);
  };

  await setup();
  await t.test('first open without clicking textarea', async () => {
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
    await send();
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  });
  await t.test('clicking blank chat body (host focusable transcript)', async () => {
    await page.click('.chat-messages', { offset: { x: 4, y: 4 } });
    const active = await page.evaluate(() => document.activeElement.className);
    await send();
    assert.equal(await page.evaluate(() => document.activeElement.className), active);
  });
  for (const [label, selector] of [
    ['ordinary button', '.chat-topbar-content'],
    ['navigation link', '.lab-toolbar a'],
    ['select', '.lab-toolbar select'],
    ['checkbox', '.lab-toolbar input'],
    ['textarea', '.cockpit-speech-input textarea'],
  ]) {
    await t.test(`${label} focus, repeat and unchanged focus`, async () => {
      await page.focus(selector);
      await page.evaluate(() => { window.originalFocus = document.activeElement; });
      const before = await counts();
      await page.keyboard.down('F8'); await ready();
      await page.keyboard.down('F8');
      assert.equal((await counts()).captures, before.captures + 1);
      await page.keyboard.up('F8');
      await page.waitForFunction(n => f.sends.length === n, {}, before.sends + 1);
      await idle();
      assert.equal(await page.evaluate(() => document.activeElement === originalFocus), true);
    });
  }
  await t.test('other editor content and selection untouched; stopped bubbling cannot hide F8', async () => {
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'other-editor'; input.value = 'untouched';
      document.querySelector('.lab-toolbar').append(input);
      input.addEventListener('keydown', event => event.stopPropagation());
      input.addEventListener('keyup', event => event.stopPropagation());
      input.focus(); input.setSelectionRange(2, 5);
    });
    await send();
    assert.deepEqual(await page.$eval('#other-editor', e => [e.value, e.selectionStart, e.selectionEnd, e === document.activeElement]),
      ['untouched', 2, 5, true]);
  });
  await t.test('nonempty draft and space-only draft remain excluded', async () => {
    for (const text of ['existing draft', ' ']) {
      await page.evaluate(text => f.draft().edit(text), text);
      await page.waitForFunction(text => f.editor().value === text, {}, text);
      await blocked();
      assert.equal(await page.evaluate(() => f.editor().value), text);
    }
    await page.evaluate(() => f.draft().edit(''));
  });
  await t.test('nonmodal dialog/popover/ARIA role do not veto an available chat', async () => {
    for (const kind of ['dialog', 'popover', 'aria-modal']) {
      await page.evaluate(kind => {
        const overlay = document.createElement(kind === 'dialog' ? 'dialog' : 'div');
        overlay.id = 'overlay'; overlay.innerHTML = '<input value="overlay text">';
        document.body.append(overlay);
        if (kind === 'dialog') overlay.show();
        else if (kind === 'popover') { overlay.popover = 'manual'; overlay.showPopover(); }
        else { overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); }
        overlay.querySelector('input').focus();
      }, kind);
      await send();
      assert.equal(await page.$eval('#overlay input', e => e.value), 'overlay text');
      await page.$eval('#overlay', e => e.remove());
    }
  });
  await t.test('native modal makes outside editor unavailable, not an editor inside it', async () => {
    await page.evaluate(() => {
      const dialog = document.createElement('dialog'); dialog.id = 'modal';
      dialog.innerHTML = '<input value="modal text">';
      document.body.append(dialog); dialog.showModal();
    });
    await blocked();
    await page.evaluate(() => {
      window.stage = document.querySelector('.lab-stage');
      window.stageNext = stage.nextSibling;
      window.stageParent = stage.parentNode;
      document.querySelector('#modal').append(stage);
      document.querySelector('#modal input').focus();
    });
    await send();
    await page.evaluate(() => {
      stageParent.insertBefore(stage, stageNext);
      document.querySelector('#modal').remove();
    });
  });
  await t.test('hidden, inert, readonly, disabled fieldset, offscreen and disconnected host gates', async () => {
    for (const gate of ['hidden', 'inert', 'readOnly', 'disabled', 'fieldset', 'offscreen', 'connected']) {
      await page.evaluate(gate => {
        const editor = f.editor();
        if (gate === 'connected') f.updateView({ connected: false });
        else if (gate === 'fieldset') {
          const fieldset = document.createElement('fieldset'); fieldset.id = 'disabled-parent'; fieldset.disabled = true;
          editor.before(fieldset); fieldset.append(editor);
        } else if (gate === 'offscreen') editor.style.transform = 'translateX(-9999px)';
        else editor[gate] = true;
      }, gate);
      await blocked();
      await page.evaluate(gate => {
        const editor = f.editor();
        if (gate === 'connected') f.updateView();
        else if (gate === 'fieldset') {
          const fieldset = document.querySelector('#disabled-parent');
          fieldset.before(editor); fieldset.remove();
        } else if (gate === 'offscreen') editor.style.transform = '';
        else editor[gate] = false;
      }, gate);
    }
  });
  await t.test('startup release closes a late permission grant without sending', async () => {
    await page.evaluate(() => f.holdPermission(true));
    const before = await counts();
    await page.keyboard.press('F8');
    await page.evaluate(() => { f.grant(); f.holdPermission(false); });
    await idle();
    assert.deepEqual(await counts(), { captures: before.captures + 1, stops: before.stops + 1, sends: before.sends });
  });
  await t.test('modifiers, IME and Escape', async () => {
    for (const modifier of ['Alt', 'Control', 'Meta', 'Shift']) {
      await page.keyboard.down(modifier); await blocked(); await page.keyboard.up(modifier);
    }
    await page.evaluate(() => document.activeElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await blocked();
    await page.evaluate(() => document.activeElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    const before = await counts();
    await page.keyboard.down('F8'); await ready();
    await page.keyboard.press('Escape'); await page.keyboard.up('F8'); await idle();
    assert.equal((await counts()).sends, before.sends);
  });
  await t.test('actual window departure and late keyup never send', async () => {
    const before = await counts();
    await page.keyboard.down('F8'); await ready();
    const other = await context.newPage();
    await other.bringToFront();
    await page.waitForFunction(() => !f.recording());
    await other.close();
    await page.bringToFront();
    await page.keyboard.up('F8'); await idle();
    assert.equal((await counts()).sends, before.sends);
    assert.equal(await page.evaluate(() => f.draft().getSnapshot().text), 'Synthetic F8 transcript');
    await page.evaluate(() => f.draft().edit(''));
  });
  for (const afterRelease of [false, true]) {
    await t.test(`session switch ${afterRelease ? 'after' : 'before'} release keeps original intent`, async () => {
      const before = await counts();
      await page.evaluate(() => { window.originalDraft = f.draft(); f.holdResult(true); });
      await page.keyboard.down('F8'); await ready();
      if (afterRelease) await page.keyboard.up('F8');
      await page.evaluate(() => f.scene('empty'));
      if (!afterRelease) await page.keyboard.up('F8');
      await page.waitForFunction(() => f.resultPending());
      await page.evaluate(() => { f.finish(); f.holdResult(false); });
      if (afterRelease) {
        await page.waitForFunction(n => f.sends.length === n, {}, before.sends + 1);
        assert.equal(await page.evaluate(() => f.sends.at(-1).body.sessionId), 'chat-lab-reading');
      } else {
        await page.waitForFunction(() => originalDraft.getSnapshot().text === 'Synthetic F8 transcript');
        assert.equal((await counts()).sends, before.sends);
      }
      assert.equal(await page.evaluate(() => f.editor().value), '');
      await page.evaluate(() => { originalDraft.edit(''); return f.scene('reading'); });
      await send();
    });
  }
  await t.test('target becomes unavailable while held; late release is draft-only', async () => {
    const before = await counts();
    await page.keyboard.down('F8'); await ready();
    await page.evaluate(() => { f.editor().readOnly = true; });
    await page.waitForFunction(() => !f.recording());
    await page.keyboard.up('F8'); await idle();
    assert.equal((await counts()).sends, before.sends);
    await page.evaluate(() => { f.editor().readOnly = false; f.draft().edit(''); });
  });
  await t.test('focus alone may move while held; pointer takeover still cannot send', async () => {
    await page.keyboard.down('F8'); await ready();
    await page.focus('.lab-toolbar select');
    const before = await counts();
    await page.keyboard.up('F8');
    await page.waitForFunction(n => f.sends.length === n, {}, before.sends + 1);
    await idle();
    await page.keyboard.down('F8'); await ready();
    await page.click('.chat-topbar-content');
    await page.keyboard.up('F8'); await idle();
    assert.equal((await counts()).sends, before.sends + 1);
    await page.evaluate(() => f.draft().edit(''));
  });
  await t.test('module unload detaches captured listeners and late keyup', async () => {
    const before = await counts();
    await page.keyboard.down('F8'); await ready();
    await page.evaluate(() => f.runtime.stop());
    await page.keyboard.up('F8'); await blocked();
    assert.equal((await counts()).sends, before.sends);
  });
  assert.deepEqual(await page.evaluate(() => f.errors), []);
  await t.test('real workspace sidebar button focus', async () => {
    await setup('workspace');
    await page.evaluate(() => f.draft().edit(''));
    await page.waitForFunction(() => f.editor().value === '');
    await page.focus('.sidebar-header button');
    await page.evaluate(() => { window.originalFocus = document.activeElement; });
    await send();
    assert.equal(await page.evaluate(() => document.activeElement === originalFocus), true);
    await page.focus('.input-search-input');
    await send();
    assert.equal(await page.$eval('.input-search-input', e => e === document.activeElement && e.value === ''), true);
    assert.deepEqual(await page.evaluate(() => f.errors), []);
  });
  const openOwner = async (options = {}) => {
    await page.evaluate(options => f.openOwner(options), options);
    await page.waitForSelector('#generic-owner .cockpit-speech-mic');
  };
  const genericSend = async () => {
    const before = await page.evaluate(() => ({ native: f.sends.length, generic: f.genericSends.length }));
    await page.keyboard.down('F8'); await ready(); await page.keyboard.up('F8');
    await page.waitForFunction(n => f.genericSends.length === n, {}, before.generic + 1);
    await idle();
    assert.equal(await page.evaluate(() => f.sends.length), before.native);
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
  };
  await t.test('v3 negotiation and one real registered service augment Chat and a public generic composer', async () => {
    await setup();
    await openOwner();
    assert.deepEqual(await page.evaluate(() => f.contexts), [[3, 1, 1, 2]]);
    assert.equal(await page.evaluate(() => f.services.length), 1);
    assert.equal(await page.$$eval('.cockpit-speech-input', nodes => nodes.length), 2);
    assert.equal(await page.evaluate(() => 'sessionId' in f.owner().reference), false);
    assert.equal(await page.$eval('#generic-owner', node => node.matches(':modal')), true);
    await page.evaluate(() => f.runtime.updateView({ sessionId: null, visible: false, connected: false }));
    await genericSend();
    assert.equal(await page.evaluate(() => f.genericSends[0].route), 'synthetic-thread-1');
    assert.equal(await page.evaluate(() => f.genericSends[0].text), 'Synthetic F8 transcript');
    assert.equal(await page.evaluate(() => f.draft().getSnapshot().text), '');
    assert.match(await page.evaluate(() => JSON.stringify(f.socketUpdates)), /Only generic owner visible reference/);
    await page.evaluate(() => { f.closeOwner(); f.updateView(); });
    await page.waitForFunction(() => !document.querySelector('#generic-owner'));
    await send();
  });
  await t.test('two available nonmodal editors are ambiguous even when one has focus', async () => {
    await setup(); await openOwner({ modal: false });
    await page.focus('#generic-owner textarea');
    const before = await page.evaluate(() => f.genericSends.length);
    await blocked();
    assert.equal(await page.evaluate(() => f.genericSends.length), before);
  });
  await t.test('native modal availability alone disables and restores microphone and hold affordances', async () => {
    await setup();
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'availability-modal'; dialog.innerHTML = '<input value="modal">';
      document.body.append(dialog); dialog.showModal();
    });
    await page.waitForFunction(() => document.querySelector('.cockpit-speech-mic').disabled
      && !document.querySelector('.cockpit-speech-hold'));
    await blocked();
    // No runtime view update, draft edit or React state change accompanies this native close.
    await page.evaluate(() => { document.querySelector('#availability-modal').close(); });
    await page.waitForFunction(() => !document.querySelector('.cockpit-speech-mic').disabled
      && !!document.querySelector('.cockpit-speech-hold'));
    await send();
  });
  await t.test('native modal interrupts button capture without observer reentrancy or sending', async () => {
    await setup();
    await page.click('.cockpit-speech-mic');
    await ready();
    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'capture-modal'; dialog.innerHTML = '<input value="modal">';
      document.body.append(dialog); dialog.showModal();
    });
    await page.waitForFunction(() => !f.recording());
    await page.waitForFunction(() => f.draft().getSnapshot().text === 'Synthetic F8 transcript');
    await idle();
    assert.equal(await page.evaluate(() => f.sends.length + f.genericSends.length), 0);
    assert.deepEqual(await counts(), { captures: 1, stops: 1, sends: 0 });
    await page.evaluate(() => { document.querySelector('#capture-modal').close(); });
    await page.waitForFunction(() => !document.querySelector('.cockpit-speech-mic').disabled);
    assert.deepEqual(await page.evaluate(() => f.errors), []);
  });
  for (const afterRelease of [false, true]) {
    await t.test(`closing/reopening modal ${afterRelease ? 'after' : 'before'} release keeps original draft and adapter`, async () => {
      await setup(); await openOwner();
      await page.evaluate(() => { window.originalOwner = f.owner(); f.holdResult(true); });
      await page.keyboard.down('F8'); await ready();
      if (afterRelease) await page.keyboard.up('F8');
      await page.evaluate(() => f.closeOwner());
      await page.waitForFunction(() => !document.querySelector('#generic-owner'));
      if (!afterRelease) await page.keyboard.up('F8');
      await page.waitForFunction(() => f.resultPending());
      await openOwner();
      assert.equal(await page.evaluate(() => f.owner() === originalOwner), true);
      await page.evaluate(() => { f.finish(); f.holdResult(false); });
      await page.waitForFunction(() => ['idle', 'send-error'].includes(f.genericState().phase));
      assert.equal(await page.evaluate(() => f.genericSends.length), afterRelease ? 1 : 0);
      assert.equal(await page.evaluate(() => f.sends.length), 0);
      assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), afterRelease ? '' : 'Synthetic F8 transcript');
      assert.equal(await page.evaluate(() => f.draft().getSnapshot().text), '');
    });
  }
  await t.test('reply change while F8 is held ends capture and preserves recovery without sending', async () => {
    await setup(); await openOwner();
    await page.evaluate(() => f.holdResult(true));
    await page.keyboard.down('F8'); await ready();
    await page.evaluate(() => f.updateReply('changed-while-held'));
    await page.waitForFunction(() => !f.recording());
    await page.keyboard.up('F8');
    await page.waitForFunction(() => f.resultPending());
    await page.evaluate(() => { f.finish(); f.holdResult(false); });
    await page.waitForFunction(() => !!f.genericState().recovery);
    assert.equal(await page.evaluate(() => f.genericState().recovery.text), 'Synthetic F8 transcript');
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
    assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
    assert.deepEqual(await counts(), { captures: 1, stops: 1, sends: 0 });
  });
  for (const mutation of ['action', 'reply', 'schema']) {
    await t.test(`captured generic send rejects stale ${mutation} without clearing content`, async () => {
      await setup(); await openOwner();
      await page.evaluate(() => f.holdResult(true));
      await page.keyboard.down('F8'); await ready(); await page.keyboard.up('F8');
      await page.waitForFunction(() => f.resultPending());
      await page.evaluate(mutation => {
        if (mutation === 'action') f.updateOwner({ actionRevision: 1 });
        if (mutation === 'reply') {
          f.updateReply('another-message');
          f.updateReply(null);
        }
        if (mutation === 'schema') { f.changeSchema('added'); f.changeSchema(''); }
        f.finish(); f.holdResult(false);
      }, mutation);
      await page.waitForFunction(() => f.genericState().phase === 'send-error' || !!f.genericState().recovery);
      assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
      assert.equal(await page.evaluate(() => f.genericState().recovery?.text ?? f.owner().reference.getSnapshot().text), 'Synthetic F8 transcript');
      assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().unconfirmed), false);
    });
  }
  await t.test('retired modal occurrence cannot deliver late transcription to its replacement', async () => {
    await setup(); await openOwner();
    await page.evaluate(() => { window.originalOwner = f.owner(); f.holdResult(true); });
    await page.keyboard.down('F8'); await ready(); await page.keyboard.up('F8');
    await page.waitForFunction(() => f.resultPending());
    await page.evaluate(() => { f.retireOwner(); f.closeOwner(); });
    await page.waitForFunction(() => !document.querySelector('#generic-owner'));
    await openOwner();
    await page.evaluate(() => { f.finish(); f.holdResult(false); });
    await page.waitForFunction(() => {
      const state = f.services[0].getSnapshot(originalOwner.reference.id);
      return state.phase === 'idle' || state.phase === 'send-error';
    });
    assert.equal(await page.evaluate(() => f.owner() === originalOwner), false);
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
    assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
  });
  for (const outcome of ['rejected', 'unknown', 'settlement-failed']) {
    await t.test(`generic ${outcome} remains distinct and never automatically replays`, async () => {
      await setup(); await openOwner();
      await page.evaluate(outcome => {
        if (outcome === 'settlement-failed') f.failSettlement(true);
        else f.outcome(outcome);
      }, outcome);
      await page.keyboard.down('F8'); await ready(); await page.keyboard.up('F8');
      await page.waitForFunction(() => f.genericState().phase === 'send-error');
      assert.equal(await page.evaluate(() => f.genericSends.length), 1);
      assert.equal(await page.evaluate(() => f.sends.length), 0);
      assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().unconfirmed), outcome !== 'rejected');
      if (outcome !== 'rejected') assert.equal(await page.evaluate(() =>
        typeof f.owner().reference.getSnapshot().submissionId), 'string');
      assert.equal(await page.evaluate(() => f.genericState().sendOutcome), outcome === 'rejected' ? 'rejected' : 'unconfirmed');
      await blocked();
      await page.evaluate(() => f.closeOwner());
      await page.waitForFunction(() => !document.querySelector('#generic-owner'));
      await openOwner();
      assert.equal(await page.evaluate(() => f.genericSends.length), 1);
      if (outcome === 'settlement-failed') assert.match(await page.evaluate(() => f.errors.join('\n')), /Synthetic local settlement failure/);
      else assert.deepEqual(await page.evaluate(() => f.errors), []);
    });
  }
  await t.test('missing sends permission preserves transcript without invoking either owner adapter', async () => {
    await setup('reading', { denySends: true }); await openOwner();
    await page.keyboard.down('F8'); await ready(); await page.keyboard.up('F8');
    await page.waitForFunction(() => f.genericState().phase === 'send-error');
    assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), 'Synthetic F8 transcript');
  });
  await t.test('microphone denial releases resources and keeps both drafts intact', async () => {
    await setup(); await openOwner();
    await page.evaluate(() => f.rejectMicrophone(true));
    await page.keyboard.press('F8');
    await page.waitForFunction(() => f.genericState().phase === 'retry');
    assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
    assert.equal(await page.evaluate(() => f.draft().getSnapshot().text), '');
    assert.deepEqual(await counts(), { captures: 1, stops: 0, sends: 0 });
  });
  await t.test('generic ask captures only its own question and preserves IME/focus', async () => {
    await setup(); await openOwner({ purpose: { kind: 'ask', requestId: 'synthetic-question' } });
    await page.focus('#generic-owner textarea');
    await page.evaluate(() => { window.originalFocus = document.activeElement;
      originalFocus.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await blocked();
    await page.evaluate(() => originalFocus.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await genericSend();
    assert.equal(await page.evaluate(() => document.activeElement === originalFocus), true);
    assert.match(await page.evaluate(() => JSON.stringify(f.socketUpdates)), /Which generic reply/);
  });
  await t.test('generic owner receives real schema projections and ACK clears only captured fields', async () => {
    await setup(); await openOwner();
    await page.evaluate(() => { f.changeSchema('captured-file'); f.updateReply('original-message'); });
    await genericSend();
    assert.equal(await page.evaluate(() => f.genericSends[0].replyTo), 'original-message');
    assert.deepEqual(await page.evaluate(() => f.genericSends[0].fields), {
      attachments: [{ type: 'file', path: '/synthetic/captured-file' }],
    });
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().hasContent), false);
  });
  await t.test('mobile tap focuses; real touch hold sends through the generic owner', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await setup(); await openOwner();
    // showModal initially focuses the editor; gesture mode starts only after explicit blur.
    await page.evaluate(() => document.activeElement.blur());
    const selector = '#generic-owner .cockpit-speech-hold';
    await page.waitForSelector(selector);
    const box = await page.$eval(selector, node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.touchscreen.tap(box.x, box.y);
    assert.equal(await page.evaluate(() => document.activeElement === f.genericEditor()), true);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForSelector(selector);
    await page.touchscreen.touchStart(box.x, box.y);
    await ready();
    await page.touchscreen.touchEnd();
    await page.waitForFunction(() => f.genericSends.length === 1);
    await idle();
    assert.equal(await page.evaluate(() => f.sends.length), 0);
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForSelector(selector);
    await page.touchscreen.touchStart(box.x, box.y);
    await ready();
    await page.touchscreen.touchMove(box.x, box.y - 90);
    await page.touchscreen.touchEnd();
    await idle();
    assert.equal(await page.evaluate(() => f.genericSends.length), 1);
    assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
  });
  for (const resultBeforeRelease of [false, true]) {
    await t.test(`mobile reply change before transcription retains recovery with result ${resultBeforeRelease ? 'before' : 'after'} release`, async () => {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await setup(); await openOwner();
      await page.evaluate(() => { document.activeElement.blur(); f.holdResult(true); });
      const selector = '#generic-owner .cockpit-speech-hold';
      await page.waitForSelector(selector);
      const box = await page.$eval(selector, node => {
        const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.touchscreen.touchStart(box.x, box.y);
      await ready();
      assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
      await page.evaluate(() => f.updateReply('new-mobile-reply'));
      await page.waitForFunction(() => !f.recording() && f.resultPending());
      if (resultBeforeRelease) {
        await page.evaluate(() => { f.finish(); f.holdResult(false); });
        await page.waitForFunction(() => !!f.genericState().recovery);
      }
      await page.touchscreen.touchEnd();
      if (!resultBeforeRelease) {
        await page.evaluate(() => { f.finish(); f.holdResult(false); });
      }
      await page.waitForFunction(() => !!f.genericState().recovery);
      assert.equal(await page.evaluate(() => f.genericState().recovery.text), 'Synthetic F8 transcript');
      assert.equal(await page.evaluate(() => f.owner().reference.getSnapshot().text), '');
      assert.equal(await page.evaluate(() => f.genericSends.length + f.sends.length), 0);
      assert.deepEqual(await counts(), { captures: 1, stops: 1, sends: 0 });
      assert.deepEqual(await page.evaluate(() => f.errors), []);
    });
  }
  assert.deepEqual(failures, []);
});
