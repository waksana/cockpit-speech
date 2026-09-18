# Development and verification

The backend has one internal `SessionIssuer` interface and one Azure OpenAI
implementation, not a provider plugin framework. Its only route is:

- `POST /session`: JSON `{context?: string}`. It rejects audio, model, key,
  endpoint and other browser-supplied options. Returns
  `{clientSecret, expiresAt, callsUrl}` or a safe `{error:{code,message}}`.
  Responses are `no-store`. One credential exchange runs at a time; this is not
  a global limit on already-connected browser sessions.

`src/server/config.ts` rereads `azure-openai.json` using `O_NOFOLLOW`, bounded
regular-file reads and inode/device identity checks. It accepts only endpoint,
key and deployment, and never attaches raw parse/I/O errors. No legacy config
or endpoint alias is retained.

`src/server/azure.ts` requests `/openai/v1/realtime/client_secrets` using the
server-held API key, `session.type: "transcription"`, the configured
`gpt-transcribe` deployment, captured context labeled as reference vocabulary,
and `turn_detection: null`. It rejects redirects, combines cancellation and a
30-second deadline, bounds provider JSON, and discards raw error bodies.
It returns only the short-lived credential, expiry and locally constructed
allowlisted WebRTC calls URL. No audio/transcript proxy or persistence exists.
The label is 22 code points: with all 1,000 context code points the total prompt
is 1,022, below Azure's 1,024-code-point bound. No-context sessions omit `prompt`.

`src/web/recorder.ts` unlocks Web Audio during the click. Credential issuance
must succeed before microphone access. A new peer/data channel and initially
silent audio destination are created per attempt. SDP is posted directly to
Azure with the short-lived credential. Once the channel is open and initial
buffer clearing is acknowledged, the microphone feeds the WebRTC audio track.
Track-ended listeners are attached as soon as permission returns; context
state is watched from creation, allowing the initial suspended-to-running
transition but rejecting later suspension. Tracks remain disabled until a final
audio-track `readyState` and context-state check. A shared 30-second preparation
deadline covers permission, resume, SDP, channel open and buffer clear.
An audio-clock gain boundary and wall timer cap recording at 120 seconds.
Stop releases hardware, drains the final RTP audio for 250ms, then commits once.
Only a bounded final transcript whose item ID matches that commit can complete.
Deltas never mutate a draft. Final-before-ack ordering is tolerated; unrelated
items, missing acknowledgements, errors and deadlines fail explicitly.

All tracks, peer/channel handlers, timers and contexts are released on finish,
cancel or setup failure. Pending permission/SDP cannot revive a cancelled
operation. Disconnect does not reconnect or replay audio. Runtime cancellation
does not revoke an Azure credential or retract data already sent to Azure.

`src/web/speech.ts` remains the activation-scoped state service owning draft
identity, selection, revision, context capture, leases, cancellation and recovery.
The actual `composerInput` Base retains native controlled props/events and React
19 ref cleanup; the microphone is its sibling. The existing `composer` wrapper
renders feedback after the whole row. Focus receipts remain draft/revision scoped.
No business slot, private DOM lookup, copied editor or submission method exists.
The public control-size token fixes the circular button's dimensions. Idle and
recording use microphone/stop icons; all preparation/stopping/transcribing phases
use a disabled, accessibly named busy spinner. There is no stage text, timer or
busy-click cancellation. Error/notice/recovery feedback remains after the row;
navigation, target invalidation and module disposal still cancel internally.

## Existing synthetic checks

`pnpm test` uses Node's existing built-in runner and TypeScript stripping, without
Azure credentials, real microphone devices or production configuration:

- Config migration, strict origins/deployment fields, rereads, bounded regular
  files, symlinks, safe failures and no legacy fallback.
- Session-only requests, exact GA/provider configuration, contextual Unicode
  limits, no key readback, bounded responses, cancellation and no retries.
- Audio preparation without permission, expired credentials, late permission,
  WebRTC offer cancellation, safe SDP rejection and resource cleanup.
- Actual recorder plus service-lease regressions for device/context failures at
  offer, remote description, channel open and buffer clear; missing events are
  caught by final readiness checks. Initial resume and intentional stop do not
  raise false failures; preparation and final deadlines release all ownership.
- Buffer-clear/commit acknowledgement, final-before-ack, mismatched item IDs,
  late completions, invalid/oversized/empty transcripts and provider errors.
- Audio-clock gating, 120-second stop/commit, double stop, final timeout and
  peer/channel/microphone/context failures.
- Context provenance, native session identity and trailing 1,000 code points.
- Prompt/ask/plan exact draft leases, manual edits, reused request IDs, pending/
  unconfirmed/peer blocks, cancellation/revocation, recovery and caret receipts.
- Native ref composition, middleware/capability checks, package closure,
  source/SDK identity and reproducibility.

Synthetic checks do not establish real hardware support, network reachability,
provider availability, recognition quality or billing. Before release, exercise
target-device permission grant/deny, cancellation during permission/negotiation,
Safari/Firefox/Chromium, interrupted networking, 120-second capture, cancelled
late finals and recovery. Credential expiry before negotiation requires a new
explicit recording attempt; no automatic refresh/retry occurs.

CI prepares the fixed SDK, installs frozen dependencies, and runs typecheck,
synthetic tests, clean-source build/package and exact archive verification.
It has read permissions only and no credential-backed/cloud integration.
An optional real-provider smoke requires explicit authorization, synthetic audio,
an isolated resource/config directory, no credential logging and full cleanup.

## Paired host regression

The unchanged public API pin is `d752dd6a016f8ff84235c4cd8850e2b63778bf1b`,
SDK 0.2.5. Prepare it with the existing exporter, install from the frozen
lockfile and build the module. From the host branch with the current paired
fixture, run:

```sh
COCKPIT_TEST_SPEECH_ENTRY=/absolute/cockpit-speech/dist/web/index.js \
  pnpm --filter @cockpit/web exec tsx --tsconfig tsconfig.app.json --test \
  src/components/Thread.lifecycle.test.ts
```

This mounts the production Composer and actual compiled middleware with synthetic
Web Audio, WebRTC/data-channel, permission and HTTP providers. It checks native
send leases, natural component order, feedback placement, React 19 cleanup,
manual-edit recovery and caret/focus. The host's existing Chat Lab remains the
browser surface; do not create a parallel UI app. The host API PR must merge
before this consumer PR; a reproducible feature pin is not a published release.
