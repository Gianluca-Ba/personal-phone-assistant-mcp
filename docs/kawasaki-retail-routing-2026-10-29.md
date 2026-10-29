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
