# IVR menu recovery — 26 October 2026

## Reproduced failure

In the Apple Kawasaki call, `read_current_menu` started after a choice-free introduction, while the option list arrived approximately 16 seconds later. The controller's 4-second observational read expired first. The model then attempted digit 5 with the literal placeholder `MENU_TOKEN`; the server correctly rejected it with `STALE_OR_INCOMPLETE_MENU`. The complete Telnyx event list for that call leg contains no `send_dtmf` command. The automatic conversation summary incorrectly described the attempted tool invocation as a transmitted selection. The recipient terminated the call after 55 seconds; controlled farewell playback was not recorded.

## Correction

- Bound incomplete-menu reads to 30 seconds so the actual option list and the existing 750 ms post-transcript quiet period can finish before returning the immutable snapshot.
- Return explicit non-execution and silent recovery instructions after an incomplete read or stale/guessed token. Never issue a token for an incomplete menu, replace a guessed token automatically, or loosen exact token matching.
- Queue a selection bearing the exact current token during the post-transcript quiet period as well as during speech. Changed menus, recipient returns, holds, terminal announcements and the existing 8-second selection timeout still invalidate/block that selection.
- Apply the token/recovery instruction through the existing runtime outbound task policy. Do not change the pinned Telnyx assistant, the provider configuration, OAuth, MCP approval, inbound service, destination policy, quotas or secret values.

## Regression validation

Deterministic tests reproduce the observed long-menu wording and timing. They require the read to remain unresolved beyond 4 seconds, return the advertised digits with the server token after the actual menu, reject `MENU_TOKEN` without any provider write, and accept exactly one selected digit using the fresh snapshot. Additional tests cover the bounded 30-second incomplete read, quiet-period queuing and a full bridge tool-output round trip, including duplicate tool calls and one accepted DTMF event.

Provider transports in these regression tests are mocks. A real test is successful only when independent carrier events show an accepted command on the correct call leg and subsequent recipient speech confirms a menu transition/operator conversation. A tool invocation, a model summary and a normal phone-leg completion are not proof of those outcomes.

Local validation passed: 203/203 tests, type checking, 24 legacy and 29 guarded phone-contract checks, 11 workerd checks, and all Worker dry-run builds. The contract fixture retains byte-identical protected inbound code and the same authorization guard.

## Release and bounded real tests

Publish and deploy only the outbound voice controller after tests and CI pass. Preserve the live configuration and rollback version `05ea0ed3-11e0-4796-8281-11f163303826`. The owner authorized at most five autonomous real tests for the already-reviewed Apple Kawasaki destination, Japanese language and informational iPhone walk-in objective. Record the actual requests/outcomes privately and stop early on success or a blocking external result. This bounded test authorization does not change the normal MCP confirmation flow or authorize additional destinations, purchases, bookings or automatic future calls.
