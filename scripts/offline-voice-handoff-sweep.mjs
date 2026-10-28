// Constructed, network-disabled handoff/closure timing matrix, not a PSTN or
// model benchmark. Every audio response, playback callback and API is simulated.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createOfflineVoiceFixture } from "./offline-voice-fixture.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((s) => s.split("=")));
const greetings = [
  "もしもし。",
  "Apple川崎店舗案内でございます。",
  "お待たせいたしました。ご用件をお伺いします。",
  "お電話を転送しております。もしもし。",
  "お電話を転送しております。お電話ありがとうございます。アップル川崎です。",
];
const delays = [0, 1500, 4000, 6500, 8000];
const tails = [0, 100, 320, 750, 1999, 2000, 2500];
const modes = [
  "steady",
  "aizuchi",
  "audibility",
  "question",
  "hold",
  "superseded",
  "unsafe",
];
const results = [];
const firstReply = "はい、聞こえています。";
const route = "次、お電話を転送しております。";
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("External network forbidden in handoff sweep");
};
const voiceActions = (f, a) => f.network.filter((n) => n.url.endsWith("/" + a));
const check = async (f) => {
  await f.b.checkDialogue();
  await f.b.checkDialogue();
};
const complete = (f, state) =>
  f.b.onWebhook({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date(f.now()).toISOString(),
    payload: {
      connection_id: f.b.env.VOICE_APP_ID,
      call_control_id: "mock-call",
      client_state: state,
      status: "completed",
    },
  });
try {
  for (const [g, greeting] of greetings.entries())
    for (const delay of delays)
      for (const tail of tails)
        for (const mode of modes) {
          const f = await createOfflineVoiceFixture();
          const result = {
            suite: "first_reply",
            greeting: g,
            simulated_generation_ms: delay,
            acoustic_tail_ms: tail,
            mode,
          };
          try {
            if (g >= 2) {
              f.b.context.ivr_progress = {
                state: "awaiting_transition",
                command_id: "mock",
                baseline: "その他のご質問は五を押してください。",
                deadline: f.now() + 45000,
              };
              f.b.observeRoutingInterim(route);
            }
            await f.recipient(greeting);
            f.b.activity.active = true;
            await f.generate(
              "first",
              mode === "unsafe"
                ? "Call Summary: unable_to_proceed"
                : firstReply,
              {
                afterChunk: async () => {
                  f.advance(delay);
                  if (mode === "aizuchi") await f.recipient("はい。");
                  if (mode === "audibility")
                    await f.recipient("お声は届いておりますでしょうか？");
                },
              },
            );
            const doneAt = f.now();
            assert.equal(
              f.frames().length,
              0,
              "never emit over current activity or before completed validation",
            );
            if (mode === "question")
              await f.recipient("違います。ご予約の変更でしょうか？");
            if (mode === "hold")
              await f.recipient("確認しますので少々お待ちください。");
            if (mode === "superseded")
              await f.b.onVoice({
                type: "response.created",
                response: { id: "newer" },
              });
            f.advance(tail);
            f.b.activity.active = false;
            await check(f);
            const expected =
              ["steady", "aizuchi", "audibility"].includes(mode) && tail < 2000;
            assert.equal(f.frames().length, expected ? 10 : 0);
            assert.equal(
              f.b.context.output_audit.released_responses,
              expected ? 1 : 0,
            );
            if (expected) {
              assert.equal(f.b.responses.get("first").text, firstReply);
              assert.equal(f.b.responses.get("first").rendered, 3200);
              result.synthetic_completion_to_release_ms = f.now() - doneAt;
              for (const mark of [...f.b.marks.pending.keys()])
                f.b.marks.acknowledge(mark);
            }
            await f.b.onVoice({
              type: "response.done",
              response: { id: "first", status: "completed" },
            });
            f.advance(3000);
            await check(f);
            assert.equal(
              f.frames().length,
              expected ? 10 : 0,
              "no duplicate or expired audio delivery",
            );
            assert.equal(voiceActions(f, "send_dtmf").length, 0);
            assert.equal(voiceActions(f, "hangup").length, 0);
            result.expected_release = expected;
            result.pass = true;
          } catch (e) {
            result.pass = false;
            result.error = e.message;
          } finally {
            await f.cleanup();
          }
          results.push(result);
        }
  for (const flux of [false, true])
    for (const update of ["unchanged", "music", "human", "unknown"])
      for (const lateBy of [0, 1, 20, 49])
        for (const playbackMs of [1000, 4000, 8000]) {
          const f = await createOfflineVoiceFixture();
          const result = {
            suite: "routing_closure",
            flux,
            update,
            timer_jitter_ms: lateBy,
            simulated_farewell_ms: playbackMs,
          };
          try {
            f.b.context.ivr_progress = {
              state: "awaiting_transition",
              command_id: "mock",
              baseline: "その他のご質問は五を押してください。",
              deadline: f.now() + 45000,
            };
            const interim = (text) =>
              f.b.turns.accept(
                flux
                  ? {
                      type: "TurnInfo",
                      turn_index: 0,
                      event: "Update",
                      transcript: text,
                    }
                  : { type: "transcript", transcript: text, is_final: false },
              );
            interim(route);
            const deadline = f.b.controller.hold.deadline;
            f.advance(170000);
            if (update === "music") interim("[Music]");
            if (update === "human") interim("もしもし。受付です。");
            if (update === "unknown") interim("未確定の発話");
            f.advance(10000 + lateBy);
            f.b.activity.active = true;
            f.b.controller.acousticGuardUntil = f.now() + 2000;
            await check(f);
            const expected = ["unchanged", "music"].includes(update);
            assert.equal(voiceActions(f, "speak").length, expected ? 1 : 0);
            assert.equal(voiceActions(f, "hangup").length, 0);
            if (expected) {
              result.deadline_to_farewell_request_ms =
                f.b.context.closure_timing.farewell_requested_at - deadline;
              assert.equal(result.deadline_to_farewell_request_ms, lateBy);
              const state = f.b.context.controlled_closing.state;
              f.advance(playbackMs);
              await check(f);
              assert.equal(
                voiceActions(f, "hangup").length,
                0,
                "never infer farewell completion from elapsed time",
              );
              await complete(f, "foreign-callback");
              await check(f);
              assert.equal(voiceActions(f, "hangup").length, 0);
              await complete(f, state);
              f.advance(249);
              await check(f);
              assert.equal(voiceActions(f, "hangup").length, 0);
              f.advance(1);
              await check(f);
              result.completion_to_hangup_ms =
                f.b.context.closure_timing.hangup_requested_at -
                f.b.context.closure_timing.farewell_completed_at;
              assert.equal(result.completion_to_hangup_ms, 250);
              assert.equal(voiceActions(f, "hangup").length, 1);
              assert.equal(voiceActions(f, "speak").length, 1);
            }
            result.pass = true;
          } catch (e) {
            result.pass = false;
            result.error = e.message;
          } finally {
            await f.cleanup();
          }
          results.push(result);
        }
} finally {
  globalThis.fetch = realFetch;
}
const report = {
  count: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  first_reply_cases: results.filter((r) => r.suite === "first_reply").length,
  routing_closure_cases: results.filter((r) => r.suite === "routing_closure")
    .length,
  expected_first_replies: results.filter((r) => r.expected_release === true)
    .length,
  max_synthetic_completion_to_release_ms: Math.max(
    ...results.map((r) => r.synthetic_completion_to_release_ms ?? 0),
  ),
  max_deadline_to_farewell_request_ms: Math.max(
    ...results.map((r) => r.deadline_to_farewell_request_ms ?? 0),
  ),
  real_calls: 0,
  external_api_requests: 0,
  results,
};
if (args.output)
  writeFileSync(args.output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
if (report.failed) {
  console.error(
    JSON.stringify(results.filter((r) => !r.pass).slice(0, 12), null, 2),
  );
  process.exitCode = 1;
}
