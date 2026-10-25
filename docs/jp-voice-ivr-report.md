# Japanese voice, end-of-call and IVR candidate — 2026-10-25

## Deployment status

**Staged in isolated Telnyx assistants only. Not enabled on the production assistant.** No new real calls, phone Worker, MCP/Auth deployment, Telnyx number routing or credentials were changed. The production main version remains `20261024T130211034323`. Configuration acceptance is not functional validation.

The candidate includes a real native `send_dtmf` tool (not spoken digits), `skip_turn` for listening and `hangup` for actual termination, with a delegated tool backend. The original complete configuration and ten historical versions are saved locally under the ignored `.wrangler/jp-voice/api-before/`. No recordings, raw transcripts, appointment details or credentials are published.

## Effective configuration and candidate

| Setting                           | Production                                                      | Candidate in isolated lab                                           |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Speech model / voice              | `openai/gpt-live-1` / `OpenAILive.marin`                        | Same                                                                |
| Runtime turn detector             | `server_vad` reported by WebSocket                              | Same                                                                |
| Configured transcription          | Deepgram Flux, auto language; EOT .8, timeout 5000 ms, eager .8 | Same                                                                |
| Interruption                      | enabled; prediction threshold .55                               | .55 retained                                                        |
| Start-speaking wait / endpointing | .1 seconds                                                      | Unchanged                                                           |
| Delegation                        | disabled                                                        | enabled, existing `zai-org/GLM-5.3-Flash`, silent results           |
| Tools                             | shared generic hangup                                           | Separate inline hangup, send_dtmf, skip_turn; shared tool untouched |
| Legacy expressive_mode            | true, incompatible with current Marin API validation            | false; same normalization for both voice comparison arms            |
| Recording / routing               | Production configuration                                        | Disabled / no phone application in lab                              |

GPT Live requires delegation for tool execution ([Telnyx delegation](https://developers.telnyx.com/docs/inference/ai-assistants/delegation)). The native tool types are specified in the [official SDK schema](https://github.com/team-telnyx/telnyx-python/blob/master/src/telnyx/types/ai/assistant_tool.py). No unsupported VAD knobs or hangup delay fields were invented. Configured STT/endpointing fields must not be assumed to control the native speech model's runtime VAD.

## IVR behavior implemented in candidate

Listen to a complete menu; choose only an advertised option relevant to the authorized task; execute the native tone tool once; wait for the next menu. Stop tones when a human answers. No guessed extensions, automatic zero, payment, PIN, password or OTP entry. Remote prompts cannot expand authorization. A completed tool does not prove that the remote IVR accepted it.

The assistant instructions limit navigation to five selections and one explicitly requested retry per selection. Repeated menus, ambiguity and missing relevant options produce an unresolved outcome followed by the closing procedure. **These limits are model instructions, not independent server counters.** OAuth, owner approval, immutable outbound requests, expiry, anti-replay, idempotency and initiation rate limiting remain unchanged; none authorizes menu-initiated extra calls.

Permanent instructions contain no appointment-specific details. Name introduction follows the task, with truthful AI disclosure if asked. Japanese utterances are brief, one question at a time, and use either 18時 or 午後6時. Listening signals are distinguished from real questions contextually, without claiming that prompt text can override every VAD cancellation.

Closing distinguishes task outcome from call termination: settle essential facts, wait for the recipient's complete final turn, say the complete farewell, then execute hangup without requiring another turn. Holds and new questions suspend closing. Refusal, wrong number and inability to proceed remain failures in the summary, not successful bookings.

## Measurements and release blockers

Historical first-call transport events show answer-to-RTP 266 ms and answer-to-playback-engine start 282 ms. Those are not first-word or model inference latency. Transcript segmentation and 200 ms alignment are insufficient evidence of actual audible interruptions. Per-turn model/playback-cut events were unavailable for that PSTN call.

The reproducible voice corpus contains 30 clips / two synthetic Japanese speakers, 89.17 seconds. A final virtual comparison used 16 real Telnyx WebSocket sessions:

| Observation                                               | Normalized baseline (8) | Candidate (8) |
| --------------------------------------------------------- | ----------------------: | ------------: |
| Outbound output containing owner name                     |                     4/6 |           0/6 |
| Valid overlapping aizuchi trials with server cancellation |                     2/2 |           1/1 |
| Genuine interruption trials with server cancellation      |                     4/4 |           4/4 |
| Client PCM-end to next audio, median                      |                570.6 ms |      560.9 ms |
| Same measurement, p95                                     |               1124.8 ms |     1081.5 ms |
| Session errors                                            |                       0 |             0 |

Small samples and different valid overlap counts prohibit a latency-improvement or aizuchi-fix claim. These are client-observed virtual audio timings, not PSTN or model-only latency. A .7 interruption-threshold experiment did not resolve cancellations and was rejected; .55 is retained. Two inbound controls per arm are insufficient for full production regression approval.

The initial closing test invoked native hangup and closed the virtual connection; a hold control remained open. However, the estimated audio queue still contained approximately 25 ms at closure and the farewell transcript was fragmented. A reduced diagnostic also closed about 68 ms before estimated queue drain. No guarantee of a fully audible farewell has been established. A global short idle timeout was deliberately avoided because legitimate holds must remain possible.

IVR single-menu tests invoked skip_turn instead of send_dtmf despite the correct routing intent. Tightening the prompt did not establish actual DTMF execution. No-option and sensitive-PIN tests emitted no DTMF, but did not complete the desired automatic closing either. A minimal diagnostic also failed to establish DTMF. The multilevel trial emitted no DTMF and never reached its second menu. Multilevel and repeat fixtures plus a follow-up-on-success audio harness are supplied; unmet tool preconditions are failures, not passes. WebSocket virtual tests do not establish PSTN tone delivery or remote menu acceptance.

The repeated-menu trial did execute native `send_dtmf` twice with `{"digits":"2"}`, both successful. This establishes a real tool path in the virtual environment, not PSTN delivery. However, the third menu was still playing when native hangup closed the session: this is a failed closing-safety trial. Sanitized per-run evidence is in `voice/jp/ivr-results-2026-10-25.json`.

**Release remains blocked on reliable IVR sequencing, complete recipient/farewell playback and inbound regression.** The production apply script refuses deployment without a separate positive release-validation record tied to the candidate hash and baseline version. No such record has been fabricated. Snapshot availability was verified; actual production rollback has not been exercised because production was not changed.

## Reproduction and rollback

Use Node 22. Local `.dev.vars.voice` must remain ignored and private. Never paste keys or raw logs into a public issue.

```sh
npm ci
npm run typecheck
npm test
npm run build
node scripts/jp-voice-corpus.mjs
node --env-file=.dev.vars.voice scripts/jp-voice-lab.mjs
node --env-file=.dev.vars.voice scripts/jp-voice-simulate.mjs aizuchi-hai,stop-request,automation-identity,inbound-control both virtual-release-validation
node --env-file=.dev.vars.voice scripts/jp-end-call-lab.mjs
JP_SCENARIOS_FILE=voice/jp/ivr-scenarios.json node --env-file=.dev.vars.voice scripts/jp-end-call-simulate.mjs ivr-new-run ivr-change,ivr-no-option,ivr-sensitive,ivr-multilevel,ivr-repeat
node --env-file=.dev.vars.voice scripts/jp-voice-config.mjs plan
node --env-file=.dev.vars.voice scripts/jp-voice-config.mjs verify-rollback-route
```

Run folders are cached; choose a new name for a fresh experiment. Inspect recorded native tool name, arguments, result and remaining follow-up menus, rather than accepting the assistant's verbal assertion. Virtual tests may incur AI usage charges, but have no PSTN initiation path.

If a future validated release is applied, `node --env-file=.dev.vars.voice scripts/jp-voice-config.mjs rollback` promotes the saved original main version and verifies the prompt and voice readback. Preserve the private snapshot separately: Telnyx retains a limited number of versions. No Cloudflare deployment is required for assistant-only configuration changes.
