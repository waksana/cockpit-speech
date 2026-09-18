# Cockpit Speech

Standalone, GPL-3.0-only Cockpit dictation module using **Azure OpenAI
`gpt-transcribe`, browser-direct WebRTC and captured chat context**. The backend
only exchanges its resource key for a short-lived client credential. It does not
receive audio or transcripts. No Entra business authentication, speech SDK,
postprocessor, settings page, menu entry or automatic submission is required.

The microphone follows the **actual editor** and precedes native send, including
prompt, ask and plan inputs. Click to connect and record; click the square to
stop, commit that audio turn, and insert its final transcript at the captured
selection. `gpt-transcribe` starts transcription after the turn is committed;
this is not live captions or a duplex voice assistant. Review the text and send
it with Cockpit's normal action. Native free-text restrictions leave the
microphone visible but disabled.

## Configuration — file only

Create **`<dataRoot>/azure-openai.json`**, outside the immutable module install
directory. The host supplies `dataRoot` following `COCKPIT_HOME`; its default is:

```text
~/.cockpit/modules/data/cockpit-speech/azure-openai.json
```

Use exactly these three fields; the values below are placeholders:

```json
{
  "endpoint": "https://YOUR-RESOURCE.openai.azure.com",
  "key": "YOUR-AZURE-OPENAI-RESOURCE-KEY",
  "deployment": "YOUR-GPT-TRANSCRIBE-DEPLOYMENT-NAME"
}
```

Deploy **`gpt-transcribe`** in a supported Azure region, then use that deployment's
name, not an arbitrary GPT chat model. `deployment` may differ from the model name.
Replace the resource placeholder with its actual **lowercase** resource name.
The endpoint must be its HTTPS origin, optionally ending in `/`, without a port,
path, query or credentials. Only `<resource>.openai.azure.com` is accepted;
private/custom hosts, sovereign clouds and arbitrary URLs are not supported.
Region availability, quota and model access are Azure dependencies.

```sh
chmod 600 ~/.cockpit/modules/data/cockpit-speech/azure-openai.json
```

For nondefault `COCKPIT_HOME`, use the actual host-supplied data directory.
The file must be a regular, non-symlink UTF-8 JSON file, at most 16 KiB. The backend
rereads it on every explicit recording attempt. Missing/malformed configuration
or failed credential issuance is shown **before microphone permission/capture**.
Activation does not require the file. Correct it and explicitly start again;
there is no automatic retry, environment fallback, key readback or setup UI.

**Breaking migration:** `azure-speech.json` and its Speech resource key are no
longer used. There is no legacy-file fallback, audio-upload `/transcribe` route,
or old `/config-ready` alias. The only module route is `POST /session`, accepting
optional context and returning a short-lived credential plus its expiry and
validated Azure WebRTC URL. The resource key never reaches the browser.

## Privacy and context

Pressing record captures the optional **last 1,000 Unicode code points** of the
most recent eligible completed root assistant message, after trimming outer
whitespace. Eligibility requires matching native session origin, a nonblank
native message ID, no agent ID or subtype, and nonblank text. User/tool/system
messages, children, subagents, skill output and incomplete/unknown-origin
messages are excluded. The public read-only chat window supplies context, not
write authority. No DOM scraping or additional history fetch occurs.

A stale, disconnected, unavailable or different-session window contributes no
context. Partial windows can contribute eligible loaded messages. Context is
captured at the initial click, not refreshed during permission or transcription.
This is module policy, not a provider maximum or a summary.

The backend sends that context to Azure **when requesting the short-lived
credential, before recording starts**. The prompt labels it `Reference vocabulary:`,
not an answer request. The 22-code-point label plus the complete 1,000-code-point
excerpt fits Azure's **1,024-code-point total prompt limit**. Without context,
the prompt is omitted; the session remains transcription-only. Once the connection
is ready, microphone audio flows directly
from the browser to Azure **during recording**, not only after stop. Cancellation
stops further transmission but cannot retract already-transmitted audio/context
or provider charges. The short-lived credential is not a one-use billing quota;
protect access to the host and module endpoint.

Audio and transcripts are not uploaded through Cockpit or its file module,
written to disk, or logged by this module. Credentials are held in memory only.
Azure processing, retention, geography and billing follow your resource/model
terms; a resource location is not a promise that a Global deployment processes
only there. Recognition can be wrong or hallucinate despite the prompt.
There is no second model or local rewriting pass.

## Browser and draft safety

Use HTTPS (localhost is allowed), Web Audio, WebRTC and microphone permission.
Any deployment CSP or network policy must allow the configured Azure OpenAI
origin and WebRTC connectivity; Cockpit does not proxy around blocked connections.
The click unlocks audio synchronously; permission follows successful credential
issuance. A fresh WebRTC connection is created for each recording. A silent
output track is negotiated first, then microphone audio is admitted only after
the initial buffer-clear acknowledgement. WebRTC negotiates encoding/resampling;
there is no WAV buffer, AudioWorklet asset or fixed hardware sample-rate
requirement. Microphone audio is not played locally.

The maximum recording duration remains **120 seconds**. Audio-render-clock
gating bounds transmission even if the JavaScript timer is delayed; the wall
timer stops capture and automatically commits the turn. Stop immediately
releases the microphone, briefly drains remaining audio over the silent track,
and commits once. Connection setup is bounded to 30 seconds after permission;
final transcription is bounded to 90 seconds after commit. Responses/events and
recognized text are bounded. No automatic reconnect, replay or retry occurs.

Only a final transcription matching this connection's acknowledged committed
item may write text. Incremental deltas, unrelated items, late events and stale
operations never write the draft. Stopping or expiry of a short-lived credential
does not substitute for closing the peer: cancellation explicitly releases
tracks, data channel, peer, audio context and draft lease.

Recording captures the exact draft lifetime, session, purpose, revision and
selection. A lease blocks native send while connecting/recording/transcribing.
Cancellation, input replacement, navigation, disconnect, page hiding, unmount
and module abort release it. A late permission grant is stopped immediately.
Manual edits win: conflicted recognized text remains in a read-only recovery
field. **Copy text** or **Insert at current cursor** is available only as
appropriate for the original still-live input; recovery never deletes a selected
range, follows another session, or follows a reused request ID. It is in-memory
only and is lost on reload/unload unless copied or inserted.

## Build and package

Requires **Node 24.20.0**, **pnpm 10.34.5**, Git and tar. The exact SDK pin remains
`d752dd6a016f8ff84235c4cd8850e2b63778bf1b` (`@cockpit/module-api` 0.2.5),
recorded in `tooling/host-sdk.json`. This is an unreleased host-source pairing,
not a claim that an existing release supports the input capabilities.
The provider migration requires no additional host API.

Frontend API v2/UI v1, `chatWindowVersion: 1` and `composerInputVersion: 1` are
required independently. Speech 0.1.1 wraps the real controlled textarea,
preserving events/ref/selection; its feedback follows the complete `composer`
row. File remains prompt-only on the left, native send stays on the right.
Speech 0.1.0 and hosts without the real input contract are incompatible.

```sh
node scripts/sdk.mjs prepare /path/to/clean-pinned-cockpit
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
# Packaging requires committed, clean source and a fresh build.
pnpm package
node scripts/verify-package.mjs module-output/cockpit-speech-0.1.1.tgz
```

The exporter verifies the exact clean host commit. Generated SDK/build/package
outputs are ignored. There are no runtime npm dependencies. Archives contain
the manifest, compiled runtime/assets/licenses and source/SDK build receipt,
never configuration, credentials, tests or recordings. Install only through
Cockpit's existing module flow; this repository does not deploy the archive.

See [release notes](docs/release-notes.md), [development](docs/development.md),
[provenance](NOTICE.md), [security](SECURITY.md) and the
[Azure OpenAI WebRTC guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc).
