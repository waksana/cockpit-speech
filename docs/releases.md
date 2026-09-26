# Releases

Cockpit Speech Releases contain `cockpit-speech-X.Y.Z.tgz` and its matching
`.sha256`, not an npm package or a source archive.

<a id="automated-release-procedure"></a>
## Automated release procedure

1. Prepare the version and current `docs/release-notes.md` through a pull request.
2. Merge it and confirm Required checks passed for that exact `main` SHA.
3. Create and push an annotated immutable `vX.Y.Z` tag at that SHA.
4. The Release workflow runs the native checks on the tag SHA and downloads that
   run's original archive. The publish job never rebuilds or repackages it.
5. `scripts/check-release.mjs` verifies main ancestry, the remote tag target,
   version, release notes, source/manifest/checksum, SDK identity and the pinned
   host compatibility identity.
6. `scripts/publish-release.mjs` enumerates all authenticated Release pages and
   selects the unique exact `tag_name`. When absent, it stages both assets in a
   new draft. When a complete draft already exists, it verifies and reuses it
   without uploading, deleting or replacing assets.
7. It reads the draft by Release ID and all assets by paginated asset IDs,
   downloads both assets and requires byte-for-byte identity with the checked
   archive/checksum, then repeats the source/tag/package checks. After checking
   uniqueness, draft state and unchanged assets again, it publishes that ID as a
   non-prerelease Latest Release and verifies the published state and bytes.

Tags, Releases, versions and assets are immutable. The workflow refuses an
already published Release and never uses clobber. A Release does not install, deploy,
restart, migrate data or grant microphone/provider access.

<a id="atomic-release-publication"></a>
## Failure and unknown-result recovery

Only a formal, non-draft, non-prerelease Release with both verified assets is a
readiness signal. If creation, upload, publication or final readback fails or has
an unknown result, inspect the remote tag, draft/Release and assets first. Keep a
partial draft for diagnosis. Do not blindly retry a mutation, move the tag, delete
or replace a published Release, or publish changed bytes under the same version.

Use authenticated, paginated `gh api
"repos/waksana/cockpit-speech/releases?per_page=100" --paginate --slurp` to discover
drafts; the `releases/tags/{tag}` endpoint is not a draft discovery mechanism.
Filter all pages by exact `tag_name`, then inspect
`repos/waksana/cockpit-speech/releases/{release_id}` and its paginated `/assets`.
Asset downloads use `releases/assets/{asset_id}` with
`Accept: application/octet-stream`, not tag-based download commands.

An explicitly authorized rerun can recover **one complete matching draft**.
Branch-valued `target_commitish` on an older draft is not source proof: the
immutable remote tag target, archive build source SHA, version, SDK/host identity
and exact checked bytes must all pass instead. New drafts also record the exact
source SHA as their target.

No matches after a successful full enumeration permits creation. Lookup errors,
malformed responses, multiple exact-tag matches (including draft/published
conflicts), prereleases, incomplete/extra/duplicate assets, changed tags or bytes,
and an already published Release all stop without changing the existing Release.
After a failed or uncertain create/upload/publish, the script stops and never
retries a mutation. A failed readback is not proof that the write failed: inspect
the recorded ID and all exact-tag matches before deciding whether to rerun.
Incomplete drafts require diagnosis and a separate authorized resolution; this
workflow never repairs them by uploading replacement or missing assets.

Creation, each upload and publication use individual `gh api` requests. Do not
replace them with `gh release create` asset arguments: that command retries
uploads internally, including requests whose remote result may be unknown.
The release regression tests require GitHub CLI (`gh`, available on the CI
runner) and use only synthetic fixtures and a loopback HTTP server to assert
single-request behavior on HTTP failures and dropped connections.

After a joint deployment with the host, follow Cockpit's
[release-after-acceptance policy](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance).
