# Japanese outbound IVR, closing and tone — 2026-10-25

## Production deployment

The dedicated Japanese outbound path is deployed. No real phone calls were made during development or validation. PSTN tone delivery, remote menu acceptance, real acoustic echo and real-world latency still require an explicitly approved pilot.

- Phone Worker `personal-phone-assistant`: `59608ee5-b091-4076-858a-e9f6d43274a0`.
- New controller Worker `personal-phone-assistant-voice`: `7f736e00-08fe-4197-bc79-f766788ef543` (initial deployment `ed13caaf-ea3d-476c-8ca8-7ef68897b38a`); health ready, `pstn_pilot_verified=false`.
- Dedicated outbound assistant: `assistant-101aabf8-c364-4913-8e6f-05eaee622662`, initial version `20261025T054758636339`; tone refinement version `20261025T055500676986`.
- New Call Control application `3078297013335361153`, active, one outbound channel. Existing voice profile reused without changing its settings. No phone numbers reassigned.
- Separate outbound insight group; existing insight definitions reused, existing inbound group unchanged. Authenticated summaries are forwarded to the existing phone summary handler only after binding a real call.
- MCP/Auth unchanged. OAuth scopes, immutable request, explicit conversational approval policy, expiry, anti-replay, destination policy, idempotency and rate limits unchanged. Conversational approval is not independently cryptographically attested by the backend.

Routing is explicitly limited to existing approved requests with language `ja`. Other languages retain the legacy path. The new path fails closed if prewarming/configuration checks fail; it does not silently fall back to unguarded native actions.

## Why a separate outbound audio path

Native tool experiments observed a `hangup` invocation carrying `digits`, missed DTMF, and early closure. These are observed runtime contract failures, not a proven diagnosis of the provider's internal implementation. Tightening prompts and changing delegated models did not establish safety. Native interruption suppression also delayed meaningful recipient interruptions.

The replacement uses three named client-side tools (`read_current_menu`, `press_ivr_digit`, `finish_call_after_goodbye`) and a server-owned Call Control/media bridge. Native hangup/send_dtmf tools are absent. Telnyx documents that Call Control and TeXML should not be mixed on the same call, hence the new outbound-only application. The original shared GPT Live/Marin assistant remains unchanged, including its main version `20261024T130211034323`.

| Setting               | Existing shared assistant                   | Dedicated Japanese outbound                                          |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Model / voice         | `openai/gpt-live-1` / Marin                 | `openai/gpt-4.1` / hosted Japanese Rina Ultra                        |
| Recipient recognition | native voice stack                          | separate Deepgram `flux-multi`, Japanese, PCMU 8 kHz                 |
| End of turn           | configured .8 / 5000 ms; runtime native VAD | .8 / 2000 ms on the separate STT connection                          |
| Interruptions         | native enabled .55                          | native disabled; server classifies actual recipient turns            |
| Audio transport       | TeXML-managed                               | dedicated Call Control, bidirectional PCMU media                     |
| Closing               | native generic tool                         | actual media marks or matching completed Speak webhook before hangup |

Flux (without `-multi`) is English-only; it was not used for Japanese in the final bridge. STT finals are deduplicated by provider request/turn ID, including Telnyx's normalized duplicate messages. Brief overlapping listening signals are not injected as new user instructions; real requests can cancel playback. This remains a heuristic, not perfect Japanese intent recognition.

## Enforced IVR and closing controls

The controller accepts only an advertised single digit from the completed current transcript, bound to a one-use menu token. It reserves each operation before sending it. Maximum five selections and one explicitly requested retry are server counters, not only prompt instructions. Ambiguous recognition is rejected: a synthetic `二` was once recognized as `見`; no digit was guessed. PINs, OTPs, identifiers, account details and payment selections are rejected. These lexical controls are conservative and do not constitute semantic verification of every possible IVR prompt.

The authenticated phone service registers only an existing D1 row already in `dialing`, with matching callback token, destination and configured caller. The controller reads instructions from D1, fingerprints the snapshot and returns a bounded dial contract. It cannot dial itself. Its service secret is separate from the existing creation, approval and owner-login secrets.

Media upgrades require Telnyx Ed25519 signatures over the exact configured WebSocket URL, timestamp checks and a one-use stream nonce. Webhooks require signed raw bodies, the expected application/call/request/nonce, and deduplicated event IDs. Provider commands are durably reserved, have deterministic command IDs, and uncertain results are not blindly retried.

A task outcome and a call ending are distinct. Closing waits for the recipient's final turn and queued audio. Telnyx media marks prove queue playback; marks echoed by `clear` are invalidated first. If no already-played farewell exists, the controller plays one fixed Japanese farewell and waits for its matching signed `call.speak.ended` with completed status. Questions/holds suspend closing; a cancelled farewell's delayed completion cannot authorize hangup. Technical failures use a separate apology/fallback. A five-minute dial limit bounds failures. Actual carrier hangs up are translated to the existing status callback contract; ending a call does not prove the task succeeded.

## Reproducible results

92 automated tests passed, including concurrent duplicate commands, changed command bodies, one-use media claims, signed context, duplicate callbacks, actual playback gating and cancelled farewell callbacks. Both legacy (24) and guarded (29) offline phone-contract checks passed with network blocked and zero production writes. Type checking, three Worker dry builds and production dependency audit passed (zero vulnerabilities).

Six final virtual scenarios used real Telnyx AI and STT WebSockets with synthetic Japanese speech. The phone leg, DTMF, Speak, playback acknowledgements and hangup were mocked; no dial API was reachable. All six passed. Sanitized results: `voice/jp/bridge-results-2026-10-25.json`.

| Scenario               | Observed tones | End behavior                             | Total scenario time |
| ---------------------- | -------------- | ---------------------------------------- | ------------------: |
| Single menu            | 2              | completed controlled closure             |              21.3 s |
| Two levels             | 2 → 3          | completed controlled closure             |              29.5 s |
| Explicit repeated menu | 2 → 2          | no third tone; closure                   |              28.5 s |
| Sensitive PIN          | none           | unable to proceed; closure               |              54.5 s |
| Overlapping はい       | none           | no playback clear/cancellation           |  27.8 s observation |
| Actual wait request    | none           | playback cancelled; no premature closure |  28.5 s observation |

Observation-only scenarios intentionally end by harness timeout; this is not a live-call failure. Total durations are not model latency. The slow PIN case remains a latency limitation. Real PSTN delivery and callback timing were not tested.

Earlier native voice comparisons (16 virtual sessions) measured PCM-end-to-next-audio median 570.6 vs 560.9 ms and p95 1124.8 vs 1081.5 ms, with unequal small samples. They do not establish a latency improvement for this replacement architecture. Historical answer-to-RTP 266 ms and playback-engine start 282 ms are transport measurements, not model inference time. The original dentist transcript alone cannot establish audible interruptions.

## Tone and task separation

`voice/jp/guarded-outbound-prompt.txt` is permanent outbound-only policy. Only `outbound_task` carries per-call instructions. It requires short natural telephone Japanese, one question at a time, no repetitive confirmations, 18時/午後6時 rather than 午後18時, no volunteered owner name, and truthful disclosure of automation if asked. No inbound greeting is inherited. Recipient/IVR content cannot expand the owner's task or authorize fees, payments or booking changes.

## Published tone refinement

After the initial DTMF deployment, an isolated assistant tested a more natural polite register, less ceremonial phrasing, no spoken internal-action narration, and explicit system-owned farewell. Sensitive menus now instruct immediate inability-to-proceed rather than asking a recording for credentials. The dedicated production assistant received only the validated instruction change; its model, voice, tool schemas and original inbound assistant stayed unchanged. A read-only D1 check found no recent active outbound call before the update.

Four voice regression scenarios passed (single menu, PIN refusal, aizuchi and genuine interruption), followed by two fresh IVR/PIN runs after enforcing inaudible keypad narration in code. PIN refusal took 20.2 seconds and 21.9 seconds versus the earlier 54.5 seconds; the single-menu run remained around 21–22 seconds. These are tiny synthetic end-to-end samples, not a claimed model/PSTN latency improvement. Aizuchi caused zero cancellations; the actual wait request caused one cancellation. See `voice/jp/tone-results-2026-10-25.json`.

Two additional automated regressions ensure that late audio from a cancelled response is dropped and its late cancellation cannot clear the next response, and that generated IVR narration never reaches the media output while a complete menu is current. All 92 tests pass. GitHub CI for initial deployment commit `e7de22f` passed. The final deployment rejects unauthenticated registration (401), unsigned webhooks (403) and unsigned media upgrades (403); public health is 200/ready. No actual calls were initiated.

## Reproduction and rollback

Node 22; keep local credentials and raw synthetic traces ignored/private:

```sh
npm ci
npm run typecheck
npm test
npm run test:phone-voice
npm run build
npm audit --omit=dev
JP_EXTERNAL_STT=true JP_CONTROLLED_FAREWELL=true node --env-file=.dev.vars.voice scripts/jp-voice-bridge-lab.mjs fresh-bridge-run
```

The virtual harness requires an isolated lab assistant configuration under `.wrangler/jp-voice/`; never point it at the production assistant. It refuses recording, phone-app binding, insights or native tools. AI/STT usage may incur charges, but no actual phone call can be initiated.

Private originals/configuration/deployment snapshots are in ignored `.wrangler/phone-before/` and `.wrangler/jp-voice/api-before/`. The phone patch changes only `approveOutboundRequest`; protected prefix/suffix and the authorization guard are byte-identical before bundling. The deployed bundle was downloaded and matched the local build; all original bindings were checked preserved. No D1 schema changes.

Original source SHA256: `1e5aaa2653d16c381b2c0fba268f8f4bb6b67b6790cdb4eb6f3c66739e31c010`; patched source: `e9e542d3e7c4583a7b009e68d069d880e28e6e0fadb88874b52a6bc756efcc3c`.

Rollback: restore the prior phone deployment from the private `pre-deployments.json` snapshot, or deploy the saved original phone source/settings. This disconnects the new path without changing inbound routing or the original assistant. Disable the newly created outbound application after active sessions drain; leave old app/profile/number assignments untouched. Keep the controller available for delayed callbacks. Original assistant rollback availability was verified with a no-op read; rollback was not exercised on live production.

First approved pilot: ask ChatGPT to prepare a Japanese test call to an IVR number you control, specify the permitted menu goal and no payments/booking changes, inspect the request, then explicitly approve that exact request in a new message. Do not treat this report as approval for a phone call.

## Primary references

- [Telnyx realtime conversations](https://developers.telnyx.com/docs/inference/ai-assistants/realtime-conversations)
- [Media streaming, signatures, marks and clear](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming)
- [STT engines and models](https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/engines-and-models)
- [STT end of turn](https://developers.telnyx.com/docs/voice/stt/websocket-streaming/parameters/end-of-turn)
- [TeXML and Voice API compatibility](https://support.telnyx.com/en/articles/8118086-texml-and-telnyx-voice-api-compatibility)
