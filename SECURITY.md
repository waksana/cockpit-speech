# Security

Do not include real keys, recordings, private transcripts, configuration files or
provider response bodies in issue reports. Use synthetic inputs and redact
resource-identifying information. Report suspected security issues privately to
the repository maintainer rather than posting credentials or exploit details.

This module reads only its configured `dataRoot/azure-openai.json` for provider
configuration. Keep the data directory private and the config mode `0600`.
No configuration editor, resource-key readback, environment fallback or legacy
config fallback is supported. The trusted resource origin is HTTPS with a strict
Azure OpenAI hostname allowlist; redirects are rejected. A short-lived Azure
credential is deliberately returned to the browser and kept in memory, not
logged or persisted. It is sensitive and must not be included in reports.

Credential requests contain no context or audio. Each browser WebSocket sets the
recording's prompt directly on Azure before sending buffered/live audio. The
short-lived bearer appears in the WebSocket URL's Authorization query parameter;
redact the entire query in browser/network diagnostics. Never log a socket URL.
Cancel cannot retract transmitted data or charges; replay after an uncertain
commit can cause duplicate billing. Credentials are cached for at most one minute
and refreshed for explicit retry, so file configuration changes can briefly lag.
Already-open connections do not automatically pick up file changes.
The credential is not an application-enforced one-use or 120-second billing
quota. Protect the host's authenticated module request boundary; credential
issuance concurrency is not a global limit on active Azure sessions.

Audio/context go to the user's configured Azure OpenAI resource. This module
cannot establish the resource's retention policy, access controls, region
availability or suitability for sensitive recordings. Public deployment still
depends on the host's authenticated, digest-bound module request boundary.

Draft insertion alone is not permission to submit. The module explicitly
declares `sends: ['draft']` and obtains the host's captured, one-shot submission
capability only on normal active hold release. It submits through the original
draft's native prompt/ask/plan semantics, never a current-input DOM click or an
arbitrary session/payload API. Button entry and pre-release interruption remain
draft-only. Changed text/attachment content and stale/retired drafts block
automatic submission; unknown acknowledgements never trigger automatic replay.
The module does not invoke schedules, host audio proxies or process control.
Context text is untrusted reference vocabulary, never executable instructions.

Each draft can retain at most 120 seconds of PCM audio in browser memory (5.76 MB
raw, plus temporary encoding overhead). There is one active microphone, but no
limit on independently retained draft tasks or concurrent connections; unresolved
tasks can grow memory use. Failure preserves audio for explicit replay into a new
connection, never a new draft. Navigation, visibility loss and host disconnect
end capture without clearing the recording. Reliable host-guarded insertion
(or confirmed native submission for released holds),
explicit discard, authoritative permanent draft retirement, a confirmed
`AUDIO_TOO_SHORT` failure, or module/page teardown clears it. Conflict recovery
retains audio as well as recognized text.
Background execution can pause or fail when the browser freezes a page.
There is no IndexedDB/localStorage, file upload, recording log or audio disk cache.
Physical microphone permission and a cached Azure credential do not bypass the
host's free-text gates or the module's exact-draft ownership checks.
