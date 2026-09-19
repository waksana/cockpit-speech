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

test('compiled Speech on pinned Chat Lab: real page-wide keyboard events and original-draft ACK', async t => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN, headless: true,
    args: process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  t.after(() => browser.close());
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
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
  const setup = async (scene = 'reading') => {
    await page.goto(`http://127.0.0.1:5187/chat-lab.html?scene=${scene}`);
    await page.evaluate(async (fixture, entry) => {
      const { installSpeechFixture } = await import(fixture);
      window.f = await installSpeechFixture(entry);
    }, fixture, entry);
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
  assert.deepEqual(failures, []);
});
