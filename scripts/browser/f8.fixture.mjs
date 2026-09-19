// Run only in the pinned host's isolated Chat Lab. No native session or cloud I/O.
export async function installSpeechFixture(entry) {
  if (location.hostname !== '127.0.0.1' || location.pathname !== '/chat-lab.html') {
    throw new Error('This fixture requires the loopback-only isolated Chat Lab');
  }
  const { moduleRuntime: runtime } = await import('/src/lib/moduleRuntime.ts');
  const { getSessionDraft } = await import('/src/lib/textDraft.ts');
  const { activate } = await import(/* @vite-ignore */ entry);
  const errors = [], sends = [];
  let captures = 0, stops = 0, pendingPermission = false, pendingResult = false;
  const permissions = [], results = [];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    captures++;
    const track = { readyState: 'live', stop() { stops++; this.readyState = 'ended'; } };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    if (pendingPermission) await new Promise(resolve => permissions.push(resolve));
    return stream;
  } });
  window.AudioContext = class {
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() {
      return { connect(worklet) {
        queueMicrotask(() => {
          for (let i = 0; i < 6; i++) worklet.port.onmessage?.({ data: { type: 'pcm', buffer: new ArrayBuffer(960) } });
        });
      }, disconnect() {} };
    }
  };
  window.AudioWorkletNode = class {
    port = {
      onmessage: null,
      postMessage: () => queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ended', limited: false } })),
      close() {},
    };
    connect() {}
    disconnect() {}
  };
  window.WebSocket = class {
    bufferedAmount = 0;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    emit(value) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
    send(data) {
      const value = JSON.parse(data);
      if (value.type === 'session.update') this.emit({ type: 'session.updated', session: value.session });
      else if (value.type === 'input_audio_buffer.commit') {
        this.emit({ type: 'input_audio_buffer.committed', item_id: 'fixture-item', previous_item_id: null });
        const finish = () => this.emit({ type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'fixture-item', content_index: 0, transcript: 'Synthetic F8 transcript' });
        if (pendingResult) results.push(finish); else finish();
      } else if (value.type === 'input_audio_buffer.clear') this.emit({ type: 'input_audio_buffer.cleared' });
      else if (value.type !== 'input_audio_buffer.append') throw new Error(`Unexpected fixture socket message: ${value.type}`);
    }
    close() {}
  };
  const digest = '8'.repeat(64);
  runtime.stop();
  // Test-only injection into the real host runtime; production Speech uses only its public SDK.
  Object.assign(runtime.options, {
    load: async () => ({ activate }),
    report: error => errors.push(String(error)),
    draftSubmission: { check: () => undefined, send: async request => { sends.push(request); return true; } },
    fetch: async url => {
      const path = new URL(url).pathname;
      if (path === '/_modules') return Response.json({ errors: [], modules: [{
        id: 'cockpit-speech', name: 'Speech fixture', version: '0.8.2', digest, config: {}, styles: [],
        apiBase: `/_modules/cockpit-speech/${digest}/api`,
        entry: `/_modules/assets/cockpit-speech/${digest}/index.js`,
      }] });
      if (path === `/_modules/cockpit-speech/${digest}/api/session`) return Response.json({
        clientSecret: 'synthetic-only', expiresAt: Math.floor(Date.now() / 1000) + 600,
        socketUrl: 'wss://fixture.openai.azure.com/openai/v1/realtime?intent=transcription', deployment: 'gpt-transcribe',
      });
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  });
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = new URL('styles.css', new URL(entry, location.href)).href;
  document.head.append(style);
  const scene = new URLSearchParams(location.search).get('scene') ?? 'reading';
  let sessionId = scene === 'workspace'
    ? (await import('/src/dev/workspace-fixtures.ts')).workspaceSessionId : `chat-lab-${scene}`;
  const updateView = (patch = {}) => runtime.updateView({ sessionId, visible: true, connected: true, ...patch });
  updateView();
  await runtime.start();
  const wait = async (predicate, label) => {
    const until = performance.now() + 3000;
    while (!predicate()) {
      if (errors.length) throw new Error(errors.join('\n'));
      if (performance.now() >= until) throw new Error(`Timed out: ${label}; ${document.querySelector('.cockpit-speech-status')?.textContent}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await wait(() => document.querySelector('.cockpit-speech-mic'), 'real Speech middleware mounted');
  const editor = () => document.querySelector('.cockpit-speech-input textarea');
  const key = (type, patch = {}) => {
    const event = new KeyboardEvent(type, { key: 'F8', code: 'F8', keyCode: 119,
      bubbles: true, composed: true, cancelable: true, ...patch });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  };
  return {
    runtime, editor, key, wait, errors, sends, updateView,
    counts: () => ({ captures, stops }),
    draft: () => getSessionDraft(sessionId),
    holdPermission: value => { pendingPermission = value; },
    grant: () => permissions.splice(0).forEach(resolve => resolve()),
    holdResult: value => { pendingResult = value; },
    finish: () => results.splice(0).forEach(resolve => resolve()),
    resultPending: () => results.length > 0,
    recording: () => !!document.querySelector('.cockpit-speech-mic[aria-pressed="true"]'),
    async scene(value) {
      const select = document.querySelector('.lab-toolbar select');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sessionId = `chat-lab-${value}`;
      updateView();
      await wait(() => location.search.includes(`scene=${value}`), 'scene switch');
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  };
}
