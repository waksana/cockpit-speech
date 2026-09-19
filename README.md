# Cockpit Speech

Standalone, GPL-3.0-only Cockpit dictation using **Azure OpenAI gpt-transcribe,
browser-direct WebSocket, local audio buffering and captured chat context**.
The backend only exchanges its resource key for short-lived credentials; it
never receives audio, context or transcripts. No Entra business authentication,
speech SDK, postprocessor, settings page or automatic submission is required.

## One-button dictation

The fixed circular microphone follows the actual editor and precedes native
send, for prompt, ask and plan inputs. File stays on the left and prompt-only.
Native free-text restrictions leave the microphone visible but disabled.

**Microphone -> disabled spinner (starting microphone) -> red volume dot
(local recording) -> disabled spinner (sending/transcribing) -> microphone.**
Wait for the red dot before speaking. Permission and device startup still take
time, but credentials and networking no longer delay local recording. There is
no timer, adjacent phase text, or success/error notification panel.

Failure changes that same button to a red retry icon with an accessible error
description and tooltip. Click to replay the retained recording; it does not
open the microphone again. A failed microphone startup or recording shorter
than 100 ms has no replayable audio, so retry starts a new capture instead.
There is no automatic retry or busy-click cancellation.

`gpt-transcribe` recognizes the committed audio turn, not live captions or a
duplex conversation. Successful text is inserted at the original selection,
never sent automatically. If the draft changed, its text is not overwritten:
the separate result recovery field offers copy, explicit insertion at the
current caret, or discard. Only this conflict recovery can add a panel.

## Hold to talk on an empty input

An empty, unfocused, writable input displays a non-editing gesture layer:
**轻点输入，按住说话**. A short tap focuses the real textarea for typing or
native selection/paste. Holding for 300 ms starts the existing microphone button's
spinner. Once ready, a red dot inside that button changes size with actual
captured volume, always within the fixed button bounds. Release to transcribe
into the original draft, never send a message; the same button spins while
waiting for the result. Release before readiness cancels instead. Clicking the
microphone uses the identical spinner/red-dot feedback; clicking the dot stops.
There is no full-screen shade, separate loading indicator or status panel.

Swipe upward 64 CSS pixels from the initial press to cancel immediately, even
during startup. Moving back never resumes that press, and release afterward
cannot submit. Sideways/downward movement and small upward movement do not cancel;
the initial press still must be in the input, not File/microphone/send buttons.
Cancellation discards audio rather than retaining it for retry. Capture loss,
system cancellation, window blur, page hiding, resize, Escape/Tab and input
replacement also interrupt a hold. Unrelated chat scrolling does not.

At 120 seconds, a held gesture stops capture and retains its bounded audio but
does not commit or insert anything until release. Swiping up still discards it.
The independent microphone button keeps its existing automatic
stop-and-transcribe behavior at the same limit.

Focused or nonempty inputs keep native editing. To paste into an empty unfocused
input, tap first, then use native long-press paste. Keyboard Tab still focuses
the real textarea; the gesture layer adds no tab stop. The independent microphone
button remains the accessible alternative and retains its existing behavior.
No host API, SDK pin or backend protocol change is required.

The layer suppresses selection and touch callouts rather than intercepting a
long press on an editable textarea. This is not a claim of iOS Safari/PWA
hardware compatibility: microphone permission, transient activation and OS
gesture behavior still require real-device verification. If microphone startup
cannot complete while held, release safely and use the microphone button.

## File-only configuration

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
and checks the effective configuration in `session.updated`. Only then does it
send the backlog and new chunks with bounded WebSocket backpressure.

Stop immediately releases the microphone, flushes the worklet's tail, sends all
remaining chunks and commits once. Stop is also valid before the network is
ready. On failure, sent chunks are still retained. Manual retry uses a new
connection and a cursor at the beginning of the same recording, with the same
captured context; it never appends ambiguously to a failed connection.

The excerpt is the **last 1,000 Unicode code points** of the newest eligible
completed root assistant reply, captured at the first click. Eligibility needs
the matching native session origin, nonblank native message ID and text, and no
agent ID or subtype. User/tool/system messages, children, subagents, skill output
and incomplete/unknown-origin messages are excluded. Stale/unavailable windows
contribute no context. The module uses the public read-only chat window, without
DOM scraping or fetching additional history.

The `Reference vocabulary:\n` prefix plus context is at most 1,022 code points.
This prompt and all audio go **directly from the browser to Azure**. Backend
credential requests contain no user context. Audio, transcripts and credentials
are never persisted or logged by the module. Audio memory is cleared on success,
target invalidation, navigation, hiding the page, disconnect or module unload.
Failed audio stays only for the original live input, until retry or cancellation;
reload loses it. Cancel cannot retract already-transmitted data or charges.

Retries after an uncertain commit can be billed again. Token caching does not
raise deployment rate limits. Azure processing, retention, geography and pricing
follow the resource/model terms; Global deployments are not a promise of local
processing. Recognition can be incorrect, including hallucinations during
silence. There is no second model or local rewriting pass.

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
draft lease. Manual edits win; recovery never follows a replacement input or a
reused request ID. Old connection callbacks and superseded completions cannot
write text. Azure can reuse a session ID for the same credential, so that ID is
not used as a local ownership key. Final text must match the committed item.

## Development and package

Requires Node **24.20.0** and pnpm **10.34.5**. The immutable SDK pin remains
`d752dd6a016f8ff84235c4cd8850e2b63778bf1b` (`@cockpit/module-api` 0.2.5).
The host API from waksana/cockpit#52 is already merged; this transport change
requires no host API change. Frontend API v2/UI v1, `chatWindowVersion: 1` and
`composerInputVersion: 1` remain independently required.

```sh
node scripts/sdk.mjs prepare /path/to/clean-pinned-cockpit
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
# After committing clean source; use a new output directory.
node scripts/package.mjs module-output-0.3.0
node scripts/verify-package.mjs module-output-0.3.0/cockpit-speech-0.3.0.tgz
```

Archives contain runtime code, worklet assets, licenses and exact source/SDK
receipts, never recordings or configuration. Install through the existing host
module flow; these commands do not deploy. See [development](docs/development.md),
[release notes](docs/release-notes.md), [provenance](NOTICE.md) and
[security](SECURITY.md).
