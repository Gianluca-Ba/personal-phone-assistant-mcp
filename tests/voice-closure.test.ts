import { afterEach, expect, it } from "vitest";
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const fixtures: any[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
async function waiting(flux = false) {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    baseline: "その他のご質問は五を押してください。",
    command_id: "mock-routing",
    deadline: f.now() + 45000,
  };
  const interim = (text: string) =>
    f.b.turns.accept(
      flux
        ? { type: "TurnInfo", turn_index: 0, event: "Update", transcript: text }
        : { type: "transcript", transcript: text, is_final: false },
    );
  interim("次、お電話を転送しております。");
  const deadline = f.b.controller.hold.deadline;
  return { ...f, interim, deadline };
}
async function check(b: any) {
  await b.checkDialogue();
  await b.checkDialogue(); // The first tick expires the lease; the next observes an empty queue.
}
async function completeFarewell(f: any, overrides = {}) {
  return f.b.onWebhook({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date(f.now()).toISOString(),
    payload: {
      connection_id: f.b.env.VOICE_APP_ID,
      call_control_id: "mock-call",
      client_state: f.b.context.controlled_closing.state,
      status: "completed",
      ...overrides,
    },
  });
}
const actions = (f: any, action: string) =>
  f.network.filter((n: any) => n.url.endsWith("/" + action));
it.each([false, true])(
  "expires a stale routing-only STT turn without waiting for its late endpoint (Flux=%s)",
  async (flux) => {
    const f = await waiting(flux);
    f.advance(180000);
    f.b.activity.active = true; // Hold music continues; not evidence of human speech.
    f.b.controller.acousticGuardUntil = f.now() + 2000;
    expect(f.b.controller.speaking).toBe(true);
    await check(f.b);
    expect(actions(f, "speak")).toHaveLength(1);
    expect(f.b.context.closure_timing.farewell_requested_at - f.deadline).toBe(
      0,
    );
    expect(f.b.controller.pending.outcome).toBe("unable_to_proceed");
    expect(actions(f, "hangup")).toHaveLength(0);
    await completeFarewell(f, { client_state: "unmatched" });
    f.advance(5000);
    await check(f.b);
    expect(actions(f, "hangup")).toHaveLength(0);
    await completeFarewell(f);
    await check(f.b);
    expect(actions(f, "hangup")).toHaveLength(0); // Preserve the full completed farewell plus quiet margin.
    f.advance(250);
    await check(f.b);
    await check(f.b);
    expect(actions(f, "speak")).toHaveLength(1);
    expect(actions(f, "hangup")).toHaveLength(1);
  },
);
it.each([
  "もしもし",
  "お待たせいたしました。",
  "ご用件をお伺いします。",
  "お電話を転送しております。受付です。",
  "お電話を転送しております。はい、受付です。",
  "お電話を転送しております。在庫を確認します。",
  "聞こえますか？",
  "未確定の発話",
])(
  "preserves an in-flight recipient utterance at the deadline: %s",
  async (text) => {
    const f = await waiting();
    f.advance(179000);
    f.interim(text);
    f.advance(1000);
    await check(f.b);
    f.advance(38000);
    await check(f.b);
    expect(actions(f, "speak")).toHaveLength(0);
    expect(actions(f, "hangup")).toHaveLength(0);
    expect(f.b.controller.routingHoldAudioOnly).toBe(false);
  },
);
it("does not turn a fresh routing replay into stale audio or renew stability for identical updates", async () => {
  const f = await waiting();
  f.advance(179000);
  f.interim("担当者におつなぎしております。");
  f.advance(1000);
  await check(f.b);
  expect(actions(f, "speak")).toHaveLength(0);
  f.advance(3999);
  f.interim("担当者におつなぎしております。");
  await check(f.b);
  expect(actions(f, "speak")).toHaveLength(0);
  f.advance(1);
  await check(f.b);
  expect(actions(f, "speak")).toHaveLength(1);
});
it("withdraws queued farewell immediately for a new greeting in the same stale STT turn", async () => {
  const f = await waiting();
  f.advance(180000);
  const releases: any[] = [];
  const realPersist = f.b.persist.bind(f.b);
  f.b.persist = () => new Promise((r) => releases.push(r));
  await f.b.checkDialogue();
  const starting = f.b.checkDialogue();
  await new Promise((r) => setImmediate(r));
  expect(f.b.context.controlled_closing.cancelled).toBe(false);
  f.interim("もしもし。お待たせいたしました。");
  expect(f.b.context.controlled_closing.cancelled).toBe(true);
  f.b.persist = realPersist;
  // Both the farewell and its cancellation may be persisting.
  for (const release of releases) release();
  await starting;
  await Promise.all(f.jobs.splice(0));
  expect(actions(f, "speak")).toHaveLength(0);
  expect(actions(f, "hangup")).toHaveLength(0);
  await f.recipient("もしもし。ご用件をお伺いします。");
  f.advance(800);
  await f.generate("greeting-response", "はい、聞こえています。");
  expect(f.frames()).toHaveLength(10);
});
it("does not let slow summary metadata delay the actual hangup command", async () => {
  const f = await waiting();
  let release: any, started: any;
  const ready = new Promise((r) => (started = r));
  const provider = f.b.providerFetch;
  f.b.providerFetch = (url: string, init: any) => {
    if (init?.method === "PUT") {
      started();
      return new Promise((r) => (release = () => r(Response.json({}))));
    }
    return provider(url, init);
  };
  const oldWrite = f.b.bindConversation(true);
  await ready;
  await f.b.terminate("unable_to_proceed", "mock-finished-farewell");
  expect(actions(f, "hangup")).toHaveLength(1);
  expect(f.b.ended).toBe(true);
  // Later metadata uses the normal immediate mock; preserve serialization.
  f.b.providerFetch = provider;
  release();
  await oldWrite;
});
it.each(["はい。", "ええ。", "そうですね。"])(
  "retains the first unspoken response across a short listening cue: %s",
  async (cue) => {
    const f = await createOfflineVoiceFixture();
    fixtures.push(f);
    await f.recipient("もしもし。");
    await f.generate("first", "はい、聞こえています。", {
      afterChunk: async () => {
        f.advance(1500);
        await f.recipient(cue);
      },
    });
    expect(f.frames()).toHaveLength(10);
    expect(f.b.context.output_audit.released_responses).toBe(1);
    expect(f.b.context.initial_dialogue_response.started_at).toBe(
      f.now() - 1500,
    );
  },
);
it("does not swallow a yes answering a question already played to the recipient", async () => {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("もしもし。");
  await f.generate("question", "予約なしで購入できますか。");
  for (const mark of [...f.b.marks.pending.keys()]) f.b.marks.acknowledge(mark);
  f.advance(800);
  expect(f.b.controller.assistantQuestionPending).toBe(true);
  expect(f.b.deferInitialBackchannel("はい。")).toBe(false);
  const before = f.b.voice.frames.length;
  await f.recipient("はい。");
  expect(f.b.controller.assistantQuestionPending).toBe(false);
  expect(
    f.b.voice.frames
      .slice(before)
      .some(
        (x: any) =>
          x.item?.role === "user" && x.item.content[0].text === "はい。",
      ),
  ).toBe(true);
});
it("never renews the first-reply listening-cue grace or applies it to later responses", async () => {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("もしもし。");
  await f.generate("expired", "はい、聞こえています。", {
    afterChunk: async () => {
      f.advance(10000);
      await f.recipient("はい。");
    },
  });
  expect(f.frames()).toHaveLength(0);
  expect(f.b.context.initial_dialogue_response.started_at).toBe(
    f.now() - 10000,
  );
  await f.b.onVoice({ type: "response.created", response: { id: "later" } });
  expect(f.b.deferInitialBackchannel("はい。")).toBe(false);
});
