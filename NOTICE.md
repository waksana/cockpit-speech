# Licensing and provenance

Cockpit Speech is licensed under **GPL-3.0-only**. The complete license is in
`LICENSE`; distributed archives retain it.

The generic build-identity, deterministic packaging and archive
verification machinery in `scripts/` is adapted from the GPL-3.0-only
`cockpit-file` module. No file-module business logic or runtime dependency is
used. The build-only `@waksana/cockpit-module-sdk@0.2.0` dependency is published
from Cockpit under GPL-3.0-only. Its package identity and integrity are recorded
in the lockfile and build receipt; no SDK, React, Zod, native runtime or host
implementation is copied into Speech's archive.

Microphone and retry (`rotate-ccw`) SVG nodes in `src/web/icons.ts` are copied exactly from
**lucide-static 1.46.0**. Lucide's complete license, including its ISC permission
and Feather/MIT attribution, is retained in `licenses/lucide.txt` and copied from
the pinned installed package into `dist/licenses/lucide.txt` for distribution.
The UI uses Cockpit's public icon classes and theme variables, not another visual
framework.

Azure Speech is an external provider service, not a bundled dependency. Product
names and marks belong to their respective owners.
