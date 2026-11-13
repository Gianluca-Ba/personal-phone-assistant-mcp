# Premature appointment-change closure, 13 November 2026

## Evidence

The authorized call lasted 57 seconds (05:21:57–05:22:54 UTC). The request
was to replace an existing appointment, with a strict order of permitted
alternatives. No replacement or cancellation was verified.

The first request to change the existing appointment was released to the
carrier. The next question, asking about 14 November, was generated but never
released: `quiet_wait_cancelled_or_expired`, zero released PCM bytes. The
recipient's “16時ですね” therefore did not establish availability on 14 November.

The final assistant request, “その16時で予約を変更していただけますか”, was
released at 05:22:37.956 UTC. Its recording is consistent with 3.76 seconds of
generated PCM. The recipient then spoke at approximately 05:22:44.39–47.35 UTC,
but that turn is absent from the saved real-time conversation messages.

Local, offline speech recognition of the recipient channel, using three
different crops, consistently recovered a question about difficulty attending
the **existing appointment today at 16:00**. This is independent diagnostic
evidence, not proof that the real-time model heard the question. Audio was not
uploaded to another service. The model requested `confirmed` closure at
05:22:48.724 UTC; the backend correctly downgraded the report to `unspecified`,
but still ended the conversation before resolving the appointment change.

## Correction

The voice bridge keeps a separate record of the latest task question or request,
including whether audio was released, whether a carrier playback mark arrived,
whether playback was interrupted, and whether a new substantive recipient turn
followed playback. A model request to close as confirmed cannot use silence,
an earlier answer, a listening acknowledgement, an unplayed question, or a
recipient clarification question as the missing answer. Rejection returns
private transport feedback so the model can ask a short clarification.
Changing the requested outcome to `unable_to_proceed`, `refused`, or
`wrong_number` cannot bypass an unanswered request. An observed terminal
recipient response and the server's bounded cleanup remain valid exits.

Appointment-change dialogue now distinguishes the existing appointment from a
replacement, asks preferences in the authorized order, repeats the complete
replacement date and time, and requires explicit acceptance. These rules do not
change the owner's authorized dates or permit additional actions.

Carrier playback marks do not prove that the recipient understood the audio.
The guard also does not itself prove successful rescheduling or repair every
speech-recognition error. Actual outcomes still require recipient evidence.
In particular, a bare time repeated after playback can be a substantive turn
chronologically without proving acceptance of a replacement; the dialogue
policy must obtain the complete date and explicit acceptance.
Bounded silence and hold cleanup remain available for unresolved calls.

Private recordings, transcripts, test outputs, and deployment snapshots are
stored under the ignored `.wrangler/dentist-2026-11-13/` directory.

## Validation

- Final unit suite: 454 tests across 25 files passed, including unanswered
  imperatives, all model closure outcomes, stale response ordering, interrupted
  playback, recipient clarification questions, and bounded unresolved cleanup.
- Type checking and all worker dry builds passed; the final voice build uses a
  private configuration reconstructed from the current production settings.
- Eleven native workerd checks passed without external network or phone calls.
- Existing successful-closure test fixtures now include a played question and
  a subsequent recipient answer, rather than inventing a completed task from
  a greeting. Their outcome remains independently unverified.
- A cold full-suite run hit the known SDK import timeout and downstream shared
  counter failure. The final warm suite passed without changes to those tests.

## Offered appointment date

A serialized real-AI simulation exposed a separate date slip: after availability
for 14 November at 16:00, the model requested 15 November at 16:00. A release
guard now records explicit Japanese calendar/time tuples from recipient offers.
An omitted date may inherit only from a question with completed carrier playback,
never from generated or discarded speech. A conflicting replacement request is
blocked before audio is released; it also invalidates successful closure until
another request is played and answered. Availability questions remain possible.

A protocol probe found that Telnyx rejects `conversation.item.create` with
`role: system`. That unsupported event was removed before release. Recovery
feedback stays in the existing supported function-result channel, with no fake
recipient messages. The date guard does not itself expand authorization, prove
acceptance, or resolve every ambiguous Japanese date expression.

The final serialized real-AI simulation passed: a time-only echo, the recipient's
question about attending today, and an 11-second unanswered interval did not
cause premature closure. The replacement request used 14 November at 16:00;
only an explicit synthetic acceptance was followed by one simulated hangup.
All phone actions and metadata writes were intercepted; zero real calls and
zero recording uploads occurred during validation. This is not a completed
appointment change or proof of performance on the recipient's phone line.
