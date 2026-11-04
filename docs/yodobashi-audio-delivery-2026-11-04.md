# Interrupted first question at Yodobashi Akiba

Two owner-approved calls on 4 November were inspected using the provider's
conversation metadata, complete message pages, correlated call-leg events and
dual-channel recordings. Raw recordings, transcripts, credentials and signed
download URLs remain in the ignored private investigation directory.

## Observed behavior

The 16:54 JST call lasted 82 seconds. Its outgoing recording contains the fixed
acknowledgement, one audibility check and the farewell, but no product question.
The model generated one incomplete opening that was blocked by the dialogue
gate. Recognition saw six final fragments, but the provider conversation saved
no recipient messages. The available evidence does not establish why those
messages were absent; the short generated transcript is not the call duration.

The 17:34 JST call lasted 51 seconds. Several starts were cancelled before a
complete question was generated. A subsequent response produced 480,000 PCM
bytes at 24 kHz, representing ten seconds of audio. The carrier recording
contains only a short fragment of that question. Recipient speech overlaps its
beginning; the final recognized audibility check appears later because recognition
has latency. The waveform is consistent with normal speech cut short, not a
sixfold speed-up. It does not establish packet loss or a codec fault.

The controller's original audibility grace belonged to the first generated
response ID. Once that response was cancelled, a later response could become the
first audible question without receiving the grace. An intermediate or final
`もしもし` then cleared the carrier playback queue. Generated text and released
byte counts therefore did not establish that the full question was played.

## Correction

The first validated question actually released to the carrier gets a single
playback window based on its PCM duration, capped by the existing utterance
limit. Narrow audibility checks do not cancel it during that window. The window
ends on its carrier playback mark, cancellation or deadline; repeated checks
cannot extend it and later questions cannot acquire another window. Requests
to stop or wait, corrections and substantive answers remain interruptible.

Before any model audio is released, an audibility check can also preserve a
replacement generation after a cancelled start. This is bounded to 30 seconds
from the original first response and the existing 15-second generation limit.
Neither new response IDs nor repeated checks renew those limits. Listening
signals, real instructions and later responses retain their existing handling.

The conversation metadata now records the first question's delivery window,
completion and cancellation separately from generation. This still describes
the controller and carrier acknowledgements, not independent human hearing.

Stock-enquiry instructions now ask for the complete authorized product tuple
in a short stock question, followed by purchase conditions in a separate turn.
An unavailable-product answer is followed by a short restock question. The
immutable approved task and its purchase/disclosure limits are preserved.

An additional diagnostic defect was reproduced offline: a provider
`conversation_ended` error was ignored even while the phone call was active.
It now produces `voice_conversation_ended` and the existing failure termination.
Events during an already active farewell or completed teardown are still
ignored. This repairs a verified failure-handling gap, but is not presented as
the established cause of the first call.

## Verification boundary

Regression tests reproduce three cancelled starts followed by ten seconds of
generation and ten seconds of buffered PCM, with audibility checks during
playback. They also cover real interruptions, early or absent playback marks,
nonrenewable deadlines, unexpected provider termination and late teardown
events. Full-utterance validation and the existing codec and telephone transport
remain in place.

Virtual dialogue checks use the real AI WebSocket with synthetic recipient
turns. Every telephone action and metadata write is intercepted locally;
playback marks wait for the calculated duration of the outgoing audio. These
checks cannot certify reception over the public telephone network. No further
real call is part of this repair; a subsequent call retains its own approval.

The final virtual dialogue passed both checks during generation and playback,
then received a synthetic unavailable-stock answer and produced the restock
question. The stock question took 4.266 seconds to generate and 4.240 seconds
to play; the restock question took 2.409 and 2.400 seconds respectively. Both
completed without clearing their playback queues. These are observations of
one virtual run, not a latency guarantee or a real inventory result.

All 378 unit tests, type checking, the native workerd checks and Worker builds
passed. The first full-suite attempt encountered an unrelated cold-import
timeout in the OAuth SDK test and its following shared-counter assertion; the
final rerun passed all 22 test files. Telephone-contract checks passed in both
legacy and guarded modes, and the production dependency audit found no reported
vulnerabilities.

The final offline campaigns also passed: 1,000 voice scenarios, 1,440 IVR timing
cases, 420 pickup cases and 1,321 handoff/closure cases. Their telephone and
external API transports were disabled or simulated.
