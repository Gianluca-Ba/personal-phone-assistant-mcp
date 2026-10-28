# Outbound dialogue readiness and playback evidence

The latest inspected recording separates generated transcript text from actual
outgoing audio. During the two inventory questions shown by the model transcript,
the outgoing channel measured peak 0 and RMS 0. Only the controlled farewell had
nonzero outgoing audio. The legacy summary therefore cannot establish that those
questions were spoken. Existing D1 reports are not rewritten.

New outbound sessions now withhold all model audio until an authenticated
recipient transcript provides a dialogue candidate. A recorded welcome, numbered
IVR, transfer announcement, hold music or silence does not satisfy that gate.
Successful keypad dispatch resets the candidate before another transfer. A
response begun before the candidate remains suppressed even if a greeting arrives
while its buffered audio is being generated. Existing holds, terminal conditions,
whole-utterance validation, OAuth, owner approval, immutable request, expiry,
single-use tokens, quota and duplicate-execution controls remain required.

A dialogue candidate is a conservative language/turn heuristic, **not verified
human identity**. A recording could imitate a greeting. Neither this signal nor
transcription proves that the recipient heard audio. Conversation metadata now
separates completed, released and unreleased model responses and bytes handed to
the transport, with `recipient_reception_proven=false`. A release is not proof of
successful playback or human contact. MCP instructions explicitly prohibit those
inferences from assistant text alone.

`npm run test:voice-campaign` runs 1,000 deterministic, seeded scenarios using the
production controller and bridge with fake media sockets, fake provider APIs and
a process-wide prohibition on external fetch. It covers startup, recorded
welcomes, complete IVR/one-use DTMF, routing holds, actual dialogue candidates,
greetings arriving during a response, explicit holds, terminal announcements,
report leakage and new transfers. Audio chunk boundaries and timing vary. Positive
cases must transmit ten checked 20 ms frames; negative cases must transmit none.
Duplicate completion must not transmit twice. The observed corpus can be supplied
as private JSON using `observations=...`; it is data, never authorization.

The requested campaign is a baseline of 1,000 offline scenarios followed by at
most five separately budgeted live attempts, each followed by 500 offline cases
with a new seed and an updated private observation corpus. A persistent exclusive
ledger prevents duplicate batches and uncertain live outcomes are never retried.
No live call is launched by the offline script. Raw recordings, credentials,
phone request identities and private outcomes remain outside version control.

These counts measure simulated control/transport behavior, not independent human
conversations, ASR accuracy, model latency or general PSTN reliability. No change
to inbound or the production phone Worker is necessary. Rollback uses the saved
pre-release MCP/voice deployment versions and preserved private configurations.
