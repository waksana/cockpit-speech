# Cockpit Speech 0.9.0 (source preparation)

Proposed additive release for an independent shadcn presentation alongside the
unchanged default classic UI. The new `frontend.next` entry uses actual host
React components and its own isolated stylesheet. Recording, pointer/F8 input,
draft ownership, transcription retry and captured native submission share one
implementation across both presentations. Next combines phase feedback,
explicit cancel/retry and selectable recovery in the composer.
Pending retry keeps its focused action mounted. Removing an owned retry,
cancel or discard action restores focus to a remaining Speech action in the
same live composer, without activating text editing or taking focus elsewhere.

Both entries add a non-destructive native `beforeunload` confirmation request for
actual page-owned Speech work across all drafts, including retained/uncertain
results without a current blocker. No persistence, cross-page transfer or replay
is promised; browser confirmation may be suppressed by browser lifecycle rules.

The next-capable SDK foundation pin is
`0fa433d99c053df2caf80770f0f8762b9ed7002e`, API/protocol 0.3.0. Minimum paired host
is Cockpit 0.3.0 with independent new-presentation support; older hosts may reject
`frontend.next`. Both presentations retain existing persisted draft encodings.
The foundation pin is not a released-host or completed host-app claim.
This preparation is not a committed release artifact, tag, merge or deployment.

# Cockpit Speech 0.8.4 (source preparation)

Assign a fresh immutable package version to the merged shared-UI changes rather
than replacing installed 0.8.3 bytes. Manifest and package metadata agree.
The supporting host pin remains `9fd5204bda99a8bd65b2c5ef152cc47ce87837d5`;
`uiSurfaceVersion: 1` remains required. No recording, provider, draft or send behavior
changes. Contributor guidance documents version identity and final-artifact checks.
This preparation does not create a tag/Release or install/restart production.

# Cockpit Speech 0.8.3 (source preparation)

Asynchronous transcription completion places the owned caret without taking
editor focus or opening the mobile keyboard. Dismissing recovery no longer
focuses the editor. A completed short tap and explicit recovery insertion retain
their intentional editor activation. F8, recording/submission and draft ownership
semantics are unchanged; no focus-visible mode tracker or outline suppression is
introduced.

The unreleased shared UI migration reuses public recovery surfaces/action rows
and requires `context.uiSurfaceVersion === 1` alongside UI v1 before registration.
The exact paired host source is `9fd5204bda99a8bd65b2c5ef152cc47ce87837d5`
(exported SDK 0.2.6). The previous pin and historical UI-v1 releases do not
establish support for this new capability. Gesture, recovery and send semantics
remain unchanged; no extra React runtime or private host dependency is introduced.
This is not a tag, publication, deployment or actual microphone/provider test.

# Cockpit Speech 0.8.2

For #27, make F8 genuinely page-wide: blank space, sidebar, buttons, other
controls and editors may retain focus while the current visible, writable,
empty chat target records. Document capture-phase listeners prevent ordinary
controls' bubbling handlers from hiding F8. No forced textarea focus, caret
movement or edits to other controls are introduced.

This supersedes #20's overly narrow focus and blanket dialog/popover exclusions.
Only actual target unavailability blocks capture, including native modal
inertness outside the dialog; a current writable chat editor inside it remains
eligible. DOM disabled/readonly changes interrupt an active hold as well.

Empty-draft checks, readiness, repeat/modifiers/IME, late permission/key release,
Escape, page departure, pointer/mic exclusion, original-draft captureSend/ACK and
pre-/post-release navigation intent remain unchanged. F8 is a webpage shortcut:
the browser address bar and other applications cannot deliver it to the page.

SDK remains exactly Cockpit 0.2.6 /
`0b8d215bbfadd640b1e0e3cad410214019336f0b`. No host contract change, deployment,
production restart, cloud audio experiment or Windows hardware acceptance is
included.

---

# Cockpit Speech 0.8.1

For #25, explicitly request `server_vad.silence_duration_ms: 1000` in both
credential creation and browser session update. Only the user's final one-second
choice is implemented, not the earlier 1.5-second proposal. Before uploading audio,
require `session.updated` to confirm the exact numeric value; missing/mismatched
values fail visibly without default fallback. Threshold, prefix padding and all
other VAD parameters remain unchanged/unset.

Normal F8/pointer release and button stop keep the final tail upload, commit and
clear without a new one-second client delay. Capture, cancellation, empty results,
background original-draft writes, once-only send and native ACK policy are unchanged.
SDK remains Cockpit 0.2.6 / `0b8d215bbfadd640b1e0e3cad410214019336f0b`.

Local synthetic coverage does not establish cloud acceptance or recognition
quality. No cloud audio experiment, deployment, production restart or quota change
is included. The documented 500ms default is not a confirmed prior Azure effective
value; this change does not prove a rate-limit fix or resolve #24.

---

# Cockpit Speech 0.8.0

Fixed desktop F8 push-to-talk for #20, reusing #16's original-draft hold
submission and native ACK contract. The textarea must be empty but need not
have focus. Other focused controls/editors, modal/popover UI, IME and
hidden/unavailable composers are excluded; modifiers and auto-repeat do not
start recording. There is no shortcut setting or OS-global/Fn remapping.

Normal ready keyup captures one original prompt/ask/plan send intent. Startup
release, pre-release navigation, blur, hiding, replacement, missing keyup and
pointer/UI takeover cannot send; Escape discards. After release, navigation
does not redirect or revoke the original intent. Keyboard completion does not
steal focus. Existing button draft-only stop and pointer hold remain unchanged.

SDK remains exactly Cockpit 0.2.6 source
`0b8d215bbfadd640b1e0e3cad410214019336f0b`. No host API change, deployment,
production restart or actual Windows/Lenovo hardware acceptance is included.
Independent real-device issues #8/#9 remain open.

---

# Cockpit Speech 0.7.0

Active hold-release submission for #16, building on #11 and the native captured
draft submission contract in waksana/cockpit#59. The precise SDK pin is in
`tooling/host-sdk.json`; runtime requires `draftSubmissionVersion: 1`.

- Normal active release submits the original input once after complete
  transcription. Prompt-origin work stays ordinary original-session queue input;
  ask/plan-origin work follows that original input's native answer/feedback logic.
  A later session switch or ask does not change the captured purpose or consent.
- Button recording and interruption before release stay draft-only. Explicit
  cancellation, startup release, short taps and late pointer events do not send.
  The merged #13 short-tap feedback fix is preserved.
- Full-draft sends include existing attachments, but external text or attachment
  changes after release prevent automatic sending. Empty recognition sends
  nothing, including no attachment-only send. Multi-turn VAD submits only once.
- Transcription failure retains audio and release intent for manual retry.
  Native send errors/unknown ACK retain audio and text with a separate status;
  there is no blind resend, and clearing local audio cannot retract a message.

No deployment/restart or Windows/iOS real-device verification is performed.
---

# Cockpit Speech 0.6.0

For #17, paired with waksana/cockpit#61 and its exact SDK SHA in
`tooling/host-sdk.json`, ask-answer recordings use the question and ordered choices from the
public host draft context, captured once at recording start. Ordinary prompt
and plan context selection is unchanged. Reference text remains bounded to
1,000 Unicode code points including labels, with question-first allocation and
ordered choice truncation. Missing question context is explicitly shown as an
audio-only fallback, never replaced with unrelated chat text.

Session switches, question updates and retained-audio retries cannot replace
the captured reference. Request retirement and reused request IDs keep their
existing exact-draft ownership. No VAD/protocol or submission-policy changes.
Synthetic context/transport coverage does not establish device recognition quality.

---

# Cockpit Speech 0.5.0

Draft-owned recording lifecycle for waksana/cockpit-speech#11, paired with
waksana/cockpit#57 and the exact SDK SHA in `tooling/host-sdk.json`.

- Session/tab navigation and ask replacing prompt stop capture, not the task.
  Background transmission and transcription write only to the captured draft.
  Leaving during startup cancels acquisition, including late permission grants.
- Failed tasks restore their error/retry when the original input returns.
  Revision/write conflicts keep audio plus text for explicit recovery. Status,
  controls and late callbacks are scoped to draft identity, not the current input.
- User-confirmed exception: an explicit under-100-ms `AUDIO_TOO_SHORT` error
  discards that unusable take like cancellation, without retaining a retry task.
  Other failure codes do not trigger this discard.
- Host-confirmed ended decisions/deleted sessions release their tasks; temporary
  hiding/unloading does not. Successful guarded insertion, explicit clear/discard
  and module/page teardown also release resources. There is no cross-refresh
  retention or audio storage in IndexedDB/localStorage.
- One microphone captures at a time. User-selected independent per-draft
  transmission has no task-count/concurrency cap or silent eviction. Existing
  unfinished tasks cannot be replaced by a new recording in the same draft.
- Upward swipe and Escape remain explicit discard. Navigation/pointer loss
  detach the gesture and complete capture, including at the held audio limit.
  Browser background freezing can delay or fail work; manual retry remains.

Synthetic lifecycle coverage is not Windows/iOS hardware verification.
No deployment, service restart, tag or Release is performed by this source change.
---

# Cockpit Speech 0.4.0

Related to #8 and #9. Retains the Cockpit 0.2.6 SDK pin and public status UI.
No production deployment, restart, resource configuration change or new local
model dependency is part of this change.

- Enable Azure server VAD for browser-direct transcription. Full local PCM
  capture/upload remains independent of networking; silence is not cropped
  locally. Azure can commit multiple speech turns before capture ends.
- Keep a per-connection item table and compose all available text in speech
  order, including later-item text before earlier text arrives. Deltas update
  the exact original draft region; final text replaces each item's provisional
  text without duplication. No automatic chat submission.
- Stop flushes and uploads the tail, sends final commit then clears the input
  buffer as an ordered drain acknowledgement, and awaits every committed result.
  Only a final-request-correlated empty commit is normal. Legitimate empty
  transcripts preserve the selection rather than triggering replay.
- Track revisions from owned writes, keep user edits and peer blockers safe,
  retain conflict recovery, and replace the same region during full-audio retry.
  Live text must neither cancel its own held gesture nor steal keyboard focus.
- Cancel/clear discard audio and stop future callbacks, preserving already
  written draft text. Unlike 0.3.x, a held gesture can produce text and incur
  transcription charges before release.
- Document Windows Chrome's explicit microphone selection. The reported
  capture failure improved with device selection; no unsupported device,
  sample-rate or amplitude-threshold workaround was introduced.

Synthetic Azure results establish protocol behavior, not Windows hardware or
all-silence/quiet-speech accuracy. VAD can still misclassify; physical-device
acceptance and final billing remain unverified. Issues remain open for that
acceptance rather than being automatically closed by this source change.

---

# Cockpit Speech 0.3.1

Requires paired Cockpit 0.2.6 public input/status classes; the exact clean,
reachable SDK pin is recorded in `tooling/host-sdk.json`. Existing backend,
Azure configuration, audio transport and explicit submission behavior remain.

- Normal-flow status before the complete input row, using host-owned hint and
  auxiliary typography, fixed height, marker alignment and clear-button layout.
  No private host CSS, ancestor edits, new slot or queue/question layout changes.
- Immediate preparation feedback on an accepted press without opening audio
  before the existing 300ms threshold. Actual recording alone has a reactive
  red dot and PCM-derived time; the microphone button uses a solid red square.
  Preparation/processing use loading icons and accurate text. Held 120-second
  capture limits and errors use static indicators rather than false activity.
- Error text is visible in the same row. The microphone remains the sole retry
  control. Clear destroys the current recording/recovery/errors and cancels
  pending work, including late completions, without deleting existing drafts.
- The input hint follows the host's user-selected input size. Browser permission
  persistence, particularly iOS home-screen apps, is not controlled by this UI;
  stop/cancel still releases capture rather than retaining an idle microphone.

No tag or Release is created by the source change. Deployment requires explicit
operator authorization separately from merging.

---

# Cockpit Speech 0.3.0

Adds empty-input hold-to-talk for waksana/cockpit-speech#5. No deployment,
installation, service restart, tag or release is performed by the source change.

- Empty and unfocused writable inputs show a non-editing gesture layer. Tap to
  focus the original textarea; hold 300 ms to start local microphone acquisition.
  The layer preserves the input's background and uses a leading-aligned hint; it temporarily
  suppresses the native placeholder to avoid overlapping text.
- Re-evaluate a still-suspended AudioContext once after microphone permission is
  granted. This addresses the observed iPhone path where the microphone and
  worklet were ready but an earlier resume stayed pending without user activation.
  There is no extra microphone request, retained idle stream or early ready state.
- Keep the gesture layer mounted through a short touch release and focus the
  textarea synchronously from its completed click, not from pointerup. The
  resulting placeholder change no longer removes the touch target mid-gesture.
  Physical iPhone keyboard behavior still requires confirmation.
- User selected the non-editing gesture layer. All feedback stays in the existing
  microphone button: startup spinner, bounded red PCM-volume dot, then spinner
  while the result is written to the original draft, never sent. The standalone
  microphone's stop square is replaced with the same reactive dot. No full-screen
  shade or separate loading indicator remains. Startup release cancels.
- An upward swipe of 64 CSS pixels irreversibly cancels and destroys its audio,
  even under pointer capture or during permission acquisition. Sideways/downward
  movement no longer cancels. This replaces the earlier all-boundaries rule.
  Capture loss, system/page interruption and input replacement also cancel.
- At 120 seconds, stop capture but retain held audio without committing. Only
  release transcribes it; upward cancellation still discards it. Independent microphone
  recordings continue to stop and transcribe automatically at the limit.
- Focused/nonempty inputs preserve editing, selection and paste. Keyboard users
  still focus the textarea directly, and the existing microphone is unchanged.
  Existing draft leases, retry-after-transcription failure and conflict recovery
  remain in effect. No backend, host API or SDK pin change is needed.

iOS Safari/PWA real-device behavior is not verified. The overlay avoids competing
with native textarea long-press selection, but desktop synthetic coverage does
not prove mobile microphone activation, permission UI or OS gesture behavior.

---

# Historical: Cockpit Speech 0.2.0

Unreleased follow-up to waksana/cockpit#51. No tag, release, installation or
service restart is performed by this source change.

## Buffered browser-direct dictation

Replaces WebRTC with Azure WebSocket transcription. Microphone permission/capture
starts independently of credentials and network setup. A packaged AudioWorklet
keeps up to 120 seconds of PCM in browser memory. Every connection explicitly
sets and confirms this recording's prompt (including empty prompt), then drains
backlog and new chunks. Stop flushes the local tail before one commit.

The fixed circular button now represents startup, recording, finalization and
failure: microphone -> spinner -> stop -> spinner -> microphone, or red retry
on failure. Manual retry replays the same bytes and original context without a
new microphone capture. There are no normal/error notification bars, automatic
retries, audio persistence or automatic sends. Draft-conflict text recovery
remains separate. Target cancellation clears the retained audio.

The recovery panel leaves space above and below its border so it does not touch
the editor row or the enclosing input card's bottom edge. Its existing bounded
height and internal scrolling remain unchanged.

## Breaking module connection contract

`POST /session` accepts only `{}`; context is sent directly by the browser, never
to the backend. The response is `{clientSecret, expiresAt, socketUrl, deployment}`.
The old WebRTC `callsUrl` is removed without an alias. Frontend/backend must be
upgraded as one archive. `azure-openai.json` remains endpoint/key/deployment only.

Credentials are memory-cached for at most one minute, with a 30-second expiry
margin; retry forces a fresh configuration/credential request. Cached credentials
may briefly lag config-file changes. Retrying a previously committed recording
can duplicate Azure charges. Azure session ID is not a local ownership key.

The SDK remains pinned to `d752dd6a016f8ff84235c4cd8850e2b63778bf1b` / 0.2.5.
The host API is already merged; no host production/API change is needed.
The paired host regression fixture follows the new browser protocol.

---

# Historical: Cockpit Speech 0.1.1

Unreleased paired migration for [waksana/cockpit#51](https://github.com/waksana/cockpit/issues/51).
No tag, Release, installation or deployment is performed by this source change.

## Breaking host pairing

Requires Cockpit 0.2.5 source with `composerInputVersion: 1`, independently of
Web API v2, UI v1 and `chatWindowVersion: 1`. Removes the previous Composer actions
contract completely, without aliases or compatibility fallbacks.

The SDK is exported from reachable host commit
`d752dd6a016f8ff84235c4cd8850e2b63778bf1b`, module-api/protocol version 0.2.5.
`tooling/host-sdk.json`, generated SDK inventory, lockfile and package build receipt
bind the pairing. Merge the host API before this consumer; old Speech 0.1.0 and
hosts without the real input capability cannot be mixed with it.

## Input composition and lifecycle

Speech wraps the actual controlled textarea Base, preserving native events and
the public ref, and adds a microphone sibling before the independent native send.
File remains prompt-only and on the left; prompt/ask/plan microphones remain
visible, and native free-text restrictions still disable recording.

The existing composer boundary puts status/error/recovery after the entire row,
with bounded scrolling on short screens. There are no private DOM queries, visual
reordering, nested controls, duplicate editors or new host slots.

Successful insertion restores the original input's focus and caret only for its
exact draft lifetime and revision. Lifecycle cancellation does not
redirect late results. Draft leases, manual-edit conflicts, reused request IDs
and recovery remain bound to the captured lifetime.

Context remains the newest eligible completed root assistant reply captured at
record click. The excerpt now takes its **last 1,000 Unicode code points** after
trimming, instead of the first 200; shorter replies stay whole. Frontend selection
and backend validation use the same limit. This is module policy, not an Azure
maximum, and does not add history reads or change message eligibility.

## Breaking provider/configuration migration

Following the user's explicit provider decision, the same unreleased 0.1.1 now
uses Azure OpenAI **gpt-transcribe over browser-direct WebRTC**, not Azure LLM
Speech file transcription. Deploy gpt-transcribe and create `azure-openai.json`
with exactly `endpoint`, `key`, and `deployment`. The endpoint is the Azure
OpenAI resource origin. The old `azure-speech.json` is not read or migrated.

The only module route is `POST /session`. It exchanges the server-held key for
a short-lived credential and returns it to the browser; no Entra business
authentication is required. Audio/transcripts no longer pass through Cockpit.
The old `/config-ready` and audio-upload `/transcribe` routes are removed.
Context is sent when requesting credentials, and audio is sent during recording:
cancel stops further transmission but cannot retract data or provider charges.

The same 1,000-code-point excerpt accompanies pure-transcription session
configuration. Its short reference label keeps the complete prompt at 1,022
code points, within Azure's 1,024-code-point limit. Recording still ends after
120 seconds and commits once; final
text is inserted only after stop, never auto-sent. It is not a duplex assistant
or live-caption mode. A new connection per operation plus committed-item
correlation protects against stale completions. WAV buffering, the fixed 16 kHz
requirement and the packaged PCM worklet are removed.

This provider change requires no new host API or SDK pin, and does not change
the already-selected unreleased versions (host 0.2.5 / Speech 0.1.1).
Synthetic checks do not establish real microphone/browser-device support, Azure
availability, credentials or recognition quality.

## Review follow-up: preparation failures and button semantics

Monitor track termination immediately after permission and AudioContext state
from creation, without treating normal initial resume as failure. Recheck live
audio tracks and running context before admission; preparation failure releases
hardware, WebRTC, timers and the original draft lease instead of claiming recording.
Microphone tracks stay disabled during setup. The 30-second setup deadline now
also includes permission/resume, so unanswered permission cannot spin forever.

The circular button retains one size: microphone -> disabled spinner -> stop ->
disabled spinner -> microphone. No timer, adjacent phase copy, red retry mode or
busy-click cancellation; accurate accessible names and busy/disabled states remain.
Errors and conflict recovery retain the existing panel. There is no new audio
cache, upload fallback, replay or automatic send.
