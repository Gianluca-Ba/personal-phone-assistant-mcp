# Kawasaki retail IVR routing

The inspected call selected business-customer digit 3 even though its successful
menu read included other-questions digit 5. The provider reported a successful
DTMF operation and a subsequent transfer announcement. No recipient dialogue
candidate was observed and no model audio was released. Remote hangup ended the
call. This does not independently establish whether the final recognition
fragments missed a human voice.

## Guarded route

The outbound adapter derives a narrow route restriction from the immutable
approved request, bound to Apple Kawasaki's existing destination. An explicit
plain-language instruction enables it:

`Menu IVR autorizzato: Apple Kawasaki, solo tasto 5 per altre domande.`

Ordinary canonical `Goal:` lines also enable the restriction when they explicitly
combine iPhone, walk-in/no reservation and availability/purchase wording. Business,
repair and technical-support goals are excluded from that automatic classification.
This is a conservative text heuristic, not independent semantic or human-consent
verification. Unknown tasks/destinations retain generic menu controls. Malformed,
conflicting or destination-mismatched explicit directives fail before dialing.
Recipient speech, tool arguments and model metadata cannot set the policy.

A complete fresh menu must associate 5 unambiguously with other questions.
Japanese label-before-digit parsing supports optional punctuation, full-width and
Japanese digits. The model receives `authorized_digits` and `required_next_digit`.
The server rejects 1/2/3 without dispatch or spending the token, allowing a fresh
correct selection. Missing, reassigned or duplicated 5 is refused. There is at
most one reserved selection for this profile, including uncertain dispatch: no
blind retry and no unapproved submenu substitution. Current quiet/hold/terminal,
exact token, expiry, sensitive-menu and atomic duplicate guards still apply.

The per-session instructions explicitly select other questions 5, wait silently
through transfer, and do not treat provider long-silence events during a routing
hold as a reason to close. The initial acknowledgement and complete-utterance
validation remain in place. No call, booking, payment or disclosure permission is
added by this route. New calls retain the create/present/new-owner-approval flow.

## Verification

25 new tests cover the recorded menu, normalized variants, wrong routes,
conflicting labels, immutable task/destination binding, invalid/expired tokens,
repeated/concurrent requests and ordinary canonical consumer goals. The complete
suite contains 362 tests. Existing IVR and voice campaigns remain required by CI.

A real Telnyx AI WebSocket conversation, with synthetic text recipient turns and
all phone/TTS actions mocked locally, selected 5. Two tool attempts produced only
one simulated DTMF dispatch. After a simulated transfer and recipient greeting,
the fixed acknowledgement completed and the validated task question
`iPhone Duoの在庫について伺えますか。` released 138,240 PCM bytes. No real phone call,
recording export, carrier-setting change or booking occurred in this verification.
This tests model/controller integration, not actual PSTN delivery or ASR quality.

Only the Voice Worker needs deployment. Phone/inbound, MCP, Auth, Google, Telnyx
assistant settings, secrets, bindings and D1 remain unchanged. Private before/after
snapshots retain the previous deployment for rollback. A real call is a separate
owner-approved verification, never represented as already passed by virtual tests.

## Live pilot and product-detail follow-up

One newly created request was presented in full and received a new explicit owner
approval before execution. The real pilot sent other-questions digit 5 once,
entered dialogue, completed the fixed acknowledgement, and released four checked
model responses (802,560 PCM bytes). The dual-channel recording has 17.48 seconds
of active outgoing audio at the local RMS threshold, rather than the earlier
silent outgoing channel. Signed events confirm the complete controlled farewell;
carrier hangup followed its completion by approximately 0.977 seconds. The call
lasted 121 seconds. No additional real call was initiated.

The business outcome remains unresolved: storage/colour appeared in an interrupted
generation and cannot be represented as reliably spoken; the availability answer
was fragmented. There was no verified exact-variant stock confirmation or booking.
The subsequent response to a restock question indicates an inability to check or
communicate that information, but is not a reliable inventory statement about the
requested variant. Neither model text nor these partial recognition fragments
are treated as a confirmed commercial result.

The outbound route policy now requires the complete authorized product tuple in
a single stock question, explicitly repeating the model alongside capacity,
colour and SIM qualification. It does not invent missing product fields. Generated
or cancelled text is not assumed heard. Fragmentary yes/no answers require a
short clarification before inferring stock or asking about restock. Internal
routing/delivery headings are also rejected by the speech guard.

A subsequent real-AI virtual test (all telephone/TTS effects mocked, no recordings
uploaded) released the complete product question and, after a synthetic truncated
answer, asked `今のご回答は「在庫がない」ということでよろしいでしょうか。`.
It sent one simulated digit 5. An earlier virtual attempt that omitted the model
name from the product-details question failed the strict check; the final private
delivery check corrected that behavior. This follow-up prompt change is verified
virtually, not claimed to have received another PSTN test.
