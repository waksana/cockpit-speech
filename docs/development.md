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
middleware only binds the captured draft, composes the public editor ref,
preserves inherited actions/children/props, and renders microphone/status/error/
recovery controls. The public `chatWindow` projection supplies optional context;
it never supplies write authority. The service owns cancellation, draft leases
and insertion checks. No module schema or menu is registered.

## Synthetic tests

`pnpm test` uses Node's built-in runner and strips TypeScript types. Tests do not
contact Azure, start real microphone devices, read production configuration or
reuse another project's dependencies.

- WAV encoding/header/data/size validation and actual worklet downmix/flush/limit.
- Audio environment lifecycle, late permission grants, stream/context/port
  cleanup, unsupported rates, processor and duration-limit failures.
- Ready vs stale/unavailable/partial context; roots, provenance, subtypes,
  incompletion, session boundaries and code-point clipping.
- Prompt/ask/plan draft capture, exact selection and context timing; manual edit
  conflict, same-lifetime explicit recovery, reused request IDs, pending/
  unconfirmed/peer blocks, double stop, late HTTP completion, cancellation and
  revocation.
- Ref composition including React 19 callback cleanup and capability gating.
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
