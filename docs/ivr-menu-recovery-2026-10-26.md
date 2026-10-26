# IVR menu recovery — 26 October 2026

## Reproduced failure

In the Apple Kawasaki call, `read_current_menu` started after a choice-free introduction, while the option list arrived approximately 16 seconds later. The controller's 4-second observational read expired first. The model then attempted digit 5 with the literal placeholder `MENU_TOKEN`; the server correctly rejected it with `STALE_OR_INCOMPLETE_MENU`. The complete Telnyx event list for that call leg contains no `send_dtmf` command. The automatic conversation summary incorrectly described the attempted tool invocation as a transmitted selection. The recipient terminated the call after 55 seconds; controlled farewell playback was not recorded.

## Correction

- Bound each incomplete-menu read to 3.5 seconds, below the observed Telnyx 5-second client-tool deadline. Long announcements are observed across fresh reads; pending responses explicitly instruct silent recovery. A completed snapshot can be read even while another turn is in progress, because reading does not execute an action.
- Return explicit non-execution and silent recovery instructions after an incomplete read or stale/guessed token. Never issue a token for an incomplete menu, replace a guessed token automatically, or loosen exact token matching.
- Queue a selection bearing the exact current token during the post-transcript quiet period as well as during speech. Changed menus, recipient returns, holds, terminal announcements and a 3.5-second selection timeout below the same provider deadline still invalidate/block that selection.
- For a continuously replaying IVR, accept a fresh interim match to the exact previously observed introduction, choice count and observed option prefix of an already-complete, unconsumed snapshot. The match expires after one second and is revoked on a new turn, final transcript, changed/unrecognized interim, token change or menu expiry. Only DTMF readiness uses this exception; spoken audio and hangup retain their independent recipient-speech guards. Unknown human speech, questions, quotations, changed menus, holds and sensitive choices remain blocked. Record the actual dispatch guard separately from carrier acceptance.
- Apply the token/recovery instruction through the existing runtime outbound task policy. Do not change the pinned Telnyx assistant, the provider configuration, OAuth, MCP approval, inbound service, destination policy, quotas or secret values.

## Regression validation

Deterministic tests reproduce the observed long-menu wording and timing. They require pending reads to return within 3.5 seconds across the approximately 16-second announcement, return the advertised digits with the server token only after the actual menu, reject `MENU_TOKEN` without any action, and accept exactly one selected digit using the fresh snapshot. Additional tests cover snapshot reads during replay, the action-only quiet guard, bounded selection waits and a full bridge tool-output round trip, including duplicate tool calls and one accepted DTMF event.

Provider transports in these regression tests are mocks. A real test is successful only when independent carrier events show an accepted command on the correct call leg and subsequent recipient speech confirms a menu transition/operator conversation. A tool invocation, a model summary and a normal phone-leg completion are not proof of those outcomes.

Local validation passed: 209/209 tests, type checking, 24 legacy and 29 guarded phone-contract checks, 11 workerd checks, and all Worker dry-run builds. The contract fixture retains byte-identical protected inbound code and the same authorization guard.

## Release and bounded real tests

Publish and deploy only the outbound voice controller after tests and CI pass. Preserve the live configuration and rollback version `05ea0ed3-11e0-4796-8281-11f163303826`. The owner authorized at most five autonomous real tests for the already-reviewed Apple Kawasaki destination, Japanese language and informational iPhone walk-in objective. Record the actual requests/outcomes privately and stop early on success or a blocking external result. This bounded test authorization does not change the normal MCP confirmation flow or authorize additional destinations, purchases, bookings or automatic future calls.

The first authorized real test independently established the provider deadline: three read attempts ended with the plain-text provider result `The client tool call timed out.` exactly five seconds after invocation. Extending one observation to 30 seconds therefore cannot work on this route. No DTMF was dispatched and no operator was reached. The final correction returns bounded pending results instead, and records only compact readiness flags in private conversation metadata; diagnostic writes are best effort and cannot delay the tool response or authorize an action.

The second authorized real test confirmed bounded tool results and a valid exact menu token. No tone was dispatched: the action guard remained `speaking=true` throughout the immediate replay. The final interim replay matcher addresses that specific case rather than disabling the recipient-speech guard globally. Deterministic checks cover changed/quoted prompts, invalid digits and tokens, stale match expiry, and a human interruption revoking a queued selection before dispatch.
