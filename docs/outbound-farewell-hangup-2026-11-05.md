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
