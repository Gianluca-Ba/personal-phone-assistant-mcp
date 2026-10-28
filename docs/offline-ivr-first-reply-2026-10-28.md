# Offline IVR and first-reply verification

This continuation makes no telephone calls, performs no live speech-recognition
requests and changes no deployed Worker or Telnyx configuration. The comparison
baseline is commit `535473c`. Recordings and captured recognition frames stay in
ignored private files; tests use mocks for all telephone/provider operations.

## Reproduced IVR failures

The stored traces contain both `ご希望の番号を選択してくだい` and
`ご希望の番号を選択してください`. These are now equivalent when comparing
that fixed selection invitation against an already-observed replay and for
duplicate-selection detection. No option
label or digit is rewritten, the original token expires at the same time, and
unknown/changed/quoted introductions still cannot authorize the old selection.

Previously, when a counted replay prefix was recognized and its next fragment
did not match, the old token was correctly revoked but the newly-heard count
could be lost. One re-heard option could then appear complete. The fresh assembly
now retains only that replay's observed prefix and count, never the unheard
options of the old complete menu. It needs all advertised choices again. An
explicit new count, a real recipient interruption, expiry or consuming a
selection still resets the applicable state.

`npm run test:voice-timings` tests 1,440 combinations of read/selection delays,
joined/split/cumulative replay introductions and the two observed invitation
spellings. Choice fragments are based on the recorded menu structure; the timing
grid and interim events are constructed variations, not 1,440 captured calls.
Against the original controller, 372 cases fail; with the patch all 1,440 pass.
Successful cases assert one simulated digit 5 and no duplicate delivery.

## Reproduced first-reply loss

The previous renderer permanently discarded a completed safe response whenever
its completion coincided with acoustic activity or a recipient turn. A validated
response now waits for actual quiet for at most two seconds from its original
completion. It retains the existing media-activity debounce and semantic speech
guard; it does not reuse the separate DTMF/hangup acoustic delay. It is emitted
once, after final transcript validation, or discarded without emission.

A meaningful question/correction, hold, terminal condition, newer response,
disconnect/cleanup or the unchanged two-second deadline invalidates the buffer.
Audibility checks cannot renew that deadline. Late audio/transcript frames cannot
change the completed response. Scope, immutable task, nonce/digest/expiry, action
tokens, quota, consent and duplicate-execution controls are unchanged. The
first-reply grace also applies to a direct pickup without an earlier IVR, using
recipient evidence rather than a model assertion.

The saved Kawasaki incoming PCM and recognition-frame sequence are replayed
locally through the production media-activity, turn assembly, bridge and
controller. The reply is a nonzero synthetic 0.2-second acknowledgement; five
generation delays (0, 1,500, 4,000, 6,500 and 8,000 ms) and mock playback marks
exercise buffer timing. Baseline success is 2/5; patched success is 5/5, with ten
20 ms frames emitted exactly once after completion. This is a saved-input
transport test, not a new call, model-generation benchmark or recipient-side
audibility measurement.

The network-disabled seeded campaign adds short acoustic tails, expiry and
cancellation scenarios to the earlier startup, hold, interruption and IVR cases.
Independent regression tests require unsafe/missing transcripts, meaningful
interruptions, expired waits and stale responses to produce no media frames.

Local verification passed: 268 regression tests, all 1,440 timing-sweep cases,
1,000 seeded voice scenarios, the five saved-input handoff variants, type checking,
builds, existing phone-contract checks and the workerd edge checks. The CI runs
both public offline campaigns on every change. Fixed-speech cancellation races
are included: a pending stop prevents release and cannot renew the quiet deadline.

## Release boundary

These tests reproduce and correct specific control/transport failures. They do
not prove general ASR accuracy, verified human identity, stock availability or
universal PSTN reliability. The previous live stale-token failure cannot be
attributed exclusively to the invitation variation without the exact original
recognizer-frame sequence. This patch is kept separate from production deployment
and authorizes no additional real call.
