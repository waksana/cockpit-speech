# Development and verification

The module has one small internal `Transcriber` interface with a single Azure
implementation, not a provider plugin framework. Its API is:

- `GET /config-ready`: file validity only, `{ready:true}` or safe error.
- `POST /transcribe`: JSON `{audio: "<base64>", mime: "audio/wav", context?: string}`.
  No browser-provided key, endpoint, URL, path, task or model option is accepted.
  Returns `{text}` or `{error:{code,message}}`. All responses are `no-store`.

`src/server/config.ts` reads the bounded regular file afresh using `O_NOFOLLOW`,
checks inode/device identity after open, and never attaches raw parse/I/O errors.
The adapter constructs fresh multipart `audio` and `definition` with
`enhancedMode: {enabled:true, task:"transcribe", prompt:[...]}`, uses the fixed
2025-10-15 API path and subscription-key header, rejects redirects, combines
request/module cancellation with a provider timeout, bounds response reading,
and discards raw provider error bodies. No server transcript/audio persistence.

`src/web/speech.ts` is the registered, activation-scoped state service. React
`composerInput` middleware binds the captured draft, composes the public textarea
ref (including React 19 cleanup), preserves controlled value/onChange and native
events, and returns the real Base followed by the microphone. A separate existing
`composer` wrapper preserves its full Base/children and renders status/error/
recovery content after the entire input row. There is no new slot, nested control,
private DOM lookup, CSS reordering or copied editor/submit implementation.
Insertion focus/selection receipts carry the exact draft lifetime and revision;
replacement inputs and newer manual edits cannot consume them.
The public `chatWindow` projection supplies optional context;
it never supplies write authority. The service owns cancellation, draft leases
and insertion checks. No module schema or menu is registered.

## Synthetic tests

`pnpm test` uses Node's built-in runner and strips TypeScript types. Tests do not
contact Azure, start real microphone devices, read production configuration or
reuse another project's dependencies.

- WAV encoding/header/data/size validation and actual worklet downmix/flush/limit.
- Audio environment lifecycle, late permission grants, stream/context/port
  cleanup, gesture preparation without capture, unsupported rates and processor failures.
- Missing configuration and cancelled readiness never acquire the microphone;
  an explicit retry rereads configuration without reactivation.
- Both sample-count and wall-clock limits preserve/finalize audio and trigger
  transcription once, including a racing manual stop and the final partial buffer.
- Ready vs stale/unavailable/partial context; roots, provenance, subtypes,
  incompletion, session boundaries and trailing 1,000-code-point clipping.
  Frontend selection and backend validation share the same limit; 1,000 ASCII
  or supplementary characters pass intact, while 1,001 are rejected.
- Prompt/ask/plan draft capture, exact selection and context timing; manual edit
  conflict, same-lifetime explicit recovery, reused request IDs, pending/
  unconfirmed/peer blocks, double stop, late HTTP completion, cancellation and
  revocation.
- Ref composition including React 19 callback cleanup and capability gating.
- Real paired host mounts through the optional host regression command below.
- File readiness/reload, strict endpoints/config fields, non-symlinks and safe
  failures; bounded request/response parsing and safe auth/provider errors.
- Multipart contents/order, timeout/cancellation/no retry, backend concurrency
  and module disposal.
- Generic package closure, source/SDK provenance and reproducibility checks.

Automated browser-environment tests are synthetic; real browser hardware,
regional Azure availability and recognition quality are **not** claimed as
verified by them. Before release, exercise HTTPS microphone permission
grant/deny, cancellation while a permission dialog is open, stop/retry, 120s
limit, Safari/Firefox/Chromium worklet operation, disconnected navigation,
ask/plan replacement, manual edits and clipboard-denied recovery on target
devices. A real-provider smoke test is optional and must be explicitly
authorized with test audio and a separately configured resource.

CI runs SDK preparation, frozen dependency installation, typecheck, synthetic
tests, clean-source build/package and exact archive verification. It has only
read permissions and no deployment or credential-backed integration step.

## Paired host regression

The exact public API pin is `d752dd6a016f8ff84235c4cd8850e2b63778bf1b`,
SDK version 0.2.5, recorded in `tooling/host-sdk.json`. Prepare it with
`node scripts/sdk.mjs prepare /absolute/clean-pinned-cockpit`, then install with
the frozen lockfile and build this module. From that host source, run its existing
React component harness with the actual compiled consumer:

```sh
COCKPIT_TEST_SPEECH_ENTRY=/absolute/cockpit-speech/dist/web/index.js \
  pnpm --filter @cockpit/web exec tsx --tsconfig tsconfig.app.json --test \
  src/components/Thread.lifecycle.test.ts
```

This uses synthetic audio/permission/HTTP providers, never Azure or hardware. It
mounts the production Composer and this module's actual middleware, checks natural
DOM and feedback placement, native send leases, React 19 ref cleanup, manual-edit
recovery and caret/focus return. The host's maintained Chat Lab remains the browser
surface; do not create a parallel demo app. The host API PR must merge before the
paired consumer PR. A pinned feature commit is reproducible but is not a release.
