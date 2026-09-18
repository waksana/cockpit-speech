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

Context goes to Azure during credential issuance; audio streams directly from
the browser during recording. Cancel cannot retract transmitted data or charges.
The credential is not an application-enforced one-use or 120-second billing
quota. Protect the host's authenticated module request boundary; credential
issuance concurrency is not a global limit on active Azure sessions.

Audio/context go to the user's configured Azure OpenAI resource. This module
cannot establish the resource's retention policy, access controls, region
availability or suitability for sensitive recordings. Public deployment still
depends on the host's authenticated, digest-bound module request boundary.

Draft insertion is not permission to submit. The module never invokes native
session/ask/plan APIs, schedules, host audio proxies or process
control. Context text is untrusted reference vocabulary, never executable
instructions to this module.
