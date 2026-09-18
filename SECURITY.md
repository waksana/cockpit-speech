# Security

Do not include real keys, recordings, private transcripts, configuration files or
provider response bodies in issue reports. Use synthetic inputs and redact
resource-identifying information. Report suspected security issues privately to
the repository maintainer rather than posting credentials or exploit details.

This module reads only its configured `dataRoot/azure-speech.json` for provider
configuration. Keep the data directory private and the config mode `0600`.
No configuration editor, secret readback, environment fallback or browser key is
supported. The trusted resource origin is HTTPS with a strict Azure hostname
allowlist; redirects are rejected. Neither audio nor context is sent before the
explicit stop action.

Audio/context go to the user's configured Azure Speech resource. This module
cannot establish the resource's retention policy, access controls, region
availability or suitability for sensitive recordings. Public deployment still
depends on the host's authenticated, digest-bound module request boundary.

Draft insertion is not permission to submit. The module never invokes native
session/ask/plan APIs, schedules, proxies, websocket transports or process
control. Context text is untrusted reference vocabulary, never executable
instructions to this module.
