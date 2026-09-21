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
host-contract requirement; this migration retains the exact supporting host
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` and `uiSurfaceVersion: 1`.

Commit the final source, rebuild, package and verify the exact artifact with the
existing scripts/CI. Never delete installed module directories or force a bypass
to reuse a version. PR merge is not authorization to tag, publish a Release,
install, deploy or restart; those boundaries need separate authorization.
