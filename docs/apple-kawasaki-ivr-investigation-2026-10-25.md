# Apple Kawasaki: command acceptance versus IVR navigation

The goal is to reach a store representative and ask when **iPhone Duo 256 GB in the dark finish** can be bought walk-in without reservation. The Japanese catalogue calls the dark finish **ナイトスカイ (Night Sky)** and lists 256 GB ([Apple specifications](https://www.apple.com/jp/iphone-duo/specs/)). No availability or restart date has been obtained from an operator.

## Reviewed call: 8840183d-8a74-4570-84a5-ad8853f09e4f

- Answer: 17:26:47.761 JST, 2026-10-25.
- One `send_dtmf` command: 17:27:16.746 JST, approximately 28.985 seconds after answer.
- Backend tool requested digit 5; the provider accepted one command. Telnyx debug logs redact its digit.
- Command, dial and call events share the same call leg. The outbound application currently reports `dtmf_type = RFC 2833`.
- The old command did not explicitly set `duration_millis`; no undocumented default duration is asserted.
- No verified IVR transition or operator interaction in the supplied final report. Command acceptance is not PSTN reception or business success.
- The call ended with `hangup_cause = time_limit`, 17:31:47.232 JST, approximately 299 seconds after answer. The farewell did not finish: `call.speak.ended` reported `call_hangup`.

High-level Call Events do not provide a packet capture proving that RTP telephone-event 5 was delivered and accepted at the PSTN/PBX boundary. The configured RFC 2833 mode and positive API response cannot distinguish a network transmission/negotiation problem from a receiver rejecting the selection. No claim is made that changing duration fixes the physical transport.

This is a different request from the earlier 8d24900d trial. The earlier `completed` status was a transport result; it must not be used to certify successful navigation or receipt of walk-in information.

## Changes

Only the Japanese outbound controller is changed; inbound, OAuth, destination policy, owner consent, immutable requests, rate limits, one-use menu tokens and command idempotency stay intact. The Telnyx application and global DTMF transport setting are not modified.

- Explicit, configurable `OUTBOUND_DTMF_DURATION_MS=250`. Accepted range 100–500 ms, as supported by the [Telnyx command schema](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/calls/actions.ts). No unsupported per-command transport selector is invented.
- Durable `dtmf_requested` and `dtmf_accepted` events correlate command ID, call leg, duration and HTTP status. Unknown/rejected results do not become accepted events and do not authorize blind retries.
- `ivr_transition_detected` requires a different complete menu or an explicit routing announcement. Exact/partial repeats and minor recognition variations do not qualify. It records observable evidence, not proof that a carrier delivered the tone. A possible human greeting is a separately labelled `ivr_transition_candidate`, not verified human contact or business success.
- Configurable `OUTBOUND_IVR_TRANSITION_TIMEOUT_MS=45000`, bounded to 10–120 seconds. Without observable progress, request outcome becomes `unable_to_proceed`/`ivr_transition_timeout`; there is no automatic repeated digit.
- An ongoing recipient turn gets a grace period. A known repeated automated menu can be stopped after 20 additional seconds; uncertain non-IVR speech is not forcibly cut by this policy. Thus an unobservable but legitimate silent queue can conservatively time out; this is not evidence of tone rejection.
- The timeout uses a fixed Japanese farewell, then signed Speak completion before hangup. If that callback is missing, a separate 20-second deadline uses the **same** idempotency key for one hangup attempt. Provider outages still leave the existing five-minute carrier limit as the last safety bound; no absolute shorter limit is promised under unavailable call-control APIs.
- `hangup_completed` is recorded only from the actual authenticated hangup webhook, never merely from an accepted hangup command.
- “その他のご質問” in an IVR option no longer falsely counts as a recipient question preventing closure. Actual questions and holds retain their protections.
- Existing D1 failure status is refined to `ivr_transition_timeout` only after the matching call/callback identity is checked. No schema change or failed-request reset.

All events are available through service-authenticated redacted diagnostics. No phone numbers, task text, callback tokens, approval nonces or API keys are logged. Existing state retention and access controls apply.

## Validation and limits

110 automated tests pass, including accepted-but-unchanged menus, missing callbacks, simultaneous timeout checks, duplicate hangup attempts, rejected/uncertain DTMF, candidate-versus-observed transitions and supported configuration bounds. Eleven workerd checks exercise Workers-specific behavior. Legacy and guarded phone contracts and builds are also checked.

No new real phone call is performed as part of this repair. Future live validation must separately establish: API acceptance; observable remote routing; an operator interaction; the requested walk-in information; and safe termination. A new call requires its own immutable details and subsequent owner approval.

## Deployment

Published only `personal-phone-assistant-voice`, version `9d834f14-518d-4a93-8a9e-d1872b1db420`. The downloaded production bundle matches the local build; 250 ms duration, 45-second transition deadline and disabled active diagnostics were read back from Cloudflare. Inbound, phone Worker, MCP/Auth and Telnyx application settings are unchanged by this intervention. No new real calls were made.
