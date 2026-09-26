# Cockpit Speech

The current source builds with the published
`@waksana/cockpit-module-sdk@0.2.0` from GitHub Packages. Its exact supported
historical tested host pairing is Cockpit commit `7d69b6f348e17f098bc5562fdbec317e8e2e4ba6`,
recorded separately in `tooling/host-compatibility.json`.
SDK semver is not a host compatibility check.
Current Rolling packages carry source-derived API and capability requirements;
see [Releases](docs/releases.md). Main stays `0.0.0-dev`, with development
builds displaying `dev+<shortSHA>`.
Recovery UI consumes public `ck-surface` and `ck-actions`; activation requires
both `context.uiVersion === 1` and `context.uiSurfaceVersion === 1` before
registering contributions. Missing/unsupported surface capability is rejected.
These are current-source capabilities, not a claim about historical
host assets. Gesture, recovery limits, native input and submission ownership
are unchanged; no private host components or separate React runtime are used.

Speech requests the browser's native leave confirmation while any draft,
including a hidden draft, owns active capture/processing, retained audio/results
or uncertain submission state. The handler does not stop, cancel, send or clear
anything. Cancelling navigation leaves work intact. A permission error without
retained work, a dismissed notice, or successfully persisted draft-only text does
not itself request a Speech warning. The browser controls whether it displays a
confirmation, including user-activation restrictions; this is not persistence or
a guarantee against mobile process termination. Confirming departure still loses
page-owned audio and recovery. Existing host-persisted draft encodings are preserved.

Standalone, GPL-3.0-only Cockpit dictation using **Azure OpenAI gpt-transcribe,
browser-direct WebSocket, local audio buffering and captured chat context**.
The backend only exchanges its resource key for short-lived credentials; it
never receives audio, context or transcripts. No Entra business authentication,
speech SDK, postprocessor or settings page is required.

## One-button dictation

The fixed circular microphone follows the actual editor and precedes native
send, for prompt, ask and plan inputs. File stays on the left and prompt-only.
Native free-text restrictions leave the microphone visible but disabled.

**Microphone -> disabled spinner -> solid red stop square -> disabled spinner
-> microphone.** A fixed-height status row above the complete editor shows
preparation spinner/text, then a volume-reactive red dot, recording text and
sample-based elapsed time, then processing spinner/text. Only actual capture
uses the red dot. Wait for it before speaking. No microphone stays open between
recordings to suppress browser permission prompts.

Failure changes that same button to a red retry icon with an accessible error
description and tooltip. Click to replay the retained recording; it does not
open the microphone again. A failed microphone startup has no recording, so retry
starts a new capture instead. A confirmed `AUDIO_TOO_SHORT` failure (under 100 ms)
discards the unusable recording and returns to idle, just like cancellation.
Other failures never silently discard a captured recording.
There is no automatic retry. The status row displays safe errors; retry remains
in the microphone button. Its right-hand clear icon cancels pending work and
destroys this recording, retained transcript and errors without deleting the
existing draft. Late completions cannot restore cleared results.

Azure server VAD detects speech and automatically commits turns while the
browser continues recording and uploading the complete PCM stream. Its end-of-turn
silence duration is explicitly **1 second (1000 ms)**, confirmed by Azure's
`session.updated` before audio is sent; missing/mismatched values fail visibly,
never silently fall back. Threshold, prefix padding and other VAD options remain
unset. This is not a proven fix for rate limiting (see #24). `gpt-transcribe`
starts recognition after each turn is committed, not necessarily while a
continuous sentence is still being spoken. Text deltas update the original
selection as they arrive; each final transcript replaces that turn's provisional
text rather than appending it again. All available turns are composed in speech
order, even if earlier turns are still empty. Late earlier text can move later
text to the right. The microphone-button entry only writes a draft, never sends.
If the draft changed, its text is not overwritten:
the separate result recovery field offers copy, explicit insertion at the
current caret, or discard. Only this conflict recovery adds a result panel.

## Hold to talk on an empty input

An empty, unfocused, writable input displays a non-editing gesture layer:
**轻点输入，按住说话**. A short tap focuses the real textarea for typing or
native selection/paste. Before the 300 ms hold threshold, pressing does not
show or announce recording status, change the layout or acquire the microphone.
Preparation feedback starts only when microphone startup begins. Once ready, the status
row's red dot changes size with captured volume; the button is a static red stop
square. Text can appear while held. A normal active release stops capture, uploads
its remaining tail and waits for the complete transcription, then submits the
original input draft once through its normal native send logic.
Release before readiness cancels instead. Clicking the microphone uses the
same status row and clicking the stop square ends capture.
There is no full-screen shade or parallel editor.

Release locks the original input's send intent: a prompt sends an ordinary
message to its original session (using the native queue even if an ask appears
after release); an ask answers that original live question; a plan input sends
that original plan feedback. It never uses the newly visible input's submit.
Session/tab navigation after release does not revoke or redirect the intent.
Navigation before release instead stops/transcribes into the original draft
without sending. Streamed VAD turns never submit individually.

The normal submission includes the original draft's existing attachments. Any
external text or attachment/schema-content change after release prevents
automatic sending and preserves the recording/result for manual confirmation.
If no words are recognized, nothing is sent, even when attachments exist; they
remain in the draft. A retired decision/session cannot submit.

Transcription failure still permits manual replay; a released hold keeps its
send intent for the successful replay, subject to the original draft guards.
Native submission failure or uncertain acknowledgement instead preserves audio,
text and a distinct send error, without a module resend button or another
transcription attempt. Check the original session's messages/queue and use its
normal host-controlled confirmation/send workflow deliberately. Clear only
discards local speech resources; it cannot retract an already-submitted message.

Swipe upward 64 CSS pixels from the initial press to cancel immediately, even
during startup. Moving back never resumes that press, and release afterward
cannot submit. Sideways/downward movement and small upward movement do not cancel;
the initial press still must be in the input, not File/microphone/send buttons.
Explicit cancellation (upward swipe, Escape, or clear/discard) destroys audio
rather than retaining it for retry and stops future text updates; already-written
draft text is preserved, not automatically undone. Capture loss, system interruption, window
blur, page hiding, resize, Tab and input replacement instead end capture and
continue transcription into the original draft. Unrelated chat scrolling does
not interrupt. Leaving during microphone startup cancels acquisition immediately;
a late permission grant cannot open a microphone after departure.

At 120 seconds, a held gesture stops capture and retains its bounded audio until
release triggers the final input drain. Azure may already have committed turns
and returned text while held. Swiping up discards retained audio and stops future
updates, but cannot undo provider processing or charges. The independent
microphone button automatically stops and drains at the same limit.

Focused or nonempty inputs keep native editing. To paste into an empty unfocused
input, tap first, then use native long-press paste. Keyboard Tab still focuses
the real textarea; the gesture layer adds no tab stop. The independent microphone
button remains the accessible alternative and retains its existing behavior.
Speech requires the host's `draftLifecycleVersion: 1` and
`draftSubmissionVersion: 1` capabilities
as well as Cockpit's additive public UI classes. It uses the
existing `composerEditor` middleware for the full-width status row and leaves
queue/question layout and scrolling entirely to the host. Input hint size,
status typography, spacing and alignment are public host classes, not private
host selectors or separately exported font variables.

The layer suppresses selection and touch callouts rather than intercepting a
long press on an editable textarea. This is not a claim of iOS Safari/PWA
hardware compatibility: microphone permission, transient activation and OS
gesture behavior still require real-device verification. If microphone startup
cannot complete while held, release safely and use the microphone button.
In particular, iOS home-screen web apps may ask for microphone permission again.
The browser owns permission persistence; the module cannot promise permanent
authorization and deliberately releases the microphone after stop/cancel.

## Desktop F8 push to talk

With the Cockpit page focused and its current writable textarea **empty**, hold
the fixed, unmodified **F8** key to start immediately; wait for the recording red
dot, speak, then release F8 to transcribe and send once. **The textarea need not
have focus.** Page blank space, sidebar, buttons and other focused controls
all support F8 without changing their text or moving focus. Both its controlled
value and original draft must be empty (spaces
count as text). Existing attachments are allowed and keep the normal #16 send
guards. Nonempty drafts keep native editing; use the microphone button for
selection-based dictation without automatic sending.

F8 is gated by the chat target, not by the focused control or the mere presence
of a dialog/popover. Hidden, inert, offscreen, disabled, readonly or unavailable
composers and IME composition remain excluded. A native modal dialog makes a
chat editor outside it unavailable; a current writable editor inside it can
still receive F8.
If more than one eligible composer is visible, it does not guess a target.
It does not focus the textarea or move its caret, including when interrupted
transcription later completes. Auto-repeat cannot start another recording.
Escape explicitly discards the take; pressing another key, clicking/touching,
window blur, hiding, resize, input replacement
or unmount ends capture without authorizing a send. Starting microphone
permission and releasing before actual readiness also cannot send; late media
grants are closed.

Only normal F8 keyup after readiness captures the existing original-draft send
intent. Prompt, ask and plan use exactly the same native submission/ACK path as
pointer hold, including original-target delivery after release and navigation,
manual transcription retry, no send for empty recognition, external edit/schema
guards, and no blind resend after an uncertain ACK. The microphone stop button
still only finishes into the draft. Keyboard, pointer hold and button capture
cannot acquire a second microphone or adopt each other's release.

An interrupted press stays disarmed until F8 is released; a late keyup never
sends it. If a keyup was lost, release F8 once before starting a new press.
A new non-repeat keydown while the old press remains latched interrupts the old
take rather than sending it. The existing two-minute capture cap still applies;
missing keyup is never converted into automatic send.

This is a **webpage shortcut, not an OS-global hotkey**. Browsers, extensions,
developer tools or the OS may consume F8; the webpage cannot override that.
The browser address bar and other applications do not deliver keyboard events
to the page, so F8 cannot start recording there.
Lenovo/other keyboards may require Fn+F8 or a firmware Fn-lock setting to emit
F8; the module cannot control Fn mapping. There is no shortcut settings page.
Synthetic keyboard/media coverage is not Windows/Lenovo hardware acceptance;
the independent real-device work in #8/#9 remains open.

### Windows Chrome input troubleshooting

Microphone permission and an active recording indicator do not prove that the
selected input contains speech. Check the input meter in Windows Settings >
System > Sound, then explicitly select the same working microphone in
`chrome://settings/content/microphone` and reload Cockpit. Chrome's previous
default input can differ from the working device, including after attaching a
wireless receiver. No device names, IDs, audio or transcripts need to be shared.

For the reported desktop incident, explicitly selecting Chrome's microphone
restored dictation. Silence still produced text afterward, which is a separate
provider-input handling issue. This release does not claim to fix Windows
drivers, change the system default microphone or prove all physical devices work.

## File-only configuration

Configuration reads require Linux: on other platforms `O_NOFOLLOW` is unavailable,
so requests fail with `UNSUPPORTED_PLATFORM` instead of reading without symlink
protection. On Windows, run Cockpit inside [WSL2](https://github.com/waksana/cockpit/blob/main/docs/install.md#windows-wsl2).

Create **`<dataRoot>/azure-openai.json`**, outside the immutable module install.
The host supplies dataRoot; the default is:

```text
~/.cockpit/modules/data/cockpit-speech/azure-openai.json
```

Use exactly three fields (these are placeholders):

```json
{
  "endpoint": "https://YOUR-RESOURCE.openai.azure.com",
  "key": "YOUR-AZURE-OPENAI-RESOURCE-KEY",
  "deployment": "YOUR-GPT-TRANSCRIBE-DEPLOYMENT-NAME"
}
```

Deploy `gpt-transcribe`, then supply the deployment name, which may differ from
the model name. Use a lowercase resource hostname. Only public Azure OpenAI HTTPS
origins are supported: no custom/sovereign hosts, ports, credentials, query or
path. A trailing slash is accepted. Keep the directory private and the regular,
non-symlink UTF-8 file at mode `0600`; the file is bounded to 16 KiB. No environment
fallback, legacy `azure-speech.json`, resource-key readback or settings UI exists.

The backend rereads the file on each credential request. The browser reuses
credentials for at most one minute, and never within 30 seconds of their
`expiresAt`. Thus on-disk changes can take up to one minute to affect new
recordings. Explicit retry always requests fresh credentials/configuration.
Already-open connections retain their original configuration. Reloading or
unloading the module clears its memory cache; it does not revoke Azure tokens.

**0.2.0 connection contract break:** `POST /session` now accepts only `{}` and
returns `{clientSecret, expiresAt, socketUrl, deployment}`. Context is no longer
accepted. The old WebRTC `callsUrl` has no alias. Frontend/backend assets must
come from the same module archive. The three-field configuration is unchanged.

## Buffering, privacy and retry

The browser starts capture while obtaining credentials and opening a WebSocket.
A packaged AudioWorklet records mono PCM16 at 24 kHz into an append-only memory
record (at most 120 seconds / 5.76 MB of raw audio). Each connection first sends
`session.update`, including this recording's prompt or an explicit empty prompt,
and `server_vad` with `silence_duration_ms: 1000`, and checks the effective
configuration in `session.updated`. Only then does it
send the backlog and new chunks with bounded WebSocket backpressure.

Stop immediately releases the microphone, flushes the worklet's tail, sends all
remaining chunks and sends one final commit. A following input-buffer clear
acknowledgement drains ordered input operations, not the asynchronous transcriptions.
F8/pointer release and button stop do not add a one-second client wait.
The connection remains open until every committed item has a final result.
An empty-buffer error is normal only when correlated to that final commit.
No speech/empty final text leaves the original selection intact and displays a
safe status notice; it is not treated as a retryable protocol error.
Stop is also valid before the network is ready. On failure, sent chunks are still retained. Manual retry uses a new
connection and a cursor at the beginning of the same recording, with the same
captured context and a fresh item table. Results replace the same owned draft
region instead of duplicating previously written text. A manual draft edit
disables further automatic replacement and retains the latest result for recovery.
If tail capture fails, its receiver is aborted before the draft is unblocked;
only an explicit retry can resume updates. Inserting or discarding a partial
recovery result also ends its retained retry operation, so those controls never
leave hidden replay work behind.

For ordinary prompt inputs (and unchanged plan inputs), the excerpt is the
**last 1,000 Unicode code points** of the newest eligible
completed root assistant reply, captured when recording starts. Eligibility needs
the matching native session origin, nonblank native message ID and text, and no
agent ID or subtype. User/tool/system messages, children, subagents, skill output
and incomplete/unknown-origin messages are excluded. Stale/unavailable windows
contribute no context. The module uses the public read-only chat window, without
DOM scraping or fetching additional history.

For `ask_user` answer inputs, the reference instead comes from the captured
draft's public, read-only `askContext`: its current question and ordered choices,
not the latest ordinary assistant reply. `Question: ` precedes the trimmed
question, followed by `Choices:` and one `- ` line per nonblank choice.
The **entire reference, including labels, is at most 1,000 Unicode code points**.
The question takes priority; remaining space goes to choices in their original
order, truncating only the final fitting text without splitting a Unicode code
point. A long question can consume the whole budget. No choices is valid.
If the question is missing/blank or unavailable from the host, recording
continues without reference text and the status row explicitly says so; it never
substitutes a possibly unrelated assistant reply.

The host binds that context to the exact session, ask request and draft lifetime.
Speech captures it when recording starts, before awaiting microphone permission.
Updates, page/session switches and manual replay of the same audio never replace
the captured reference. Ended requests retire their drafts; a reused request ID
gets a separate lifetime. Context is vocabulary for transcription, not an
instruction to answer the question, and is never appended to the recognized text.

The `Reference vocabulary:\n` prefix plus context is at most 1,022 code points.
This prompt and all audio go **directly from the browser to Azure**. Backend
credential requests contain no user context. Audio, transcripts and credentials
are never persisted or logged by the module. Each input draft owns its recording,
captured insertion point/revision/context, result and error independently. The
host stores successfully inserted text as an ordinary draft, using its normal
draft persistence; the module never writes audio to IndexedDB/localStorage.

Switching sessions, replacing prompt with ask, hiding the tab or losing the host
connection ends capture, but does not cancel transmission or clear failed audio.
An already-stopped task keeps going and writes back only to its original draft,
even while that input is absent. Returning to a failed input restores its manual
retry. Conflicts retain both audio and recognized text until explicit recovery
or discard. Draft-only tasks release audio after reliable insertion; released
holds retain it until native submission is acknowledged. Explicit discard, authoritative permanent draft
retirement (an ended decision or deleted session), a confirmed under-100-ms
recording, or module/page teardown releases the recording. A hidden or unloaded
session is not a deleted session.

Only one microphone captures at a time. Other drafts' stopped tasks transmit
independently, without a task-count/concurrency cap or automatic eviction, as
selected by the user. Each retained two-minute task can use 5.76 MB of raw PCM
plus overhead, so unresolved drafts can increase memory use. A draft with an
unfinished/failed task must finish, retry, recover or explicitly discard it before
starting another recording. Each WebSocket handles one recording; retry creates
a new connection rather than reusing a connection across drafts.

All retention is confined to the current page/module lifetime: refresh or closing
the browser/PWA loses it. Browsers can freeze background pages and delay timers,
uploads or final results. There is no promise of continuous background execution,
no background microphone keepalive and no automatic retry; after resuming, work
can complete or expose a retained error for manual retry. Cancel cannot retract
already-transmitted data or charges.

Retries after an uncertain commit can be billed again. Token caching does not
raise deployment rate limits. Azure processing, retention, geography and pricing
follow the resource/model terms; Global deployments are not a promise of local
processing. Server VAD avoids transcription of tested silence, but can still
misclassify noise or miss quiet speech; it is not a guarantee against hallucination.
All PCM, including silence, still reaches Azure. There is no local VAD model,
fixed local amplitude cutoff, prompt-equality filter or rewriting pass.
VAD can create multiple billable turns before the user stops; response usage is
not a substitute for the Azure bill.

## Browser and draft safety

Requires HTTPS (localhost allowed), Web Audio/AudioWorklet, WebSocket and microphone
permission. CSP/network policy must allow packaged worklet assets and the configured
Azure `wss://` origin. Cockpit does not proxy around blocked connections.
The short-lived bearer is carried in the WebSocket URL's `Authorization` query
parameter; never log socket URLs or include them in diagnostic reports.

Audio-render sample counting enforces the 120-second cap independently of delayed
UI timers; a wall timer also requests stop. Microphone/worklet startup and socket
configuration each have 30-second deadlines, credential exchange has a 35-second
browser deadline, tail flush is bounded to 2 seconds, stalled upload to 30 seconds,
and final transcription to 90 seconds. All failure paths release hardware and
connections. Device/context listeners cover initialization and capture; normal
initial resume and deliberate stop do not create false failures.

The exact draft lifetime, session, purpose, revision, selection and context stay
with the recording. A lease blocks native send while capturing or transcribing,
and is released on failure, finish or cancellation. Retry reacquires the original
draft lease. Background completion uses the host's revision-guarded text write,
which rejects pending/unconfirmed sends, competing leases, retirement and
persistence errors. Manual edits win; recovery never follows a replacement input or a
reused request ID. Old connection callbacks and superseded completions cannot
write text. Azure can reuse a session ID for the same credential, so that ID is
not used as a local ownership key. Final text must match the committed item.

## Development and package

### Worktree setup

A new checkout or worktree does not inherit ignored local files. When its
dependencies are needed and not already prepared, follow the authenticated,
frozen installation below in that worktree. Plain documentation edits do not
require installing dependencies. Keep each worktree's `node_modules` and
dependency graph independent; do not copy or symlink the whole directory from
another worktree or a running installation.

pnpm automatically reuses package files from its content-addressable store,
using hard links or clones on compatible filesystems rather than sharing the
mutable dependency directory. `pnpm store path` shows the selected store.
Cache misses may still download packages, and crossing filesystems may require
copies. Keep the existing store configuration and lockfile; no forced `--offline`
mode or global virtual store is needed. See [pnpm's store explanation](https://pnpm.io/10.x/faq).

### Authenticated build

Requires Node **24.20.0**, pnpm **10.34.5** and TypeScript **5.9.3**. The exact
SDK dependency is in `package.json`; `pnpm-lock.yaml` records its registry
tarball and SHA-512 integrity. A clean source build needs no Cockpit checkout,
SDK export, workspace link or local tarball. Frontend API v2/UI v1,
`chatWindowVersion: 1`, `composerInputVersion: 1`, `draftLifecycleVersion: 1`
and `draftSubmissionVersion: 1` plus `uiSurfaceVersion: 1` are independently required.

GitHub Packages requires authentication even for this public SDK. Use a classic
PAT with `read:packages` and package access via the `NODE_AUTH_TOKEN` environment
variable. Put the following placeholder in a trusted **user-level** `~/.npmrc`
(or a file selected by `NPM_CONFIG_USERCONFIG`), not the project `.npmrc`:

```ini
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

The checked-in `.npmrc` only selects the `@waksana` registry. pnpm does not expand
credential placeholders from project config. Never put the actual token into a
file, command argument, log or commit. CI uses `actions/setup-node` registry
configuration and `NODE_AUTH_TOKEN: ${{ github.token }}` with `packages: read`;
the package must grant this repository Actions read access.

```sh
# NODE_AUTH_TOKEN is already supplied securely through the environment.
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
# After committing clean source; use a new output directory.
node scripts/package.mjs module-output-dev
node scripts/verify-package.mjs module-output-dev/cockpit-speech-0.0.0-dev.tgz
```

Archives contain runtime code, worklet assets, licenses and exact source/SDK
receipts, never recordings, configuration, node_modules or another React/host
implementation. Format-2 receipts identify the SDK by package name, version,
resolved registry tarball and integrity, not a host source SHA. YAML parsing is
build-only. The frontend obtains React from `context.react`; an automatically
installed optional React peer stays in the development dependency tree, not the
archive. SDK backend/frontend types use `/backend` and `/frontend`; common and
runtime-only consumers use the root and `/runtime` public entries respectively.

These commands build a development package, not a production release candidate.
Every actual main PR merge automatically attempts an immutable Rolling Release
at the exact merge SHA. A separately selected Milestone only promotes an existing
Rolling in place. Deployment uses verified release bytes, never local rebuilds
or replacement bytes under an existing version. See the canonical
[release procedure](docs/releases.md); these local commands do not publish or deploy.
See [development](docs/development.md),
[release notes](docs/release-notes.md), [provenance](NOTICE.md) and
[security](SECURITY.md).
