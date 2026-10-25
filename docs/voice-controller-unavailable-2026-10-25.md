# Outbound controller failure — 2026-10-25

## Cause and reproduction

The phone service returned `voice_controller_unavailable` while registering the approved Japanese request. The controller used `fetch(..., {redirect: "error"})`. Cloudflare Workers throws a `TypeError` for that mode while constructing the request, before contacting Telnyx:

> Invalid redirect value, must be one of "follow" or "manual" ("error" won't be implemented since it does not make sense at the edge; use "manual" and check the response status code).

This was reproduced on an authenticated, temporary Cloudflare Worker using the actual bridge and an isolated existing Telnyx lab assistant. The first assistant configuration read failed; no phone API was invoked. The previous Node-based voice harness did not exercise Cloudflare's Request implementation. Public health reported configured readiness, not successful provider warmup. The previous production readiness report was therefore insufficient.

Cloudflare documents the unsupported mode in its [Request API](https://developers.cloudflare.com/workers/runtime-apis/request/). There is no evidence that a disconnected ChatGPT authorization or an unreachable Worker caused this failure.

## Correction

All seven outgoing Telnyx fetch sites in the voice controller now use `redirect: "manual"`. Existing status checks reject redirects; credentials are not forwarded to another origin. This covers assistant configuration, AI and STT upgrades, metadata, call-control actions, call status and insight lookup.

Registration diagnostics now log only fixed operation/stage/error categories. They never log request bodies, URLs, phone numbers, identifiers, raw exceptions, tokens or secrets. Failure remains closed; neither authorization nor idempotency was relaxed.

Production deployment: only `personal-phone-assistant-voice`, version `5c09f7df-4dd3-4957-807d-028ee8ff6ed6`. The deployed bundle was downloaded and matched the local build. Phone Worker, MCP, Auth, inbound, Telnyx production configuration and D1 schema were not changed by this repair. The assistant version pin remains unchanged.

## Verification

- 92 unit tests passed.
- New `npm run test:voice-edge`: six checks in actual `workerd`, no external network. The production bridge constructs actual Workers Requests, completes mocked voice/STT warmup and metadata binding, and rejects a redirect without following it. Added to CI.
- Existing phone contracts: 24 legacy and 29 guarded checks passed with network blocked and zero production writes.
- Type checking and all three Worker builds passed.
- Real Cloudflare/Telnyx test with an isolated lab assistant: assistant read 200, STT upgrade 101, AI upgrade 101, metadata update 200, voice ready true. Phone endpoints were explicitly forbidden.
- Additional test with the production `VoiceSession` implementation in an isolated real Cloudflare Durable Object: registration 200 and a valid dial contract returned. The D1 row was synthetic; no real D1 row was changed, no dial was performed, and no phone action was available through the test endpoint.
- Production health after deployment: 200, ready true, PSTN pilot remains unverified. The temporary diagnostic Worker was removed after testing.

These tests establish controller initialization, not actual carrier DTMF delivery. No real phone calls were made. Historical production tracing was disabled; the diagnosis comes from a direct reproduction of the released code in Cloudflare, not invented historical logs.

## Failed request and next test

The existing failed request was not reset or retried. `OUTCOME_UNKNOWN` remains the MCP gate's conservative classification; the controller-registration error occurs before the phone service's dial request. The diagnostic work did not approve another attempt.

For another real test, create a **new** request in ChatGPT for Apple Kawasaki (`+81445775100`) with the precise permitted IVR objective. Review the complete details, then explicitly approve that new request in a new message. Do not bypass the controller, reuse the failed nonce or press a digit that was not actually advertised by the menu. The next test still needs to verify carrier tone delivery and remote menu response.
