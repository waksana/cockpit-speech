# Cockpit Speech 0.1.1

Unreleased paired migration for [waksana/cockpit#51](https://github.com/waksana/cockpit/issues/51).
No tag, Release, installation or deployment is performed by this source change.

## Breaking host pairing

Requires Cockpit 0.2.5 source with `composerInputVersion: 1`, independently of
Web API v2, UI v1 and `chatWindowVersion: 1`. Removes the previous Composer actions
contract completely, without aliases or compatibility fallbacks.

The SDK is exported from reachable host commit
`d752dd6a016f8ff84235c4cd8850e2b63778bf1b`, module-api/protocol version 0.2.5.
`tooling/host-sdk.json`, generated SDK inventory, lockfile and package build receipt
bind the pairing. Merge the host API before this consumer; old Speech 0.1.0 and
hosts without the real input capability cannot be mixed with it.

## Input composition and lifecycle

Speech wraps the actual controlled textarea Base, preserving native events and
the public ref, and adds a microphone sibling before the independent native send.
File remains prompt-only and on the left; prompt/ask/plan microphones remain
visible, and native free-text restrictions still disable recording.

The existing composer boundary puts status/error/recovery after the entire row,
with bounded scrolling on short screens. There are no private DOM queries, visual
reordering, nested controls, duplicate editors or new host slots.

Successful insertion restores the original input's focus and caret only for its
exact draft lifetime and revision. Explicit cancellation returns focus without
redirecting late results. Draft leases, manual-edit conflicts, reused request IDs
and recovery remain bound to the captured lifetime.

Context remains the newest eligible completed root assistant reply captured at
record click. The excerpt now takes its **last 1,000 Unicode code points** after
trimming, instead of the first 200; shorter replies stay whole. Frontend selection
and backend validation use the same limit. This is module policy, not an Azure
maximum, and does not add history reads or change message eligibility.

Azure LLM Speech, file-only configuration, 120-second automatic stop/transcription
and no-auto-send behavior are unchanged. Audio still goes through the module
backend; this release does not change to browser-direct Azure access.
Synthetic checks do not establish real microphone/browser-device support, Azure
availability, credentials or recognition quality.
