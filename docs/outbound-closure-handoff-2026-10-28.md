# Outbound routing timeout and first-reply refinement

Baseline: `185ff20716f6a0bac8da0bc02964d795d50d1764`.
All verification in this intervention is offline. No telephone call, live ASR
request, new reservation or change to the inbound phone service is authorized by
these tests. The production voice Worker is outbound-only.

## Evidence and reproduction boundary

In the last Kawasaki call, the persisted routing deadline was 05:14:27.686 UTC;
the provider received the farewell command at 05:15:05.689982, 38.003982 seconds
later. The conversation's final recipient entry contained only the transfer
announcement. It was timestamped 05:11:30.394 but stored at 05:15:12.126582. This
suggests delayed turn completion; conversation storage time is not an STT
endpoint timestamp. No complete raw live recognizer stream or per-tick guard
trace was retained, so the exact contribution of each live delay cannot be
proved retroactively.

Replaying only the saved incoming PCM with a completed routing transcript did
not reproduce the long delay: the controller requested the farewell 20 ms after
the routing lease expired. Replaying the same PCM with a constructed open Nova
interim containing the transfer announcement and a synthetic endpoint 38 seconds
after the deadline reproduced a 38,760 ms controller delay on the baseline.
The patched controller requested the farewell 20 ms after the same deadline.
This isolates a concrete missing recovery path; it is not a reconstruction of
uncaptured recognition frames or a new PSTN latency measurement.

## Closing change

An expired **routing** hold may use a narrow adapter-only recovery signal when
its current, whole STT interim contains only a recognized transfer/wait phrase
or an explicit music/silence marker and has been unchanged for at least five
seconds. Repeated identical updates do not renew that stability interval. A
partial/unknown utterance, appended recipient speech, greeting or question
revokes the exception. The exception never applies to ordinary requested holds,
DTMF selection, model assertions or task authorization.

This prevents a still-open transfer-announcement turn or hold music from
indefinitely extending the routing lease. A real recipient turn retains its
speech guard. New non-wait interim speech during queued farewell persistence or
playback cancels that farewell, including when it shares the old STT turn. A
matching authenticated completed playback callback is still required before
hangup; elapsed time, an unrelated callback or assistant text cannot certify it.
Audio queues, the final playback margin and idempotency remain mandatory.

Optional conversation metadata updates now run after hangup dispatch instead of
blocking it. Closure diagnostics record the hold deadline, timeout observation,
farewell request/acceptance/completion and hangup request/acceptance without raw
speech, credentials, phone numbers or request tokens. These timestamps separate
controller waiting from carrier API/playback latency in subsequent authorized
calls. The acceptance timestamp measures the API response, not the physical
start of recipient-side audio.

## First-reply change

The expanded matrix exposed another baseline failure: a short `はい`, `ええ`
or `そうですね` while the **first, still-unplayed** reply was being generated
could cancel it as a new turn. Within the existing nonrenewable ten-second
initial-reply grace, such a pure listening cue now preserves the response when
no already-spoken assistant question awaits an answer. The fixed two-second
quiet-buffer deadline remains unchanged. Questions, corrections, new holds,
unsafe/missing transcripts, superseding responses, expiry and disconnect still
prevent stale audio release. A `はい` answering an already-played question is
forwarded as an answer, never swallowed as a listening cue.

## Reproducible offline checks

- `npm run test:voice-handoff`: 1,225 first-reply combinations: five Japanese
  greetings, five constructed generation delays (0–8,000 ms), seven acoustic
  tails (0–2,500 ms), and seven listening/interruption/safety variants. In all
  375 expected positive cases, exactly ten nonzero media frames containing the
  simulated 0.2-second acknowledgement are emitted once after final validation.
  Other cases intentionally block output. Completion-to-release waiting is
  0–1,999 ms; at 2,000 ms the buffer expires without emission.
- The same command includes 96 routing-closure cases across Nova/Flux event
  shapes, wait/music/real/unknown speech, four timer jitters and three simulated
  farewell durations. Eligible farewell requests follow the hold deadline by
  0–49 ms of simulated timer jitter. Hangup is requested only after the matching
  completed callback plus the existing 250 ms margin, exactly once.
- Focused regressions cover late/foreign callbacks, concurrent farewell
  persistence and a real greeting, slow metadata writes, unclassified speech,
  answering a spoken question, and nonrenewable first-response grace.
- Existing unit/integration regressions, the 1,440-case IVR timing sweep and the
  1,000-case seeded network-disabled voice campaign remain part of verification.

The matrix uses synthetic reply audio and mock carrier callbacks. It does not
measure model inference, recognize newly generated speech, prove human identity,
or establish recipient-side audibility. A known wait phrase misrecognized in
place of real speech remains an ASR limitation. Unknown active speech is
conservatively allowed to delay closing; this is deliberately not a universal
hard cutoff that truncates an unrecognized operator's sentence. The provider's
existing maximum call duration remains unchanged. No live call is scheduled.

## Results

| Constructed matrix | Baseline passes | Patched passes |
| ------------------ | --------------: | -------------: |
| First reply        |   1,100 / 1,225 |  1,225 / 1,225 |
| Routing closure    |         48 / 96 |        96 / 96 |
| Combined           |   1,148 / 1,321 |  1,321 / 1,321 |

The saved Kawasaki audio/recognizer handoff replay also passes all five existing
synthetic generation delays, with exactly one response emitted per variant.
Full verification: 287 unit/integration tests, 1,321 added matrix cases,
1,440 IVR timing cases, 1,000 seeded voice cases, five saved-input variants,
type checking, all Worker dry-run builds, 24 legacy plus 29 guarded phone-contract
checks, and 11 local workerd edge checks. All pass with zero real calls.

Deployment scope is restricted to `personal-phone-assistant-voice`. Preserve the
currently deployed binding/secret/runtime configuration and snapshot the old
voice version for rollback. Do not deploy the phone, MCP, Auth or notification
Workers, modify the shared Telnyx assistant, or schedule a live verification call.
