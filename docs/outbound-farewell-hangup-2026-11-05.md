# Outbound hangup after the system farewell

The 5 November Yodobashi pilot reached the telephone department and obtained
stock information, but the recipient ended the line. The authenticated
`call.speak.ended` event confirmed that the system farewell completed. A later
recipient courtesy (`はい、恐れ入ります。失礼いします。` in the stored ASR) then
cancelled closing and cleared the current farewell flag. There was no outbound
hangup command. Recordings and raw call data remain outside Git.

## Correction

Inside an already requested system farewell, a narrowly matched whole closing
courtesy suspends the pending hangup while the recipient speaks, then restores
the same pending operation. It neither reopens dialogue nor requests another
farewell. The classifier does not change normal aizuchi handling and conveys no
authorization. Unknown words, added task details, questions, corrections and
requests to wait use the existing interruption path. A harmless interim cannot
authorize hangup: the final turn and acoustic quiet are still required.

The normal hangup requires the matching authenticated system playback-completed
callback, the existing 250 ms playback margin, no outstanding carrier audio and
at least 750 ms after a recognized recipient turn ends. Raw acoustic activity
also blocks hangup even if recognition finalized early. Silence after the
farewell needs no recipient acknowledgement.

The final quiet/state check runs again after the asynchronous command
reservation, immediately before the carrier request. New recipient speech can
still suspend or cancel closing during that reservation. A definitely unsent
command can be reconsidered once safe; uncertain network outcomes keep their
one-shot reservation and are never automatically retried. Concurrent ticks and
duplicate callbacks cannot create additional hangups or renew the original
playback-completion boundary. The existing narrow exception for an expired
routing-only hold remains constrained to a stable wait announcement, not human
speech.

## Verification

Regression tests reproduce the actual final-courtesy failure across confirmed,
refused, wrong-number and unable-to-proceed outcomes. Other cases cover long
recipient turns with completion arriving mid-turn, Nova/Flux endpoint ordering,
missing or mismatched callbacks, early recognition finals with ongoing acoustic
speech, real interruptions, an innocent interim followed by a substantive final,
storage/dispatch races, concurrent and repeated callbacks, suppressed model
narration, silence and uncertain carrier outcomes.

All telephone actions in these tests are local mocks. No new real calls or
recording uploads are used. Production deployment is restricted to the outbound
Voice Worker, preserving its bindings and secrets and the deployed versions of
the phone, MCP and Auth Workers. The inbound implementation and Telnyx assistant
settings are unchanged. Passing offline checks does not independently prove
receiver-side playback or PSTN timing.

All 400 unit tests passed, including 22 new farewell/hangup cases. Type checking,
Worker builds, both phone-contract modes and all 11 native workerd checks passed.
The existing offline campaigns also passed: 1,000 voice scenarios, 1,440 IVR
timing cases, 420 pickup cases and 1,321 handoff/closure cases. These counts
describe constructed scenarios with mocked telephone transports, not real calls.

## Shinjuku live pilot and truncated waiting request

The subsequent single owner-approved Shinjuku pilot ran from 14:16:58 to
14:19:25 JST. The system farewell completed at 14:19:25.001; the hangup request
was recorded at 14:19:25.768, followed by caller-side normal termination at
14:19:25.999. Thus automatic hangup after completed playback worked, but the
overall pilot did not resolve the stock request.

Before closing, recipient ASR contained `ちょっと確認します、お待ちくださ`.
The missing last character prevented recognition of a requested hold, allowing
the model's premature closure tool to pass. Recognition also produced the
variant `少々お待ちくいませ`. The follow-up correction handles these narrow
waiting-request tails conservatively as the existing bounded requested hold.
Repeats cannot renew its deadline; a genuine recipient return releases it.
Questions, quotations, negations and unrelated wording are not added as holds.

Three replay regressions failed before the correction and passed after it,
including rejection of premature closure and continued dialogue after return.
A fourth test covers negative/quoted cases. All 404 unit tests, type checking,
builds and the existing offline campaigns passed. This follow-up uses only local
mocks and is not a second real-call validation.

The stored automatic summary incorrectly claims confirmed availability. The
recipient transcript contains no reliable confirmation of stock, capacity,
colour, walk-in conditions or restock timing. The fragment `最高` is not an
inventory confirmation, and assistant questions or generic recorded store
announcements are not recipient commitments. This summary defect remains
separate from the Voice Worker fix; historical summaries and notification emails
were not edited or resent. The pilot result must be reported as unverified stock
and premature closure, rather than a successful availability inquiry.
