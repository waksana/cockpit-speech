# Cockpit Speech

Standalone, GPL-3.0-only Cockpit module for **Azure LLM Speech enhanced file
transcription**. No Speech SDK, browser speech recognizer, LLM postprocessor,
settings page, menu entry, or automatic submission.

The microphone appears immediately after the **actual editor** and before its
native send button, including prompt, ask and plan inputs. Click to record;
click the square to stop, send that recording to Azure, and insert the returned
text into the captured draft selection. There is **no realtime text before
stop**. Review the text, then use Cockpit's normal send action yourself.
If the native request disallows free text, the microphone stays visible but
disabled. Cancel is available during permission, recording and transcription.

## Configuration — file only

The backend reads **`<dataRoot>/azure-speech.json`** on every transcription and
readiness request. The host supplies `dataRoot` following `COCKPIT_HOME`; its
default is:

```text
~/.cockpit/modules/data/cockpit-speech/azure-speech.json
```

Create the directory and file yourself, **outside the immutable module install
directory**. Use exactly these two fields; the following values are placeholders,
not credentials:

```json
{
  "endpoint": "https://YOUR-RESOURCE.cognitiveservices.azure.com",
  "key": "YOUR-SPEECH-RESOURCE-KEY"
}
```

Replace `YOUR-RESOURCE` with your actual **lowercase** Azure Speech resource name
and `key` with that resource's key. The endpoint must be its HTTPS origin (optional
trailing slash), without a port, path, query or credentials. Only
`<resource>.cognitiveservices.azure.com` is accepted; regional hosts, private
custom hosts, sovereign clouds and arbitrary URLs are intentionally unsupported.
The Azure resource/region must support LLM Speech. An existing TTS resource is
not assumed to have this capability.

Recommended file permissions:

```sh
chmod 600 ~/.cockpit/modules/data/cockpit-speech/azure-speech.json
```

For a nondefault `COCKPIT_HOME`, use the actual host-supplied module data directory
instead. The file must be a bounded regular, non-symlink UTF-8 JSON file (16 KiB
maximum). Missing/malformed configuration is checked **before microphone permission or
capture**, and errors appear directly in the speech UI. Provider authentication
errors appear when Azure processes a recording. Correct the file and explicitly record again; there is no
environment-variable fallback, initialization UI, automatic retry, or key
readback. Activation does not require the file. The read-only `/config-ready`
module route is called on every recording attempt. It validates file readiness only, not provider authentication, and
never returns the key or endpoint. A failed recording is not silently retried.

## Privacy and context

After stop, the recording goes to the module backend and the configured Azure
Speech resource. The module sends, with that recording only, an optional short
excerpt from the **most recent eligible completed root assistant message** in the
current loaded chat window. Eligibility requires matching native session
origin, a nonblank native message ID, no agent ID or subtype, and nonblank text.
User/tool/system messages, child messages, subagent and skill output, unknown
origins and incomplete messages are excluded. This is selected at the record
click, not refreshed while recording or transcribing.

**Module policy:** at most **200 Unicode code points**, taking the beginning of
the eligible message. This is not a host limit or a summary. A disconnected,
stale, unavailable or different-session window contributes no context; recording
does not fetch additional history. Partial windows may contribute eligible
loaded messages. The module never scrapes DOM text or accesses private stores.

The fixed English prompt tells Azure to transcribe only supplied audio, in its
spoken language, not to answer, translate or summarize, and to treat the excerpt
as untrusted reference vocabulary rather than content to insert. The Azure
model remains a provider dependency: this instruction is not a guarantee against
recognition mistakes or provider-side hallucination. There is no second model or
local rewriting pass. Provider `combinedPhrases` are validated and joined in
their returned mono order.

Audio and transcripts are not written to server disk, uploaded through a file
module, or logged by this module. They are processed in memory. Azure receives
audio/context under your resource's service/data terms; consult those terms
before recording sensitive material. The browser keeps a recognized result
temporarily if automatic draft insertion conflicts. It is not persisted by this
module and is lost on reload or module unload unless copied/inserted first.

## Browser and draft safety

Use HTTPS (localhost is also allowed), permit microphone access, and use a
current browser with AudioContext, AudioWorklet, and 16 kHz context support.
Audio is captured through a packaged AudioWorklet, downmixed to mono, and
encoded as 16-bit PCM WAV. **Web Audio performs hardware-rate resampling into
the explicitly requested 16 kHz AudioContext**; an unexpected actual rate is an
explicit error, never mislabeled or naively resampled. This avoids Safari's
MediaRecorder MP4-container assumptions and third-party codecs. Browser/device
support and real microphone permissions still need validation on your devices.

Maximum recording duration is **120 seconds**, with a hard sample-count and
wall-clock cap. Reaching either limit automatically stops recording and transcribes
the audio already captured, including the final partial buffer. It does not
discard the recording or submit a native message. PCM capture holds up to 7.68 MB
of float samples, plus the 3.84 MB WAV and bounded encoding/request copies.
Backend limits are 10 MiB decoded audio and 15 MiB JSON; it additionally requires
the module's canonical WAV format and 120-second bound. Azure response bodies
are limited to 1 MiB, recognized text to 100,000 code points, and provider time
to 90 seconds. One backend transcription runs at a time. No automatic retries.

The click unlocks Web Audio synchronously, but microphone acquisition waits for
the cancellable configuration check. Recording captures exact draft lifetime, session, purpose, text revision and
selection. A draft lease blocks native sending during capture/transcription.
Cancellation, input replacement, navigation, disconnect, hiding the page,
unmount and module abort release resources and the lease; a late permission
grant is stopped immediately. No native send/answer APIs are available here.

Manual edits win: if the revision changes, or another blocker prevents insertion,
the recognized text remains in a visible read-only recovery field. Use **Copy
text**, or **Insert at current cursor** only while the exact original live input
is still selected and writable. Explicit recovery insertion never deletes a
selected text range. It never follows a different session, replacement decision,
or reused request ID. Discard is explicit, and a retained result prevents a new
recording from silently replacing it.

## Build and package

Requires **Node 24.20.0**, **pnpm 10.34.5**, Git and tar. The SDK pin is in
`tooling/host-sdk.json`, currently source commit
`d752dd6a016f8ff84235c4cd8850e2b63778bf1b` (`@cockpit/module-api` 0.2.5).
This is a **current unreleased host-source pairing**, not a claim that an existing
published host release supports these capabilities. The pin must be reachable
from the configured host repository before remote CI can check it out.
Frontend API v2/UI v1 plus additive `chatWindowVersion: 1` and
`composerInputVersion: 1` are required independently.
Speech 0.1.1 wraps the host's real controlled textarea through `composerInput`;
it does not provide an editor or native submit implementation. Status/error/
recovery content follows the whole `composer` Base, outside the input row.
The host's prompt-only File button stays before the textarea, and its native send
stays after the microphone. Old Speech 0.1.0/host input contracts are not compatible.

```sh
# Check out the exact pin in a separate, clean host source directory first.
node scripts/sdk.mjs prepare /path/to/clean-pinned-cockpit
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
# Packaging requires the module's own committed, clean source and a fresh build.
pnpm package
node scripts/verify-package.mjs module-output/cockpit-speech-0.1.1.tgz
```

The SDK exporter checks the exact clean host commit; generated `.cockpit-sdk` is
local, verified and ignored. There are no runtime npm dependencies, borrowed
node_modules, production credentials or real-provider tests. Packaging records
source SHA, SDK pin, Node/platform and file hashes; stale/dirty builds, links,
test output and inventory drift fail. Archives contain only the module manifest,
compiled runtime/assets/licenses, GPL license and build receipt—not config, keys,
dependencies, source tests or recordings. Install the resulting archive through
Cockpit's existing module installation flow; this repository does not deploy it.

See [release notes](docs/release-notes.md), [development and verification](docs/development.md), [provenance](NOTICE.md)
and [security](SECURITY.md). Azure endpoint and enhanced-mode documentation:
<https://learn.microsoft.com/en-us/azure/ai-services/speech-service/llm-speech>.
