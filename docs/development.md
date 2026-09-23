# Development and verification

## Frontend boundary

`frontend.ts` owns activation, the `SpeechService` registration, F8 listener
lifetime, editor refs, target binding, pointer gestures and focus effects.
`index.ts` checks the host capabilities before calling it and renders over the
capture/PCM/transport/transcript/draft/send logic.

Activation installs one `beforeunload` listener. Its synchronous
`SpeechService.hasUnpersistedWork()` query inspects all operation owners, not only
the visible target or current draft blockers. Active permission/capture/flush/
transcription/send, retained audio, recovery and uncertain send outcomes warn.
Startup errors with no retained resources and ordinary persisted drafts do not.
The listener only prevents unload and sets the browser confirmation flag; it
never mutates an operation. Abort/disposal removes it. Actual page departure
retains existing teardown semantics: no audio transfer, persistence, automatic
replay or guaranteed delivery is introduced.

The Node gesture suite exercises the entry with permission, pointer,
keyboard and focus fixtures; service cases cover hidden-draft unload protection
after blocker release.

## Backend boundary

The sole route is `POST /session`, accepting only `{}` and returning
`{clientSecret, expiresAt, socketUrl, deployment}` or a safe `{error:{code,message}}`.
Responses are `no-store`. Context, audio, model overrides and browser credentials
are rejected. One credential exchange runs at a time; that is not an Azure
session quota. `config.ts` rereads bounded regular non-symlink
`azure-openai.json` files with descriptor/identity checks.

`azure.ts` requests `/openai/v1/realtime/client_secrets` with the server-held key,
transcription-only configuration, PCM 24 kHz, empty prompt, `server_vad`
with `silence_duration_ms: 1000` (the same shared value as the browser update)
and a 600-second credential lifetime. Provider requests reject redirects,
have a 30-second deadline, bound response bodies and discard private errors.
The returned WebSocket origin/path is locally constructed and strictly validated.

## Capture and network are independent

- `context.ts` preserves the ordinary prompt/plan chat-window policy. For an
  ask draft, `speech.ts` reads only `snapshot.askContext` from its exact host-bound
  draft at capture start, before any asynchronous setup. The optional typed host
  field contains only that occurrence's question and choices, not arbitrary
  session data. Missing/blank question means no reference plus a visible
  audio-only notice, never a chat-window fallback. The question prefix and head
  are allocated first from 1,000 Unicode code points, then nonblank choices in
  native order with complete labels and at least one point of text. The last
  fitting choice may be truncated; no local model, history fetch or DOM/tool
  text parsing is involved. Recorder replay reuses the same captured string;
  retirement and request-ID reuse retain the existing draft lifetime guards.
- `transport.ts` caches credentials in activation-scoped memory for at most
  one minute and stops reusing them 30 seconds before Azure expiry. Retry requests
  fresh credentials, also picking up changed file configuration. Aborted requests
  cannot populate the cache. Disposal clears it.
- `capture.ts` initiates microphone permission and context resume together,
  without waiting for credentials. It watches device/context failure from setup,
  checks final readiness, and consumes the packaged worklet's ordered messages.
  If the context is still suspended after microphone permission resolves, it
  calls resume once more while the document is capturing. WebKit can leave the
  initial pre-permission resume pending when a hold lacks transient activation;
  the new call re-evaluates that condition. It does not acquire a second stream,
  loop, revive a cancelled capture, or mark the editor ready before the graph is
  actually running. The existing bounded startup timeout still applies.
- A short input-layer release records tap intent; its synchronous click handler
  focuses the real textarea. Focusing during pointerup removes the gesture layer
  before touchend/click and can disrupt mobile gesture completion. Cancelled,
  held, superseded and newly blocked taps cannot focus from a trailing click.
- `capture-worklet.ts` and `pcm.ts` produce 24 kHz mono little-endian PCM16 chunks.
  Native Web Audio resamples the requested 24 kHz context; the streaming encoder
  also handles other context sample rates. Render-sample counting bounds the
  recording to 120 seconds. Stop releases tracks immediately, flushes the tail,
  then seals the append-only record. A missing flush acknowledgement fails rather
  than claiming complete audio.
- `socket.ts` sends prompt and server-VAD configuration and verifies
  `session.updated`, including a numeric `silence_duration_ms` exactly equal to
  1000, before sending audio. Missing/mismatched silence settings explicitly fail
  with `VAD_CONFIG_FAILED`; provider rejection and absent acknowledgement retain
  their existing error/timeout paths. Later configuration mismatches also fail.
  No context means `prompt: ""`, never
  omission. The same ordered cursor drains backlog and newly added chunks;
  no local silence filtering or cropping occurs. Stop sends final commit then
  input-buffer clear on the same ordered socket. `input_audio_buffer.cleared`
  acknowledges the input drain, not transcription completion. A correlated
  final-commit empty error means no new item; all existing items must still finish.
  Missing acknowledgements/results time out; rate limits and other errors remain
  failures. No sleep-based "probably finished" heuristic is used.
  The server's one-second silence setting is not a client stop/send delay:
  F8/pointer release still flushes the tail and commits/clears immediately.
- `transcript.ts` owns one bounded item table per connection. Commit links define
  ordering, delta appends to that item's text, and completed replaces its text.
  Every available item's text participates in the composed snapshot even when
  earlier items have no text yet. Unknown/uncommitted results cannot be written;
  contradictory links and final results fail. Empty finals are valid.
- `recorder.ts` owns one capture and one active transport attempt. Network failure
  while recording does not interrupt local capture. Manual retry creates another
  connection/cursor over the same bytes, without reopening the microphone.
  A failed tail flush aborts the current receiver before the service releases
  its lease, while keeping bounded PCM available for explicit replay.
  Connections close independently of draft insertion. No automatic reconnect,
  retry, backend audio upload or disk persistence exists.
- `speech.ts` owns a map of exact draft lifetimes, each with its original
  revision/selection/context, state, audio and lease. There is one capture owner,
  but no count limit/eviction or network concurrency queue. Failure releases the
  lease and retains audio; retry reacquires only that draft's lease. Replacement,
  navigation and hiding stop capture and complete the original task in the
  background. Permission-stage departure aborts rather than starting later.
  Explicit cancel/clear, module disposal and host-observed permanent retirement
  destroy the owned task. The user-approved `AUDIO_TOO_SHORT` exception also
  discards an unusable under-100-ms take; other device/network failures retain it.
  Superseded callbacks cannot affect another attempt.
- Host `draftLifecycleVersion: 1` exposes observable `snapshot.retired` and
  `editTextIfRevision(text, revision)`. Completion releases its own lease, then
  asks the host for a synchronous guarded write. Revision, pending/unconfirmed,
  competing leases, retirement, revocation and persistence failure remain host
  boundaries. On conflict, audio and text remain until manual insertion/discard;
  no hidden textarea lookup is used. The visible target only
  governs starting/retrying, focus and UI projection, never background ownership.
- Each live composed snapshot replaces the original selected region,
  advancing only the expected revision from its own write. External revisions,
  peer blocks and pending/unconfirmed drafts stop automatic updates; the latest
  composed result stays recoverable. Empty results never delete a selection;
  an empty final restores an owned provisional replacement. Superseded attempt
  callbacks cannot affect the new attempt. Clear/cancel preserve text already
  written. Only normal active hold release authorizes automatic submission.
  Recovery insertion releases retained audio only after a successful guarded
  write; displayed recovery controls do not depend on a later successful retry.
- `draftSubmissionVersion: 1` plus explicit `sends: ['draft']` permits
  `draft.captureSend()` on active hold release. Its one-shot `send(revision)`
  uses original purpose/session, host native field projection, schema mutation
  checkpoint and ACK handling. Speech calls it only after all VAD results finish
  and the final guarded text checkpoint succeeds. Navigation after release
  preserves intent; pre-release interruption and button stop never capture one.
  Transcription retry keeps intent, but native blocked/unknown outcomes enter
  `send-error`, not transcription retry. Audio remains until confirmed delivery
  or explicit discard/retirement/teardown. Empty transcription never sends.

Reused credentials may produce equal Azure session IDs despite isolated
connections. Local object ownership and committed-item matching, not provider
session IDs, prevent stale writes. Never log WebSocket URLs: the short-lived bearer
appears in their query. Expiry blocks new connections, not necessarily open ones.

## UI

The `composerInput` wrapper renders the real Base and a fixed-size microphone
sibling, preserving controlled props, native events and React 19 ref cleanup.
The native send remains host-owned. Prompt/ask/plan and free-text gates are
unchanged; File remains prompt-only on the left.

One circular button provides idle microphone, disabled startup spinner, solid
red stop square, disabled sending/transcription spinner and red manual retry.
An existing `composerEditor` wrapper places the status row before the complete
Base, outside the actual input/control row. Only the host's public `ck-*` input
and status classes own typography, row geometry and alignment; speech CSS does
not query, move, or style queue/question ancestors. The host alone owns that
layout. The status row's dense trailing clear action follows the public class.
Preparation/processing use spinners; actual capture uses the reactive dot and
elapsed seconds derived from PCM byte count, with no timer or wall-clock drift.
The held limit freezes at 120 seconds and uses a static pause indicator.
Error/recovery states use a static error indicator, never a misleading spinner.
Clear always resets speech state, even when startup failed before an operation
was retained. It cancels active/replayed work and clears recovery without editing
the draft or allowing late completions. Retry remains in the microphone control.
Only draft-conflict text recovery uses the existing `composer` wrapper after the
whole row; it cannot redirect insertion to another draft.

`hold.ts` owns a single captured pointer and a 300 ms timer. The actual textarea
stays mounted inside a module-owned flex region. Only an empty, unfocused,
writable input gets the non-editing overlay; focus/blur chain the native handlers.
The layer stays mounted for pointer capture while held, but its hint disappears
during recording so it does not cover live text. Owned speech writes do not
interrupt the hold; external edits still do. Incremental writes never steal focus
or reset selection; focus restoration happens only at successful completion.
The layer is transparent; its hint is leading-aligned and vertically centered. Only while it is
present does Base receive an empty placeholder, avoiding overlapping hints;
native placeholder text returns when the layer disappears.
Tab goes straight to the textarea. The overlay suppresses native touch selection,
not the textarea's editing behavior. Bounds come from the public editor ref,
not private DOM queries. Captured/coalesced coordinates are checked on move and
release for a 64 CSS pixel upward swipe from the press origin. Once cancelled,
ownership and timer clear before capture release, then existing speech
cancellation destroys the recording. Other directions can leave the original
input without cancelling. Release while starting cancels; only release during
recording captures send intent and stops/transcribes. Unmount, temporary draft/host unavailability,
visibility loss, pointer capture loss, window blur, resize and Tab interrupt:
they detach gesture ownership and stop/transcribe without discarding audio.
Escape and upward swipe still explicitly cancel. Late release/capture-loss events
cannot cancel an interrupted background task. Unrelated scrolling does not
interrupt. Button capture receives the same page/host interruption handling.

Both hold and microphone-button recordings use the same status feedback.
The status marker's 7px dot scales from 1 to 2; the stop icon never scales.
RMS and elapsed time come from the existing PCM16 chunks (no second microphone,
analyser or interval). Progress is guarded by exact operation identity.
Pending presses belong only to `HoldGesture`, not the speech service snapshot.
Before the hold threshold, no recording status row or live announcement is
mounted and no audio starts. Preparation feedback follows the actual `permission`
phase. Short-tap focus still uses the completed click.

Ordinary asynchronous transcription completion updates the owned caret selection
without focusing the textarea or opening the mobile keyboard. Dismissing recovery
also does not focus the editor. The two DOM focus paths are limited to a completed
short tap on the hold layer and explicit recovery insertion into the original
editor. The latter returns to the inserted text; neither path runs at recording
start. F8 retains its existing no-completion-selection/focus policy.

`keyboard.ts` provides one activation-scoped capture-phase listener set and
physical F8 latch across composer registration/replacement. Capture phase keeps
ordinary controls' bubbling handlers from hiding keydown/keyup. It checks the
public editor ref, document focus, target visibility/writability and native modal
inertness, plus live host/draft gates; it never queries host-private selectors.
Focus on body, a sidebar, button, link, another editor or other control is not a
veto. Neither is a nonmodal dialog/popover or an ARIA role alone: the chat target
must actually become unavailable. An empty textarea need not be focused.
Ambiguous visible composers fail closed. Keyboard starts use the existing hold
mode with completion autofocus disabled, so an interrupted background result
cannot steal focus from another UI. Only ready, unmodified keyup calls the same
`releaseHold`; it clears key ownership first. Pre-release interruption, Escape,
composition, pointer activity and lost-keyup recovery cannot capture consent.
One MutationObserver handles UI visibility, native modal takeover and DOM
disabled/readonly changes (including disabled fieldsets) without a timer or
poll loop. Listeners persist through a composer gap to consume late release,
and the module abort signal removes them. Pointer and button behavior remains
separate while sharing the service's single capture owner.

Hold starts pass `waitForStop` to the recording preparation. At the render or wall
limit capture stops, but the transport queue's sealed view stays false until the
release or navigation interruption calls stop. Thus a capped buffer does not initiate the final
client commit/drain while held; server VAD may already have committed and
transcribed speech turns. Upward cancellation clears audio and future callbacks
even after capture has stopped, without undoing already-written draft text. The
microphone button's limit policy is unchanged.

## Existing validation tools

For #25, the [Azure Realtime reference](https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference)
delegates the protocol to OpenAI. Its
[transcription client-secret schema](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets)
defines `session.audio.input.turn_detection.silence_duration_ms` as a numeric
duration in milliseconds for `server_vad`; the
[Azure guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio)
also shows this field and `session.updated` confirmation. The referenced schemas
do not publish a numeric minimum/maximum for this field: no deployment-specific
accepted range or acceptance of 1000ms has been established by a cloud probe here.
OpenAI's documented 500ms default is not a readback of this Azure deployment's
previous effective value. Runtime confirmation is mandatory; do not infer
Azure acceptance from synthetic echo responses, or borrow Voice Live bounds.
Only silence duration is overridden; threshold/prefix and quotas are unchanged.
No actual cloud audio/paid experiment was run, and #24's VAD/429 causality remains
unproven and separate.

`pnpm test` uses Node's built-in runner and TypeScript stripping. Tests use
synthetic permission, Web Audio, worklet messages, sockets and backend responses,
never production configuration or user recordings. They cover:

- Context-free credential requests, key isolation, config validation, expiry,
  cache lifetime, refresh, cancellation and strict WebSocket endpoint validation.
- Capture before network readiness, prompt acknowledgement/clearing, stopped
  backlog, tail flushing, live append order and replay of identical retained data.
- PCM resampling, short tails, render-sample limit, lifecycle cancellation,
  initial resume, silent readiness failures, devices and bounded waits.
- Safe provider errors including rate limits, invalid/mismatched results,
  stale callbacks, fresh retry cursors, cleanup and actual service lease release.
- Out-of-order item text, canonical finals, valid empty results, correlated empty
  final commits, drain acknowledgement before/after results, and all-item completion.
- Live revision ownership, silent selection preservation, empty-final restoration,
  late callbacks, whole-audio retry without text duplication and held live updates.
- Input/status composition, truthful progress, native props/ref/IME preservation,
  exact draft/revision conflicts, retained recovery, draft-only button/interruption
  and exactly-once original-draft submission after active hold release.
- Tap/hold timing, upward swipe despite capture, irreversible cancellation,
  startup release, late permission grants, capture loss and interruption cleanup.
- F8 startup/readiness/release, modifiers/repeat/IME, empty input without focus,
  other-control focus, target unavailability/native modal inertness, missing/late keyup, composer rebinding,
  teardown and button/pointer contention; original prompt/ask/plan ACK and guards.
- Source/SDK identity, package closure and reproducibility.

Run `pnpm typecheck`, `pnpm test`, then `pnpm build`. Packaging requires a fresh
build from clean committed source; use a new output directory and the existing
package verifier. The precise host pin is in `tooling/host-sdk.json`: reachable foundation
`0fa433d99c053df2caf80770f0f8762b9ed7002e`, API/protocol 0.3.0. This package requires
Cockpit 0.3.0. Existing persisted draft encodings are preserved. The foundation does not establish
completion or deployment of the final host application.

The paired host regression imports the actual compiled middleware:

```sh
COCKPIT_TEST_SPEECH_ENTRY=/absolute/cockpit-speech/dist/web/index.js \
  pnpm --filter @cockpit/web exec tsx --tsconfig tsconfig.app.json --test \
  src/components/Thread.lifecycle.test.ts
```

Use the host's existing Chat Lab for browser interaction, with synthetic
microphone/credential/socket fixtures. Do not build a parallel demo app or
connect the Lab to native sessions. Lab CSP intentionally excludes Azure.

### Page-wide F8 browser regression (#27)

`scripts/browser/f8.browser.mjs` runs Node's existing test runner with an already
installed Puppeteer driver/Chromium, the **compiled** `dist/web/index.js`, and the
exact pinned host's existing Chat Lab (no host edits). The fixture injects only
synthetic media, credentials, transcript results and native ACK responses into
the real host module runtime. Keyboard input uses browser automation's actual
keydown/keyup path, not direct handler calls. Browser requests are loopback-only
and the Lab CSP excludes cloud sockets.

After `pnpm build`, start the Lab and run the browser suite:

```sh
node scripts/browser/serve-chat-lab.mjs /absolute/pinned-host-source
PUPPETEER_MODULE=/absolute/installed/puppeteer-entry.js \
  CHROME_BIN=/absolute/chrome \
  node --test scripts/browser/f8.browser.mjs
```

The driver may also be the existing Chrome DevTools MCP `third_party/index.js`
bundle (its `puppeteer` export). No test dependency is added to the shipping
module. On isolated Linux runners without a usable Chromium sandbox,
`CHROME_NO_SANDBOX=1` is an explicit local-fixture-only opt-in; it does not change
the host or production browser configuration. The default retains the sandbox.

Coverage includes first open/body before any textarea click, clicked transcript,
sidebar/button/link/select/checkbox/other editor focus, unchanged focus/selection,
stopped event bubbling, textarea focus, nonempty drafts, native/nonmodal dialogs,
popover, unavailable targets, late permission, repeat/modifiers/IME/Escape,
actual window departure, session switches before/after release, and teardown.
The baseline 0.8.1 compiled module started on body/textarea but refused buttons
and selects; the focusable transcript also matched its excluded `[tabindex]`
selector. That old synthetic body-only success did not establish page-wide F8.
This is Chromium/Linux synthetic-media coverage, not Windows hardware acceptance.

Synthetic success is not evidence of physical microphones, all browsers,
provider availability, recognition quality or billing. Real cloud smoke needs
explicit authorization and synthetic audio. Protocol experiments established
browser ephemeral WebSocket authentication, token reuse/expiry, prompt clearing,
buffered sending and replay; long-silence recognition produced errors and must
not be called an accuracy pass. No cloud request is needed for ordinary CI.

For issues #8/#9, deployed capture/PCM/socket/recorder/speech/transport assets
matched the baseline build. Explicit Chrome input selection restored the user's
Windows dictation, but silence still caused unwanted text. Authorized synthetic
Azure probes confirmed nonempty transcripts from all-zero audio with VAD off,
no turns for tested silence/low noise with VAD on, two automatic turns for two
utterances, and final manual commit of an active tail. An empty final commit
arrived before an earlier pending transcript. One attenuated synthetic phrase
also succeeded; this is not a physical quiet-microphone test. Some probes hit
rate limits and were stopped, not retried. Real Windows Chrome/PWA acceptance,
broader noise/short-speech quality and final billing remain unverified.
