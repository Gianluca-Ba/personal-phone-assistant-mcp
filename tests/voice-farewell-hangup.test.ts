import { afterEach, expect, it } from "vitest";
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const { isClosingAcknowledgement, isHoldRequest } = await import(
  new URL("../scripts/jp-backchannel.mjs", import.meta.url).href
);
const fixtures: any[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const actions = (f: any, action: string) =>
  f.network.filter((n: any) => n.url.endsWith("/" + action));

it.each([
  "ちょっと確認します、お待ちくださ",
  "少々お待ちくいませ。",
  "待ってくださ。",
])(
  "blocks the observed premature closure for an ASR-truncated waiting request: %s",
  async (text) => {
    const f = await createOfflineVoiceFixture();
    fixtures.push(f);
    await f.recipient("もしもし。ご用件をお伺いします。");
    await f.recipient(text);
    expect(f.b.controller.hold).not.toBeNull();
    const deadline = f.b.controller.hold.deadline;
    f.advance(13000);
    const result = await f.b.controller.command(
      "premature-model-close",
      "finish_call_after_goodbye",
      { outcome: "unable_to_proceed" },
    );
    expect(result).toEqual({ ok: false, reason: "HOLD_OR_QUESTION_PENDING" });
    await f.b.checkDialogue();
    expect(actions(f, "speak")).toHaveLength(0);
    expect(actions(f, "hangup")).toHaveLength(0);
    await f.recipient(text);
    expect(f.b.controller.hold.deadline).toBe(deadline);
    await f.recipient("お待たせしました。在庫はありません。");
    expect(f.b.controller.hold).toBeNull();
    f.advance(800);
    await f.generate("restock-question", "次回の入荷予定は分かりますか。");
    expect(f.frames().length).toBeGreaterThan(0);
  },
);
it("does not infer a new truncated hold from a quotation, negation or unrelated word", () => {
  for (const text of [
    "『お待ちくださ』という録音です。",
    "お待ちくださらなくても結構です。",
    "お待ちくださる必要はありません。",
    "確認は不要です。",
    "お待ちくださ？",
  ])
    expect(isHoldRequest(text), text).toBe(false);
});
async function closing(outcome = "unable_to_proceed") {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("もしもし。ご用件をお伺いします。");
  if (outcome === "confirmed") {
    f.advance(800);
    await f.generate(
      "settled-restock-question",
      "次回の入荷予定は分かりますか。",
    );
    f.advance(250);
    for (const name of [...f.b.marks.pending.keys()])
      f.b.marks.acknowledge(name);
  }
  await f.recipient("入荷予定は未定です。");
  await f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      call_id: "settled-task",
      name: "finish_call_after_goodbye",
      arguments: JSON.stringify({ outcome }),
    },
  });
  f.advance(1000);
  await f.b.checkDialogue();
  expect(actions(f, "speak")).toHaveLength(1);
  return f;
}
function complete(f: any, overrides = {}, id = crypto.randomUUID()) {
  return f.b.onWebhook({
    id,
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
it.each(["confirmed", "refused", "wrong_number", "unable_to_proceed"])(
  "retains a completed farewell across the observed final courtesy and hangs up once (%s)",
  async (outcome) => {
    const f = await closing(outcome);
    f.advance(3500);
    await complete(f);
    const farewellAt = f.b.context.closure_timing.farewell_completed_at;
    f.advance(100);
    await f.recipient("はい、恐れ入ります。失礼いします。");
    f.advance(749);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(0);
    f.advance(1);
    await Promise.all([f.b.checkDialogue(), f.b.checkDialogue()]);
    expect(f.b.context.controlled_closing.cancelled).toBe(false);
    expect(f.b.context.system_farewell_played).toBe(true);
    expect(f.b.context.closure_timing.farewell_completed_at).toBe(farewellAt);
    expect(actions(f, "playback_stop")).toHaveLength(0);
    expect(actions(f, "speak")).toHaveLength(1);
    expect(actions(f, "hangup")).toHaveLength(1);
    expect(f.b.context.close_outcome).toBe(
      outcome === "confirmed" ? "unspecified" : outcome,
    );
  },
);

it("accepts only whole closing courtesies, never a task, question or quoted goodbye", () => {
  for (const text of [
    "はい、恐れ入ります。失礼いします。",
    "ありがとうございます。失礼いたします。",
    "ええ。こちらこそ。",
    "では、失礼します。",
    "承知しました。ありがとうございました。",
    "すみません。", // An apology alone can preface a correction: remain conservative.
  ])
    expect(isClosingAcknowledgement(text), text).toBe(text !== "すみません。");
  for (const text of [
    "",
    "失礼",
    "はい、恐れ入りますが",
    "はい、でも在庫はあります。",
    "失礼します。その前に一つ質問があります。",
    "ありがとうございます、明日ですか？",
    "少々お待ちください。",
    "はい、予約を変更してください。",
    "恐れ入りますが、訂正です。",
    "『失礼します』と伝えてください。",
    "ありがとうございました。1個でお願いします。",
    "失礼しますか",
    "失礼します?",
    "ありがとうございます。".repeat(40),
  ])
    expect(isClosingAcknowledgement(text), text).toBe(false);
});

it.each([false, true])(
  "waits for a long final recipient turn even when farewell completes mid-turn (Flux=%s)",
  async (flux) => {
    const f = await closing();
    const before = f.b.voice.frames.filter(
      (x: any) => x.item?.role === "user",
    ).length;
    f.b.activity.active = true;
    f.b.turns.accept(
      flux
        ? {
            type: "TurnInfo",
            turn_index: 12,
            event: "Update",
            transcript: "はい、恐れ入ります。",
          }
        : { transcript: "はい、恐れ入ります。", start: 12, is_final: false },
    );
    f.advance(3500);
    await complete(f);
    f.advance(10000);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(0);
    expect(actions(f, "playback_stop")).toHaveLength(0);
    f.b.activity.active = false;
    f.b.turns.accept(
      flux
        ? {
            type: "TurnInfo",
            turn_index: 12,
            event: "EndOfTurn",
            transcript: "はい、恐れ入ります。失礼いします。",
          }
        : {
            transcript: "はい、恐れ入ります。失礼いします。",
            start: 12,
            is_final: true,
            speech_final: true,
          },
    );
    await Promise.all(f.jobs.splice(0));
    expect(
      f.b.voice.frames.filter((x: any) => x.item?.role === "user"),
    ).toHaveLength(before);
    f.advance(749);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(0);
    f.advance(1);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(1);
    expect(actions(f, "speak")).toHaveLength(1);
  },
);

it("never treats a courtesy as proof the system farewell finished", async () => {
  const f = await closing();
  await f.recipient("ありがとうございます。失礼します。");
  f.advance(5000);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  await complete(f, { status: "interrupted" });
  await complete(f, { client_state: "not-the-farewell-state" });
  expect(
    (await complete(f, { connection_id: "other-connection" })).status,
  ).toBe(403);
  f.advance(5000);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  await complete(f);
  f.advance(249);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  f.advance(1);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
});

it("does not close over acoustic speech even when STT has already finalized a courtesy", async () => {
  const f = await closing();
  f.advance(3500);
  await complete(f);
  await f.recipient("ありがとうございます。");
  f.b.activity.active = true;
  f.advance(6000);
  await f.b.checkDialogue();
  expect(f.b.controller.speaking).toBe(false);
  expect(actions(f, "hangup")).toHaveLength(0);
  f.b.activity.active = false;
  f.b.controller.acousticGuardUntil = f.now() + 320;
  f.advance(319);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  f.advance(1);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
});

it.each([
  "すみません、何時ですか？",
  "はい、ちょっと待ってください。",
  "失礼します。その前に訂正があります。",
  "未確定の発話",
])(
  "reopens dialogue for real or unclassified speech, ignoring the cancelled generation's late callback: %s",
  async (text) => {
    const f = await closing();
    const oldState = f.b.context.controlled_closing.state;
    await f.recipient(text);
    expect(f.b.context.controlled_closing.cancelled).toBe(true);
    expect(f.b.context.controlled_close_requested).toBe(false);
    expect(actions(f, "playback_stop")).toHaveLength(1);
    await complete(f, { client_state: oldState });
    f.advance(10000);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(0);
    expect(
      f.b.voice.frames.some(
        (x: any) => x.item?.role === "user" && x.item.content[0].text === text,
      ),
    ).toBe(true);
  },
);

it("does not trust a harmless interim when a later clause reopens the task", async () => {
  const f = await closing();
  f.advance(3500);
  await complete(f);
  f.b.turns.accept({
    transcript: "はい、ありがとうございます。",
    start: 20,
    is_final: false,
  });
  f.advance(5000);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(0);
  f.b.turns.accept({
    transcript: "はい、ありがとうございます。その前に質問があります。",
    start: 20,
    is_final: true,
    speech_final: true,
  });
  await Promise.all(f.jobs.splice(0));
  f.advance(2000);
  await f.b.checkDialogue();
  expect(f.b.context.controlled_closing.cancelled).toBe(true);
  expect(actions(f, "hangup")).toHaveLength(0);
});

it("does not lose completion when recipient speech ends while its callback is persisting", async () => {
  const f = await closing();
  const persist = f.b.persist.bind(f.b);
  let release: any;
  f.b.persist = () =>
    f.b.context.system_farewell_played
      ? new Promise((r) => {
          release = r;
        })
      : persist();
  const completion = complete(f);
  // Let callback verification reach the storage await.
  while (!release) await new Promise((r) => setImmediate(r));
  expect(f.b.controller.farewell).not.toBeNull();
  f.b.persist = persist;
  await f.recipient("はい、恐れ入ります。失礼します。");
  release();
  await completion;
  f.advance(750);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
});

it("ignores duplicate completed callbacks without moving the original playback boundary", async () => {
  const f = await closing();
  f.advance(3500);
  await Promise.all([complete(f), complete(f)]);
  const at = f.b.context.closure_timing.farewell_completed_at;
  await f.recipient("失礼いたします。");
  f.advance(750);
  await complete(f);
  expect(f.b.context.closure_timing.farewell_completed_at).toBe(at);
  await Promise.all([f.b.checkDialogue(), f.b.checkDialogue()]);
  expect(actions(f, "hangup")).toHaveLength(1);
});

it("hangs up after completed farewell and quiet without waiting for the recipient to answer", async () => {
  const f = await closing();
  f.advance(3500);
  await complete(f);
  f.advance(250);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
});

it("does not let suppressed model narration reopen a completed system farewell", async () => {
  const f = await closing();
  f.advance(3500);
  await complete(f);
  await f.generate(
    "unspoken-report",
    "（システムが失礼いたしますと発言します）",
  );
  expect(f.frames()).toHaveLength(0);
  f.advance(250);
  await f.b.checkDialogue();
  expect(actions(f, "hangup")).toHaveLength(1);
});

it("forwards the same courtesy normally before any closing request", async () => {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("ありがとうございます。失礼します。");
  expect(f.b.closingAcknowledgement("ありがとうございます。失礼します。")).toBe(
    false,
  );
  expect(f.b.voice.frames.some((x: any) => x.item?.role === "user")).toBe(true);
  expect(actions(f, "hangup")).toHaveLength(0);
});

it.each(["はい、失礼します。", "その前に質問があります。"])(
  "rechecks late recipient speech before dispatching the reserved hangup: %s",
  async (text) => {
    const f = await closing();
    f.advance(3500);
    await complete(f);
    f.advance(250);
    const voiceAPI = f.b.voiceAPI.bind(f.b);
    let release: any;
    f.b.voiceAPI = async (...args: any[]) => {
      if (args[0] === "hangup")
        await new Promise((r) => {
          release = r;
        });
      return voiceAPI(...args);
    };
    const stopping = f.b.checkDialogue();
    while (!release) await new Promise((r) => setImmediate(r));
    expect(f.b.controller.closing).toBe(true);
    await f.recipient(text);
    f.b.voiceAPI = voiceAPI;
    release();
    await stopping;
    expect(actions(f, "hangup")).toHaveLength(0);
    expect(f.b.controller.closing).toBe(false);
    f.advance(750);
    await f.b.checkDialogue();
    expect(actions(f, "hangup")).toHaveLength(text.startsWith("はい") ? 1 : 0);
  },
);

it("never retries a hangup whose carrier outcome is unknown", async () => {
  const f = await closing();
  f.advance(3500);
  await complete(f);
  f.advance(250);
  const provider = f.b.providerFetch;
  let attempts = 0;
  f.b.providerFetch = (url: string, init: any) => {
    if (url.endsWith("/hangup")) {
      attempts++;
      throw Error("Simulated lost network response");
    }
    return provider(url, init);
  };
  await expect(f.b.checkDialogue()).rejects.toThrow("Hangup unconfirmed");
  await f.b.checkDialogue();
  expect(attempts).toBe(1);
  expect(f.b.controller.pending).toBeNull();
});
