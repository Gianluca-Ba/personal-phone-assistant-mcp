# Direct pickup and unsupported booking confirmations

The two inspected restaurant calls ended on the callee side, without controller
hangup commands. Both dual-channel recordings had no assistant voice, and the
final controller audit reported zero released model audio. The booking sentences
in the transcript were generated text, not evidence of delivery or acceptance.
The retained events cannot establish the precise reason each partial generation
failed to finish. No timeout adjustment is represented as a proven historical
root cause.

## Changes

`OUTBOUND_INITIAL_ACK=true` enables one fixed Japanese acknowledgement after an
eligible recipient turn, an answered call, a bound stream and acoustic quiet.
Its idempotent Call Control `speak` action is independent of model generation.
It contains no owner name, task details or claim of completion. Pure recorded
welcomes, menus, routing, holds and terminal announcements remain silent. Short
named direct-pickup greetings now cover the observed restaurant recognition
variants. A candidate remains a language heuristic, not proof of human identity.

Model task audio remains buffered until the entire response has completed and
passed the speech policy. It cannot overlap the initial acknowledgement and
requires its authenticated, matching `call.speak.ended` completed callback.
A real correction/hold cancels it; missing completion is bounded to ten seconds
and never retried. Acoustic guards, immutable authorized task, consent, single-use
IVR operations, quotas and duplicate-prevention remain required. The per-session
prompt asks one short task question first, with details in subsequent turns. A
booking starts with `予約をお願いできますか。`, rather than a long date/name story.
Relative statements such as "yesterday" must be grounded in authorized timestamps.
No existing request snapshot is edited.

Startup responses suppressed by the dialogue gate are cancelled immediately.
Final audits include unfinished as well as finished generations, the last four
response timelines, byte counts and bounded reason labels, without transcripts,
authorization secrets or callback tokens. Sending bytes or receiving a TTS
completion does not prove the recipient understood them.

The notification provider reads final voice audit metadata only for the matching
outbound conversation/request. Final zero model-audio output forces an unresolved
result and a truthful title/body, independently of model extraction. A fixed
system acknowledgement is not treated as transmission of the task. Missing,
intermediate, malformed or mismatched metadata is uncertainty, never silence or
successful delivery. Aggregate nonzero audio cannot verify individual turns.

When outcome evidence is absent, assistant-only or a greeting, the validator
replaces the whole result, including its title, body, facts and next action.
Booking-confirmation titles additionally require an explicit acceptance phrase
in recipient evidence. This conservative language check can reject valid unusual
phrasing; it is not an independent semantic proof of every booking detail.
Assistant turns are labelled generated, with transmission unverified or absent.
For pending outbound notifications, the validated title/body replaces the raw
provider summary with a compare-and-swap on the claimed row and matching request.
MCP therefore reads the same validated result; sent history and inbound notes are
not rewritten. A concurrent edit prevents stale delivery.
Legacy summaries cannot revive a confirmation when the original transcript is
missing. Historical emails are not resent, and no email is claimed to be recalled.

## Verification and limits

337 unit/integration cases passed, including the final persistence and prompt regressions.
`npm run test:voice-pickup` adds 420 deterministic, network-disabled cases over
three pickup forms, five generation delays, four acoustic tails and seven
interruption/completion modes. The synthetic acknowledgement request occurs
400 ms after the supplied final greeting; this is not measured PSTN/TTS latency.

Two text-injected Telnyx WebSocket sessions with synthetic restaurant greetings
returned the short booking question alone, completing in 3,716 and 3,056 ms;
first generated audio arrived in 1,653 and 1,127 ms. No recordings were uploaded,
phone APIs invoked, bookings made, or real calls initiated. An earlier virtual
attempt exposed duplicated acknowledgement wording and a provider
`session_update_after_start` initialization error. Contradictory acknowledgement
prompt rules were removed; both subsequent sessions completed. Two sessions do
not establish general provider reliability or eliminate that intermittent error.

The release changes only Voice and the phone Worker's imported notification
module. The phone entry, inbound intake module, inbound Telnyx assistant, bindings,
secrets, existing schedules, OAuth/MCP and carrier settings are preserved. No D1
schema or historical call data is changed. Private snapshots record original
versions/configuration and support Wrangler rollback of just those two Workers.
A real call still requires a fresh request and its specific owner approval.
