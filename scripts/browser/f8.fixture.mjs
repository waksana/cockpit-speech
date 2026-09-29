// Run only in the pinned host's isolated Chat Lab. No native session or cloud I/O.
export async function installSpeechFixture(entry, options = {}) {
  if (location.hostname !== '127.0.0.1' || location.pathname !== '/chat-lab.html') {
    throw new Error('This fixture requires the loopback-only isolated Chat Lab');
  }
  const { moduleRuntime: runtime } = await import('/src/lib/moduleRuntime.ts');
  const { getSessionDraft } = await import('/src/lib/textDraft.ts');
  const speechModule = await import(/* @vite-ignore */ entry);
  const errors = [], sends = [];
  const genericSends = [], contexts = [], services = [], socketUpdates = [];
  let ownerContext, schema, owner, ownerFacts, changeReply, ownerKey = 0, opened = false, modal = true;
  let notifyOwner = () => {}, outcome = 'accepted', settlementFailure = false, rejectPermission = false;
  let captures = 0, stops = 0, pendingPermission = false, pendingResult = false;
  const permissions = [], results = [];
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    captures++;
    if (rejectPermission) throw new DOMException('Synthetic microphone denied', 'NotAllowedError');
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
      if (value.type === 'session.update') {
        socketUpdates.push(value.session);
        this.emit({ type: 'session.updated', session: value.session });
      }
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
  const definition = {
    frontendApiVersion: speechModule.frontendApiVersion,
    activate(context) {
      contexts.push([context.apiVersion, context.publicComponentsVersion, context.draftOwnerVersion, context.draftSubmissionVersion]);
      const frontend = speechModule.activate({ ...context, state: { ...context.state,
        register(registration) {
          const handle = context.state.register(registration);
          services.push(handle.get());
          return handle;
        },
      } });
      return options.denySends ? { ...frontend, sends: [] } : frontend;
    },
  };
  const ownerDefinition = {
    frontendApiVersion: 3,
    activate(context) {
      ownerContext = context;
      const { react: React } = context, h = React.createElement;
      schema = context.state.registerDraft({
        id: 'synthetic-field', purposes: ['prompt', 'ask'],
        create: () => ({ value: '' }),
        validate: value => {
          if (!value || typeof value.value !== 'string' || Object.keys(value).length !== 1) throw new Error('Invalid field');
          return value;
        },
        hasContent: value => value.value !== '',
        project: value => value.value ? { attachments: [{ type: 'file', path: `/synthetic/${value.value}` }] } : undefined,
        acknowledge: (current, captured) => current.value === captured.value ? { value: '' } : current,
        persistence: {
          serialize: value => JSON.stringify(value),
          restore: input => input.stored.present ? JSON.parse(input.stored.value) : { value: '' },
        },
      });
      const PublicComposer = context.components.get('composer');
      function OwnerPanel() {
        const [, render] = React.useReducer(value => value + 1, 0);
        React.useLayoutEffect(() => { notifyOwner = render; return () => { notifyOwner = () => {}; }; }, []);
        const ref = React.useRef(null);
        React.useLayoutEffect(() => {
          if (opened && modal) ref.current.showModal();
          return () => ref.current?.close();
        }, [opened, modal, owner]);
        if (!opened) return null;
        const panel = h(modal ? 'dialog' : 'section', {
          id: 'generic-owner', ref, style: { width: 'min(620px, 90vw)', padding: '20px', background: 'var(--bg-primary, white)' },
        }, h('h2', null, 'Synthetic Assistant owner'),
        h(PublicComposer, {
          draft: owner.reference, operation: owner.reference.purpose.kind,
          disabled: false, busy: false, sendBlocked: false,
          onTextChange: owner.editText, onSubmit: () => owner.submit(),
        }));
        return context.createPortal(panel, document.body);
      }
      return { apiVersion: 3, components: [{
        id: 'synthetic-owner-panel', boundary: 'composer',
        wrap: Base => props => props.draft.sessionId
          ? h(React.Fragment, null, h(Base, props), h(OwnerPanel))
          : h(Base, props),
      }] };
    },
  };
  runtime.stop();
  // Test-only injection into the real host runtime; production Speech uses only its public SDK.
  Object.assign(runtime.options, {
    load: async url => new URL(url).pathname.includes('/synthetic-owner/') ? ownerDefinition : definition,
    report: error => errors.push(String(error)),
    draftSubmission: { check: () => undefined, send: async request => { sends.push(request); return true; } },
    fetch: async url => {
      const path = new URL(url).pathname;
      if (path === '/_modules') return Response.json({ errors: [], modules: ['cockpit-speech', 'synthetic-owner'].map(id => ({
        id, name: id, version: '0.0.0-fixture', digest, config: {}, styles: [],
        apiBase: `/_modules/${id}/${digest}/api`,
        entry: `/_modules/assets/${id}/${digest}/index.js`,
      })) });
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
  const updateView = (patch = {}) => {
    runtime.updateView({ sessionId, visible: true, connected: true, ...patch });
    const draft = getSessionDraft(sessionId), snapshot = draft.getSnapshot();
    draft.updateFacts({ editable: true, submittable: patch.connected !== false,
      capabilities: snapshot.capabilities, actionRevision: snapshot.actionRevision,
      referenceText: snapshot.referenceText, askContext: snapshot.askContext });
  };
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
    runtime, editor, key, wait, errors, sends, updateView, genericSends, contexts, services, socketUpdates,
    owner: () => owner,
    genericEditor: () => document.querySelector('#generic-owner textarea'),
    genericState: () => services[0].getSnapshot(owner.reference.id),
    openOwner({ modal: nativeModal = true, purpose = { kind: 'prompt' } } = {}) {
      if (!owner || owner.reference.getSnapshot().retired || JSON.stringify(owner.reference.purpose) !== JSON.stringify(purpose)) {
        ownerFacts = { editable: true, submittable: true, actionRevision: 0,
          capabilities: { attachments: true }, referenceText: 'Only generic owner visible reference',
          ...(purpose.kind === 'ask' ? { askContext: { question: 'Which generic reply?', choices: ['Alpha', 'Beta'] } } : {}),
        };
        const route = `synthetic-thread-${++ownerKey}`;
        let replyTo = null;
        changeReply = value => {
          replyTo = value;
          ownerFacts = { ...ownerFacts, actionRevision: ownerFacts.actionRevision + 1 };
          owner.update(ownerFacts);
        };
        owner = ownerContext.state.createDraft({
          key: route, purpose, facts: ownerFacts,
          prepare: snapshot => ({ route, id: snapshot.id, text: snapshot.text,
            actionRevision: snapshot.base.actionRevision, fields: snapshot.fields, replyTo }),
          validateRequest: value => {
            if (!value || value.route !== route || typeof value.id !== 'string' || typeof value.text !== 'string'
              || !Number.isSafeInteger(value.actionRevision) || typeof value.fields !== 'object'
              || (value.replyTo !== null && typeof value.replyTo !== 'string')
              || Object.keys(value).sort().join() !== 'actionRevision,fields,id,replyTo,route,text') throw new Error('Invalid owner request');
            return value;
          },
          validateReceipt: value => {
            if (!value || typeof value.id !== 'string' || Object.keys(value).join() !== 'id') throw new Error('Invalid owner receipt');
            return value;
          },
          send: async request => {
            genericSends.push(request);
            return outcome === 'accepted' ? { status: 'accepted', receipt: { id: request.id } }
              : { status: outcome, reason: `Synthetic ${outcome}` };
          },
          inspect: async () => ({ status: 'unknown', reason: 'No synthetic reconciliation evidence' }),
          settle: () => { if (settlementFailure) throw new Error('Synthetic local settlement failure'); },
        });
      }
      modal = nativeModal; opened = true; notifyOwner();
    },
    closeOwner() { opened = false; notifyOwner(); },
    retireOwner() { owner.retire(); },
    updateOwner(patch) { ownerFacts = { ...ownerFacts, ...patch }; owner.update(ownerFacts); },
    updateReply(value) { changeReply(value); },
    changeSchema(value) { schema.forDraft(owner.reference).update(() => ({ value })); },
    outcome(value) { outcome = value; },
    failSettlement(value) { settlementFailure = value; },
    rejectMicrophone(value) { rejectPermission = value; },
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
