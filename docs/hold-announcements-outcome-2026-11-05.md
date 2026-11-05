# Outbound hold announcements and unverified model outcomes

## Reproduced failures

The Shinjuku replay entered a requested hold correctly. The subsequent store
announcement about web stock lookup or collection services then released the
hold because any nonempty, non-filler recipient transcript could do so. The
model's closing tool was subsequently accepted with `confirmed`, without an
answer to the product question. A separate summary issue allowed a quotation
from an announcement to ground an unrelated positive stock claim.

## Hold policy

Requested and routing holds retain their original, bounded deadlines through
commercial announcements, bare recorded welcomes, music, aizuchi and unknown
fragments. Repetition never renews the lease. These turns are not forwarded as
new model user messages or used to promote a routing transition into dialogue.
Unknown speech remains guarded by the original hold rather than becoming an
answer merely because it is nonempty.

A clear interactive return, staff handoff, actual question, substantive answer
or current IVR menu can resume the appropriate flow. A mixed STT turn containing
an old announcement followed by a return forwards only the return suffix.
Actual acoustic activity, incomplete turns, playback completion and hangup
idempotency retain their existing guards. Expired holds still use the controlled
farewell and matching completed callback before termination.

These are conservative text heuristics. They do not authenticate a human
speaker or distinguish every conceivable recording from live speech. Ambiguous
returns can remain on hold until its limit, rather than produce an invented
success or an unbounded wait.

## Outcome and summary policy

In the production Voice adapter, `confirmed` supplied by the model is recorded
separately as `voice_model_requested_outcome`. Its effective technical closure
outcome is `unspecified`; the Worker does not independently attest task success.
The tool response exposes the requested and effective outcomes separately. A
denied close while held cannot change this into a confirmed result.

Validated summaries can still report genuine positive or negative recipient
answers. For outbound extraction, both outcome evidence and confirmed facts
must cite substantive recipient text. Greetings, instructions to wait, web-shop
announcements, isolated fragments such as `最高`, model questions and quoted
substrings laundered from advertisements cannot establish success. A mixed
return exposes only its substantive suffix as eligible evidence. Positive stock,
walk-in and booking claims have additional conservative checks. An invalid
positive result is replaced as a whole: title, body, facts and next action.
This is evidence consistency checking, not a general semantic or cryptographic
proof of every statement or of a recipient's identity.

The initial outbound v2 summary stored by the phone Worker is now a neutral
`Esito in verifica` placeholder. It prevents MCP exposing the provider's raw
summary during the interval before validation. Existing direction resolution,
`INSERT OR IGNORE`, notification leases, delivery keys and compare-and-swap
summary persistence are unchanged. Inbound storage uses its original value.
Historical provider metadata, already sent notifications and historical database
rows are not rewritten or resent by this repair.

## Verification and release

All tests use local transports and synthetic inference. They replay the observed
advertisements and fragments through both Nova and Flux events, duplicate turns,
requested and routing holds, explicit returns, genuine answers, mixed turns,
timeouts and rejected premature closing. Summary regressions cover misleading
citations, negative-to-positive inversion and a stock answer incorrectly used
to confirm walk-in conditions. Genuine answers and bookings remain supported.

The phone entry patch is reversible and changes only the initial outbound v2
summary operand. Removing that operand patch yields the exact original entry
source. Its inbound module, bindings, secrets, schedules, voice dial paths and
Telnyx assistant settings are preserved. Deployment is restricted to the Voice
Worker and the phone Worker containing the outbound notification bundle; MCP
and Auth do not need deployment. Private before/after snapshots retain rollback
versions and source proofs.

The final checks include 433 unit tests, type checks, all Worker builds, the real
private phone entry under an offline workerd contract, 11 edge-runtime checks,
1,000 voice scenarios, 1,440 IVR timing cases, 420 pickup cases and 1,321 handoff
and closure cases. The handoff matrix now correctly expects an ambiguous bare
welcome to remain held until a stronger interactive return. No new real calls,
recording uploads, synthetic notification emails or manual database updates are
part of verification.
