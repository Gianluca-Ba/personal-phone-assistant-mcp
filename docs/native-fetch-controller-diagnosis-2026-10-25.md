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
