# Contributing to Cockpit Speech

Use an isolated branch/worktree and synthetic fixtures. Follow the README's
Node/pnpm, exact host SDK preparation and existing typecheck/test/build commands.
Do not use real recordings, credentials or production sessions for validation.

## Immutable installation versions

Do not bump a version for every commit. Before packaging changed content for
installation or deployment, compare with versions already delivered: changed
package bytes require a fresh semantic version (normally the next patch for a
compatible fix). The same module ID and version may only reproduce the same
bytes/digest. Source SHAs and digests record provenance, not replacement versions.

Synchronize `package.json`, `cockpit.module.json`, any embedded versions and
applicable lockfile metadata, current-source compatibility and release notes.
Keep historical release statements intact. The SDK pin changes only for a real
host-contract requirement. The parallel presentation requires the paired host's
`ModuleFrontendServices`, `ModuleNextFrontendContext` and public `ModuleUi`;
use the coordinated reachable clean source SHA, never a dirty local export.
Classic continues to require `uiVersion: 1` and `uiSurfaceVersion: 1`, while
next checks `context.ui.version` independently.

Commit the final source, rebuild, package and verify the exact artifact with the
existing scripts/CI. Never delete installed module directories or force a bypass
to reuse a version. PR merge is not authorization to tag, publish a Release,
install, deploy or restart; those boundaries need separate authorization.
