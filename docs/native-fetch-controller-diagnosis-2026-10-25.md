# Native HTTP receiver failure in the ChatGPT path — 2026-10-25

The failed request `6f615eb3-dcf2-4267-8b8b-46da225b0609` started and failed at 16:01:29 JST, after the earlier redirect repair was deployed at 15:55:24 JST. Its D1 record has a callback token but no Telnyx call or conversation identifier. It was not reset or retried.

## Confirmed cause

The controller constructor stored the native global `fetch` function as `this.providerFetch`. Calling `this.providerFetch(...)` supplies the `VoiceBridge` instance as its receiver. Cloudflare's native implementation rejects this with **TypeError: Illegal invocation**, before making the assistant configuration HTTP request.

A newly approved control request also failed at this same stage. Filtered production tracing recorded `voice_operation_failed`, `assistant_configuration`, `TypeError`. No phone API call was reached. A workerd regression with the original default transport reproduced `illegal_invocation=true` before the correction. An invalid URL is deliberately used to guarantee that this regression cannot send any network request.

The previous local and Cloudflare probes injected a fetch adapter. Those probes established adapter behavior but unintentionally bypassed the failing default dependency. The earlier redirect repair fixed a separate, real Workers incompatibility; it did not repair this native receiver error.

The default is now an arrow adapter that calls `globalThis.fetch(input, init)` with the proper global receiver. Redirect handling remains manual, with rejected redirect responses. The same native-receiver regression now reports `illegal_invocation=false` and the expected invalid-URL rejection.

## Actual service path and diagnostics

- Production D1 bindings, Worker service names, required variables and assistant version pin were checked.
- A non-deployed phone Worker version inherited the real phone service credentials and bindings. It authenticated to the actual controller. Re-registering the already failed row returned the expected 409 context rejection, proving the service credential works without changing the row or dialing.
- An authenticated, read-only controller diagnostic found its persisted registration context, without call/conversation binding or stream claim. Responses omit phone numbers, task text, callback tokens and nonces.
- An explicitly enabled operational preflight uses a synthetic D1 row, actual controller credentials/runtime and real storage. Phone endpoints are forbidden by an egress allowlist. It also tested the failed task text without changing its original D1 row. After the correction it exercises the default production transport rather than substituting the native function.
- Production assistant read returned 200, STT and AI upgrades 101, metadata update 200, with the controller ready. These checks did not dial a number.
- The phone patch adds controlled registration-stage logging only inside the outbound approval function. Inbound code and authorization guard remain byte-identical before bundling. Existing secrets and bindings are retained.
- Controller failures retain a redacted operation/stage/category diagnostic. Active preflight diagnostics are disabled by default and must be explicitly enabled; read-only diagnostics require the existing service secret. No raw exceptions, credentials, task contents or headers are logged.

## Verification and rollout

94 unit tests, nine actual workerd checks, and both phone-contract modes (24 legacy, 29 guarded) passed. Type checking and three Worker builds passed. New tests cover native fetch receiver behavior, diagnostic authentication, default-disabled active probing and redacted responses. MCP/Auth and Telnyx production configuration are unchanged.

The owner explicitly authorized real control calls. Operational plugin rules still require presenting each immutable request and receiving a subsequent owner message for that exact request. Failed requests remain terminal and are not automatically resubmitted. A successful preflight is not proof of PSTN DTMF delivery; the live control result is recorded separately when available.

## Live validation and additional corrections

Three separately approved PSTN calls were made in this intervention; the failed pre-dial requests were never replayed. The first reached answer but failed after seven seconds. The next streamed and recognized the menu but rejected its selection as stale; the final one completed successfully. No new call was made without its specific subsequent approval.

The real media path exposed two further integration faults that the earlier synthetic handshake checks did not cover: Telnyx's initial `connected` control frame has no stream ID and must be accepted before `start`; a handshake abort timer must be cleared after a successful WebSocket upgrade, otherwise it remains armed against the live socket. Both are covered by new regressions. A real Cloudflare comparison observed abnormal socket closes with the old timeout, while the repaired full synthetic speech/controller test remained ready for 30 seconds and generated exactly one mocked 5.

The live Apple menu also exposed turn fragmentation and background-energy races. A choice-free “choose one of the following options” introduction is no longer a completed selectable menu. Raw audio energy can temporarily guard closing but cannot invalidate a menu token; recognized STT turns control semantic transitions. A selection racing an announcement is queued for at most eight seconds against the **same immutable completed menu**. A generic replay introduction can retain that snapshot, while a different menu or recognized human response invalidates it. It is never retargeted, expires after 30 seconds, and remains one-use. New tests cover these cases, concurrent/repeated requests and continuous-speech expiry. The controller continues to reject unadvertised or sensitive digits.

A normal recipient hangup can close media before its signed hangup callback arrives. Media socket errors now get the same short call-state check as disconnections, rather than immediately misclassifying the completed call as failed. The actual Telnyx conversation ID is linked to the existing D1 request once the call identity and callback token match, rather than waiting for summary processing. No schema changes or request resets were made.

### Final actual call

Request `8d24900d-9e53-4354-88f6-0bbc22dac74a` reached `completed`, 225 seconds, no error. Its saved tool trace shows one `press_ivr_digit` with digit `5`, successful backend result at 17:15:56.194 JST. Telnyx records one successful `send_dtmf` at 17:15:55.400 JST. Telnyx debug logging intentionally redacts the digit, so the digit is verified by the correlated tool/backend trace, not by claiming the provider log exposes it. The menu advertised 1, 2, 3 and 5; the call subsequently reached a person after a substantial wait. These are correlated execution records, not an acoustic measurement of the tone at the receiver.

The call ended normally at 17:19:12.855 JST; MCP reports completed with the conversation linked. The generated conversation includes disclosure of automated technical testing. No further calls were made.

**Closing limitation:** the system farewell was interrupted by the recipient, the assistant responded, and the recipient ultimately hung up. No autonomous hangup command is recorded for this final call. Therefore successful DTMF and callback/state handling are established, but autonomous closing after that interruption is not certified by this trial. The long operator wait remains a behavior to improve; do not describe this trial as proof of optimal latency or complete end-of-call handling.

Final deployments: controller `aa20be16-dfae-4b39-9718-9431d726d606`; phone outbound logging `8badc6f7-330a-49f3-b1f8-917f99f21286`. Active diagnostic preflights are disabled. Inbound, MCP/Auth and Telnyx production configuration remain unchanged. Sanitized evidence is in `voice/jp/live-dtmf-validation-2026-10-25.json`. Raw traces, recordings and credentials are not published.

Final local validation: 100 unit tests, 11 workerd checks, 24 legacy and 29 guarded phone-contract checks, type checking and Worker dry builds pass. The native fetch correction commit is `7fb0e70`; the following commit contains the media/menu regressions and live evidence.
