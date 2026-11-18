import { afterEach, expect, it } from "vitest";
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const fixtures: any[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const actions = (f: any, name: string) =>
  f.network.filter((n: any) => n.url.endsWith("/" + name));
const clarification = "もしもし、もう一度お願いできますか。";

async function startup() {
  const f = await createOfflineVoiceFixture({
    destination: "+81335280357",
    instructions: "Ask whether two pedestrians can visit the authorized event.",
  });
  fixtures.push(f);
  f.b.env.OUTBOUND_INITIAL_ACK = "true";
  f.b.context.answered_at = new Date(f.now()).toISOString();
  f.b.context.dialogue_candidate_observed = null;
  f.chunk = 0;
  return f;
}
async function carrier(f: any, voiced = false) {
  const bytes = Buffer.alloc(160, voiced ? 0 : 255);
  await f.b.onMedia({
    event: "media",
    stream_id: "mock-stream",
    media: {
      track: "inbound",
      chunk: f.chunk++,
      payload: bytes.toString("base64"),
    },
  });
  f.b.activity.observe(bytes);
}
async function unclearPickup(f: any, transcript = "。") {
  await carrier(f, true);
  f.b.turns.accept({
    transcript,
    is_final: false,
    start: f.chunk,
  });
  f.advance(400);
  await carrier(f);
  f.b.turns.accept({
    transcript,
    is_final: true,
    speech_final: true,
    start: f.chunk - 1,
    duration: 0.4,
  });
  await Promise.all(f.jobs.splice(0));
}
async function eligible(f: any) {
  f.advance(1000);
  await carrier(f);
  await f.b.checkDialogue();
  await Promise.all(f.jobs.splice(0));
}
async function completed(f: any, state: string, overrides = {}) {
  return f.b.onWebhook({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date(f.now()).toISOString(),
    payload: {
      connection_id: f.b.env.VOICE_APP_ID,
      call_control_id: "mock-call",
      client_state: state,
      status: "completed",
      ...overrides,
    },
  });
}

it("replays punctuation-only AUTOBACS pickup with one neutral clarification and keeps task audio gated", async () => {
  const f = await startup();
  await unclearPickup(f);
  expect(f.b.context.pickup_clarification).toBeTruthy();
  await f.generate("unheard-task", "二人で見学できますか。");
  expect(f.frames()).toHaveLength(0);
  f.advance(999);
  await carrier(f);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
  f.advance(1);
  await carrier(f);
  await f.b.checkDialogue();
  const [probe] = actions(f, "speak");
  expect(probe.body.payload).toBe(clarification);
  expect(f.b.context.dialogue_candidate_observed).toBeNull();
  expect(f.b.context.latest_task_request?.released_at).toBeFalsy();
  expect(f.frames()).toHaveLength(0);
  await completed(f, probe.body.client_state);
  expect(f.b.context.attention.completed).toBe(true);
  expect(f.b.context.output_audit?.completed_task_speech ?? 0).toBe(0);
  await unclearPickup(f);
  await eligible(f);
  await f.generate("still-no-dialogue", "予約は必要ですか。");
  expect(actions(f, "speak")).toHaveLength(1);
  expect(f.frames()).toHaveLength(0);
  expect(f.b.context.dialogue_candidate_observed).toBeNull();
  expect(actions(f, "send_dtmf")).toHaveLength(0);
});

it("opens task dialogue only after the recipient answers the neutral clarification with a recognized turn", async () => {
  const f = await startup();
  await unclearPickup(f);
  await eligible(f);
  const probe = actions(f, "speak")[0];
  await completed(f, probe.body.client_state);
  await f.recipient("もしもし、ご用件をお伺いします。");
  expect(f.b.context.dialogue_candidate_observed).toBeTruthy();
  f.advance(1000);
  await f.b.checkDialogue();
  const ack = actions(f, "speak").find(
    (n: any) => n.body.payload === "はい、よろしくお願いします。",
  );
  if (ack) await completed(f, ack.body.client_state);
  await f.generate("actual-task", "車なしで二人が見学できますか。");
  expect(f.frames().length).toBeGreaterThan(0);
  expect(f.b.context.output_audit.released_responses).toBe(1);
});

it.each([
  "その他のご質問は五を押してください。",
  "少々お待ちください。",
  "ただいま担当者におつなぎしております。そのままお待ちください。",
  "本日の営業は終了しました。",
  "暗証番号を入力してください。",
  "A PIT AUTOBACS SHINONOMEにお電話いただきありがとうございます。",
])(
  "does not use pickup clarification after known protected input: %s",
  async (text) => {
    const f = await startup();
    await f.recipient(text);
    await unclearPickup(f);
    await eligible(f);
    expect(
      actions(f, "speak").filter((n: any) => n.body.payload === clarification),
    ).toHaveLength(0);
    expect(f.frames()).toHaveLength(0);
  },
);

it("requires actual received acoustic speech and current carrier media before clarification", async () => {
  const f = await startup();
  await f.recipient("。");
  f.advance(3000);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
  await unclearPickup(f);
  f.advance(5000);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
});

it("keeps a known recorded welcome protected when the recognizer later emits only punctuation", async () => {
  const f = await startup();
  await f.recipient(
    "A PIT AUTOBACS SHINONOMEにお電話いただきありがとうございます。",
  );
  f.advance(1500);
  await unclearPickup(f);
  await eligible(f);
  expect(
    actions(f, "speak").filter((n: any) => n.body.payload === clarification),
  ).toHaveLength(0);
});

it("closes bounded unresolved pickup only after clarification and farewell playback complete", async () => {
  const f = await startup();
  await unclearPickup(f);
  await eligible(f);
  const probe = actions(f, "speak")[0];
  await completed(f, probe.body.client_state);
  await unclearPickup(f);
  f.advance(14999);
  await carrier(f);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(1);
  f.advance(1);
  await carrier(f);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  expect(f.b.context.dialogue_candidate_observed).toBeNull();
  expect(actions(f, "speak")).toHaveLength(2);
  const farewell = actions(f, "speak")[1];
  expect(farewell.body.payload).toBe("ありがとうございます。失礼いたします。");
  expect(actions(f, "hangup")).toHaveLength(0);
  f.advance(3000);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  await completed(f, farewell.body.client_state);
  f.advance(250);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
  expect(f.b.context.close_outcome).toBe("unable_to_proceed");
  expect(f.frames()).toHaveLength(0);
});

it("permits one neutral clarification after an acoustically complete turn with no recognized text", async () => {
  const f = await startup();
  await carrier(f, true);
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "mock-recognizer",
    turn_index: 1,
    event: "StartOfTurn",
    transcript: "",
  });
  f.advance(400);
  await carrier(f);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "mock-recognizer",
    turn_index: 1,
    event: "EndOfTurn",
    transcript: "",
  });
  await eligible(f);
  expect(actions(f, "speak")).toHaveLength(0);
  f.advance(600);
  await carrier(f);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(1);
  expect(actions(f, "speak")[0].body.payload).toBe(clarification);
  expect(f.b.context.dialogue_candidate_observed).toBeNull();
  expect(f.frames()).toHaveLength(0);
  expect(
    f.b.voice.frames.some((frame: any) => frame.item?.role === "user"),
  ).toBe(false);
});

it("cancels the original clarification when a new acoustic turn begins", async () => {
  const f = await startup();
  await unclearPickup(f);
  f.advance(1000);
  await carrier(f, true);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
  f.advance(400);
  await carrier(f);
  f.advance(2000);
  await carrier(f);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(0);
});

it("accepts only a successful same-call completion for clarification", async () => {
  const f = await startup();
  await unclearPickup(f);
  await eligible(f);
  const probe = actions(f, "speak")[0];
  expect(probe).toBeTruthy();
  const state = JSON.parse(
    Buffer.from(probe.body.client_state, "base64").toString(),
  );
  const foreign = Buffer.from(
    JSON.stringify({ ...state, nonce: crypto.randomUUID() }),
  ).toString("base64");
  expect((await completed(f, foreign)).status).toBe(403);
  await expect(
    completed(f, probe.body.client_state, { call_control_id: "other-call" }),
  ).rejects.toThrow("Call identity conflict");
  await completed(
    f,
    Buffer.from(
      JSON.stringify({ ...state, token: crypto.randomUUID() }),
    ).toString("base64"),
  );
  expect(f.b.context.attention.completed).toBe(false);
  await completed(f, probe.body.client_state, { status: "failed" });
  expect(f.b.context.attention.completed).toBe(false);
  await completed(f, probe.body.client_state);
  expect(f.b.context.attention.completed).toBe(true);
});

it("rechecks recipient speech after the durable reservation and never dispatches a stale clarification", async () => {
  const f = await startup();
  await unclearPickup(f);
  const voiceAPI = f.b.voiceAPI.bind(f.b);
  f.b.voiceAPI = (name: string, body: any, op: string, permitted: any) =>
    voiceAPI(
      name,
      body,
      op,
      name === "speak"
        ? () => {
            f.b.activity.observe(Buffer.alloc(160));
            f.b.beginTurn();
            return permitted();
          }
        : permitted,
    );
  await eligible(f);
  expect(actions(f, "speak")).toHaveLength(0);
  expect(f.b.context.dialogue_candidate_observed).toBeNull();
  expect(f.frames()).toHaveLength(0);
});
