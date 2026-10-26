# Apple IVR reliability investigation — 26 October 2026

## Evidence before new tests

The supplied Ginza report described a transmitted digit 5. Independent inspection contradicts that claim: the model used the exact token from its successful menu read, but the selection returned `STALE_OR_INCOMPLETE_MENU`; the complete carrier event list for the uniquely matched call leg has **no send_dtmf command**. The 57-second call ended remotely. A model tool invocation must never be reported as a transmitted tone when the tool failed.

The later Shibuya call is a different failure: the carrier recorded one 250 ms command approximately 49 seconds after answer, without an observed transfer before remote hangup. Its transcript suggests an invalid-input announcement; that wording alone does not prove a carrier transport failure. Kawasaki's latest 139-second call recorded one command 27.7 seconds after answer and reached a recipient who answered the inventory question. Backend completion is not commercial success, and API acceptance is not remote IVR acceptance. [Telnyx documents](https://developers.telnyx.com/api-reference/call-commands/send-dtmf) the command, 100–500 ms digit duration, command-id deduplication and absence of an associated delivery webhook. No transmission-method setting is changed.

## Reproduction and correction

A no-call, real-time replay of the Ginza inbound recording through Nova-3 Japanese reproduced the segmented introduction/options and a repeated partial introduction. Regression fixtures additionally reproduce a committed STT message containing both `五を押してください。` and the start of the next `次の四つの中から` announcement. Previously, the new option count discarded the just-received final choice. Another fixture shows that a partial introduction replaced a complete immutable snapshot between read and selection.

The controller now finishes the old menu before processing the bundled replay introduction. An exactly observed replay prefix can preserve the original unconsumed snapshot and token until its original expiry; it cannot renew the lifetime, retarget a queued digit or create a new token for an incomplete menu. Recognition uses the already-observed counted introduction rather than requiring the recognizer to spell the entire invitation perfectly. Changed counts, new/extended options, quoted speech, human questions, holds, sensitive choices, unknown introductions and expired snapshots still invalidate or block execution. Generic unverified replay introductions no longer preserve a queued selection.

The private conversation metadata retains the last four compact gate results, without raw tokens, transcripts or credentials, so a failed selection is not overwritten by later reads. It is diagnostic only, with no role in OAuth or consent. Full snapshots, audio and private identities remain ignored by git.

## Validation and release

226/226 automated tests passed with no skips, including bundled endings, partial replay prefixes, changed/quoted/unobserved menus, concurrency, sensitive menus and duplicate-command protection. Type checking, 24 legacy plus 29 guarded phone-contract checks, 11 workerd checks, all builds and the preserved production-configuration dry run passed. The production phone Worker, inbound path, Auth/MCP, Telnyx configuration, D1 schema, secret values, authorization controls and quotas remain unchanged. The outbound voice controller is the only deployment target. Original voice version for rollback: `8771fe45-0164-4c28-bcc1-990aa28ede20`.

The owner requested alternating Ginza, Marunouchi and Kawasaki calls for the same product inquiry and conditional free reservation. This intervention uses a first cycle of three, at most six new calls total, and stops early for confirmed availability/reservation or a blocking result. No payments, deposits, purchase obligations, alternative models or invented contact details are authorized. Positive answers must be reported promptly. This is a bounded interactive test run, not a recurring unattended calling schedule.

## First live cycle and follow-up refinement

The first updated Ginza call dispatched exactly one 250 ms tone 30.1 seconds after answer. A separate retranscription of the recorded incoming audio corroborates `お電話を転送しております`: actual menu advancement, not merely a tool request. No operator answered within the fixed three-minute routing lease. The call ended after 219 seconds, with completed controlled farewell and system hangup recorded. No availability or reservation was confirmed.

The following Marunouchi call exposed another segmentation boundary: the first committed fragment of an observed replay retained the snapshot, but its separately committed continuation invalidated it. The compact gate history confirms an issued token followed by `STALE_OR_INCOMPLETE_MENU`; no tone was sent. The 54-second remote completion is a failed task, not successful navigation. The refinement retains a bounded cursor through consecutive committed fragments of the **exact previously observed prefix**. Interim evidence can extend only that committed cursor, expires after one second, and never commits model text. Unknown/quoted speech, changed options or counts, consumed tokens and the original 30-second snapshot expiry still block execution. Repetition never renews expiry. Regression tests reproduce the segmented introduction, queued selection, changed continuation and expiry.

An initial parallel REST retranscription request returned HTTP 429; it was not interpreted as an audio or phone failure and was not repeatedly retried. Later single-request recording analysis succeeded. Live calls retain the unchanged quota and carrier time limits.

The committed-fragment refinement passed 228/228 tests, type checking, the unchanged 24+29 phone-contract checks, all 11 workerd checks and builds before publication. The original single-use/expiry, sensitive-choice, concurrent command and unknown-delivery regressions remain in that suite.

The final gate also discards old advertised digits whenever an unmatching completed menu arrives inside the short transcript merge interval. It preserves an exact replay; it never carries choices from that snapshot into a new menu. The added 100 ms transition fixture and the full 229/229 suite passed, along with type checking and the final production dry run.
