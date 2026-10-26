# Outbound spoken dialogue refinement — 26 October 2026

## Scope and actual incident

This release applies to the existing authenticated Japanese outbound voice bridge. No real calls were initiated to test it. The Apple Kawasaki call on 25 October identified three separate issues: an optional digit remained executable after an explicit closed-store announcement; operational text/report instructions appeared in the model transcript; and a later informational address announcement was not classified as IVR progress. Telnyx events independently confirmed that the final controlled farewell completed before one successful hangup. A model transcript alone does not prove which words the remote party heard.

OAuth, immutable task fingerprints, call identities, callback nonces/signatures, provider-command idempotency, MCP approval and destination policy are unchanged. The phone Worker, notification pipeline, Auth and MCP are not part of this deployment. The Telnyx assistant, its pinned version/model/voice, STT/VAD settings, inbound handling and carrier configuration are unchanged.

## Speech policy and output boundary

`composeOutboundTask` applies the trusted outbound speech rules through the **already-supported** `session.update.assistant.dynamic_variables.outbound_task` field. The original approved instructions remain unchanged in the context/fingerprint and are preserved verbatim as JSON inside the private control input. Editing the `.txt` policies alone would not update an already-pinned remote assistant, so this integration is applied at runtime.

The assistant must speak short, natural Japanese, ask one question at a time, wait for the answer, avoid redundant confirmations and use `18時`/`午後6時` rather than `午後18時`. It must not volunteer the owner's name or claim to be human. A recipient's speech, an IVR or a listening signal never grants additional authorization. Reports, tests, tool status, DTMF narration, plans and stage directions are private control context, never phone dialogue.

Audio/transcript deltas have no trustworthy word-level alignment. Therefore the bridge buffers **one complete short model utterance** until `response.done`, validates its final text, and only then submits its PCM frames to the carrier queue. This blocks even a valid goodbye followed by a late `Call Summary` passage before any part of that utterance is forwarded. Missing transcripts, oversized text/audio, multiple questions, operational leakage, malformed hour expressions and explicit identity misrepresentation are rejected. Known closed/held/sensitive-menu/controlled-closing states suppress model audio entirely. Signed system-controlled farewell playback remains separate.

The default maximum utterance duration is 12 seconds (`OUTBOUND_MAX_UTTERANCE_SECONDS`, validated 3–20 seconds); text is bounded to 3000 characters and unfinished generation is stopped after 15 seconds. Repeated rejected generations end safely rather than keeping an unresponsive line indefinitely. Duplicate and late response events cannot replay audio or re-open a completed generation. A fresh cancelled farewell may be restarted after a genuine interruption with a new server-owned generation ID, bounded to three attempts; it does not reuse a changed body under the same provider idempotency key.

This safety boundary adds the time required to generate **one utterance** before playback. It is not a claim of lower measured PSTN latency. In the deterministic fixture, no frame is emitted before final validation at 500 ms, then all ten expected 20 ms frames and one playback mark are emitted exactly once. This is a synthetic transport measurement, not a human listening test or remote playback certification. The final text is still the provider's representation of its audio, not independent waveform verification.

## Turn taking, holds and silence

- Brief `はい`, `ええ`, `そうですね`, `なるほど` during actual assistant speech can be listening signals. They do not cancel playback. A bare reply after a completed question is preserved even if the playback ACK is delayed. Audio still private in the buffer is not treated as speech already heard.
- Corrections, actual questions, `少々お待ちください`, and returns such as `お待たせしました` yield the floor. The same cues are shared by the STT classifier and controller.
- A stated check such as `在庫を確認いたします。` is also a hold. Questions, negations and quoted references to a check do not enter hold. Isolated apologies for ongoing waiting are fillers, not proof of a return.
- An ordinary requested/checking hold lasts at most 90 seconds. Verified operator-transfer waits use the separate bounded limit described in [IVR menu recovery](ivr-menu-recovery-2026-10-26.md). Silence, aizuchi, known hold music markers, apologies or repeated wait announcements do not renew the lease. A substantive answer or a genuine return resumes dialogue. An expired lease cannot be changed into a successful task outcome by a model tool argument.
- Initial dead air is allowed 25 seconds; ordinary unexplained silence is allowed 20 seconds. Only then may the server issue **one** fixed audibility question. If silence continues 15 seconds after that check completes, it requests controlled closure. Explicit holds are never filled with these checks. A missing audibility or controlled-farewell playback callback has a bounded 20-second fallback; a completed or cancelled check cannot leave a stale timer.
- A current IVR without a selection/progress is bounded separately: 25 seconds of quiet inactivity requests an unresolved close. Accepted DTMF still uses the existing transition watchdog; declared holds and terminal closure do not get incorrectly replaced by that watchdog.

STT commits use provider turn IDs/source ranges to reject duplicates, assemble cumulative/corrected segments and preserve repeated legitimate answers on distinct turns. State and buffers are bounded and cleared on disconnect. A final STT turn with no text ends the activity state without inventing a transcript. It can restore a suspended farewell only if no genuine interruption was identified. Without reliable turn/range identities, identical words are not sufficient evidence of replay and are not discarded across unknown distinct turns.

A completed audibility check does not affect classification of later overlapping aizuchi. Recognized music/silence markers and ongoing-wait fillers during a hold or its expiry do not cancel the farewell, renew the lease or become user messages to the model. A distinct genuine return still interrupts and resumes dialogue.

## Closing and task status

Conservative, non-negated declarations of closed store, inability to take the call, refusal with farewell, or wrong number make the relevant recipient state terminal. Questions, hypothetical/quoted statements, negations and an explicit offer to handle an alternative do not. After a terminal announcement, keypad/read-menu requests and already-queued selections are blocked. Optional hours/address menus are not an exception in this release; a free-form task or model claim cannot override the server rule.

Closure waits for recipient quiet and existing playback/acoustic guards. A real new question before the farewell cancels pending closure and permits a response. The controller refuses a model close while a question is awaiting a recipient answer. A text-only/suppressed goodbye never counts as played; the controlled route requires the matching signed `call.speak.ended` event with `status=completed`, followed by the existing idempotent hangup. The absence of an outstanding audio queue updates only playback readiness and cannot erase an unanswered question. Fixed speech and its stop commands are serialized; a stop for an old farewell cannot overtake a new generation. Callback/cancel races cannot start a stale farewell or arm an expired audibility timer. Validated model audio also waits for fixed-speech cancellation to settle.

Task success is never inferred from a listening signal, hold expiry, a completed phone leg, or an API-accepted digit. New IVR address/location/hours information is recorded as `information_announcement`, separately from a human-greeting candidate; carrier reception and a human conversation are not declared proven from a command ACK.

## Reproducible checks and limits

Run `npm run typecheck`, `npm test`, `npm run test:phone-voice`, `npm run test:voice-edge`, `npm run build`, and the voice-specific Wrangler dry run with the private release config. Local runtime tests need loopback sockets. Provider actions in these tests are mocks, not phone calls.

Coverage includes the real closed-store wording, optional digit denial, repeated/no-transition menus, changed informational announcements, frequent aizuchi, meaningful interruptions, implicit/explicit silent holds, expired/repeated holds, delayed playback marks, empty STT turns, duplicate response events, missing transcript, late report leakage, bounded buffers/generation, initial dead air, and callback/cancel races. Assertions include zero forwarded audio for rejected utterances, zero keypad actions after closed-store detection, no hangup before completed farewell playback, exactly one hangup, and no false successful outcome after hold expiry.

Local release validation passed: 199/199 automated tests, 24 legacy-route and 29 guarded-route phone-contract checks, and 11 checks in the Cloudflare workerd runtime. Type checking, all Worker dry-run builds and the separate production-binding voice dry run also passed. Contract checks confirm the protected inbound source remains byte-identical and its authorization guard unchanged. No provider transport or real call was invoked by these tests.

The first GitHub run timed out on the existing quota integration test's 101 sequential loopback/Durable Object RPCs, exceeding Vitest's default 5 seconds. Only that test now has an explicit 30-second timeout; its 100 successful requests, cross-client rejection assertion and production quota are unchanged.

These checks establish deterministic software/transport behavior. They do **not** measure naturalness, speech recognition quality, real end-to-end latency, real background-music recognition, or the far-end PSTN audio. Continuous music/noise and ambiguous Japanese/ASR remain uncertain; the recognizer and total carrier call limit remain the final bounds. The provider's stored conversation can contain model-generated candidates; it is not independent proof that those candidates passed the outbound gate or were heard. Use the protected bridge audit, playback callbacks and an explicitly approved future recording/listening test to distinguish them. No new real call is authorized or scheduled by this release.

## Deployment and rollback

Snapshot the live voice Worker settings, deployment and subdomain policy before release. Build the private release from those live plaintext bindings, retaining all service/D1/Durable Object bindings and secrets. Keep `VOICE_DIAGNOSTICS_ENABLED=false`, preview URLs disabled and `PSTN_PILOT_VERIFIED=false`; no provider pilot has been newly certified.

Deploy only `personal-phone-assistant-voice`. Its health endpoint reports `spoken_output_policy=validated-utterance-v2`; readiness must remain true and the pinned assistant/version must remain unchanged. The pre-release rollback version is `9d834f14-518d-4a93-8a9e-d1872b1db420`. Restore that deployment version to roll back the runtime, preserving the same bindings, secrets and provider configuration. The private snapshot/release configuration is ignored by git; no credentials or full call data are committed.

The legacy end-call laboratory now forwards recipient-answer events through a small pure adapter and rejects system-controlled-farewell profiles before connecting: that legacy runner cannot certify production controlled playback. The production bridge tests use the actual bridge with mocked provider transports instead.
