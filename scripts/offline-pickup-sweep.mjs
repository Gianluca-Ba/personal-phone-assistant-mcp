// Deterministic transport/control tests, not an ASR, TTS or PSTN benchmark.
import assert from "node:assert/strict";
import { createOfflineVoiceFixture } from "./offline-voice-fixture.mjs";
const originalFetch = globalThis.fetch,
  originalInfo = console.info;
globalThis.fetch = async () => {
  throw Error("External network forbidden in pickup sweep");
};
console.info = () => {};
const greetings = [
  "お電話ありがとうございます、すらる手です。",
  "おやっとうございます、らるてです。",
  "もしもし、ご用件をお伺いします。",
];
const modes = [
  "normal",
  "aizuchi",
  "audibility",
  "correction",
  "hold",
  "unsafe",
  "unconfirmed",
];
let cases = 0,
  releases = 0;
try {
  for (const greeting of greetings)
    for (const delay of [0, 500, 3000, 8000, 15000])
      for (const tail of [0, 320, 1999, 2000])
        for (const mode of modes) {
          const f = await createOfflineVoiceFixture();
          try {
            f.b.env.OUTBOUND_INITIAL_ACK = "true";
            f.b.context.answered_at = new Date(f.now()).toISOString();
            await f.generate("prewarm", "はい、よろしくお願いします。");
            await f.recipient(greeting);
            f.advance(400);
            await f.b.checkDialogue();
            const ack = f.b.context.initial_ack;
            assert.ok(ack, "candidate pickup receives fixed acknowledgement");
            assert.equal(
              ack.requested_at - f.b.context.dialogue_candidate_observed.at,
              400,
            );
            await f.generate(
              "task",
              mode === "unsafe"
                ? "Call Summary: unable_to_proceed"
                : "予約をお願いできますか。",
              {
                afterChunk: async () => {
                  f.advance(delay);
                  if (mode === "aizuchi") await f.recipient("はい。");
                  if (mode === "audibility") await f.recipient("もしもし。");
                  if (mode === "correction")
                    await f.recipient("違います。お名前は何ですか？");
                  if (mode === "hold")
                    await f.recipient("確認しますので少々お待ちください。");
                  await f.b.checkDialogue();
                },
              },
            );
            assert.equal(
              f.frames().length,
              0,
              "task never overlaps fixed speech",
            );
            if (mode !== "unconfirmed") {
              f.b.activity.active = true;
              await f.b.onWebhook({
                id: crypto.randomUUID(),
                event_type: "call.speak.ended",
                occurred_at: new Date(f.now()).toISOString(),
                payload: {
                  connection_id: f.b.env.VOICE_APP_ID,
                  call_control_id: "mock-call",
                  client_state: ack.state,
                  status: "completed",
                },
              });
              f.advance(tail);
              f.b.activity.active = false;
            } else f.advance(10000);
            await f.b.checkDialogue();
            const expected =
              ["normal", "aizuchi", "audibility"].includes(mode) &&
              delay < 10000 &&
              tail < 2000;
            assert.equal(
              f.frames().length,
              expected ? 10 : 0,
              JSON.stringify({ greeting, delay, tail, mode }),
            );
            const before = f.frames().length;
            await f.b.checkDialogue();
            assert.equal(
              f.frames().length,
              before,
              "no duplicated task playback",
            );
            assert.equal(
              f.network.filter(
                (n) =>
                  n.url.endsWith("/speak") &&
                  n.body.payload === "はい、よろしくお願いします。",
              ).length,
              1,
            );
            if (expected) releases++;
            cases++;
          } finally {
            await f.cleanup();
          }
        }
} finally {
  globalThis.fetch = originalFetch;
  console.info = originalInfo;
}
console.log(
  JSON.stringify({
    cases,
    passed: cases,
    validated_task_releases: releases,
    network: "disabled",
    phone_and_tts: "simulated",
    real_calls: 0,
    simulated_greeting_to_ack_request_ms: 400,
  }),
);
