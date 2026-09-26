# Contributing to Cockpit Speech

Use an isolated branch/worktree and synthetic fixtures. Follow the README's
[worktree setup](README.md#worktree-setup),
Node/pnpm, authenticated frozen-lockfile registry install and existing
typecheck/test/build commands. Clean builds do not require host source.
Plain documentation changes need no dependency install or product build.
Do not use real recordings, credentials or production sessions for validation.

## Immutable installation versions

Do not bump a version for every commit. Before packaging changed content for
installation or deployment, compare with versions already delivered: changed
package bytes require a fresh semantic version (normally the next patch for a
compatible fix). The same module ID and version may only reproduce the same
bytes/digest. Source SHAs and digests record provenance, not replacement versions.

Synchronize `package.json`, `cockpit.module.json`, any embedded versions and
applicable lockfile metadata, current-source compatibility and release notes.
Keep historical release statements intact. Pin the independently released SDK
exactly with its registry integrity; never use a generated host export as a
fallback. The supported host source in `tooling/host-compatibility.json` is only
for integration pairing, not a build input or an SDK semver comparison.
Activation requires `uiVersion: 1` and `uiSurfaceVersion: 1`.

Commit the final source, rebuild, package and verify the exact artifact with the
existing scripts/CI. Never delete installed module directories or force a bypass
to reuse a version. PR merge is not authorization to tag, publish a Release,
install, deploy or restart; those boundaries need separate authorization.

After a joint deployment with the host, tag and release the accepted commit per Cockpit's [release after a joint deployment](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance) policy.
