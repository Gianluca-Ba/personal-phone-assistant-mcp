import { afterEach, expect, it } from "vitest";
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const fixtures: any[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const actions = (f: any, name: string) =>
  f.network.filter((call: any) => call.url.endsWith("/" + name));

it.each([
  "はい、アピットオートバックス東雲です。",
  "はい、A PIT AUTOBACS SHINONOMEです。",
  "ハピートオトバックス調整点です。",
])(
  "replays silent AUTOBACS startup and releases the first verified question only after a usable pickup: %s",
  async (greeting) => {
    const f = await createOfflineVoiceFixture({
      destination: "+81335280357",
      instructions:
        "Ask only whether two spectators may attend today's event on foot without an Abarth car. Do not book or make commitments.",
    });
    fixtures.push(f);
    f.b.env.OUTBOUND_INITIAL_ACK = "true";
    f.b.context.answered_at = new Date(f.now()).toISOString();
    const question = "今日のイベントは車なしで二人が見学できますか。";

    await f.recipient("。");
    await f.generate("unheard-before-pickup", question);
    await f.b.checkDialogue();
    expect(f.b.context.dialogue_candidate_observed).toBeNull();
    expect(f.frames()).toHaveLength(0);
    expect(actions(f, "speak")).toHaveLength(0);

    await f.recipient(greeting);
    expect(f.b.context.dialogue_candidate_observed).not.toBeNull();
    f.advance(400);
    await f.b.checkDialogue();
    expect(actions(f, "speak")).toHaveLength(1);
    const ackState = actions(f, "speak")[0].body.client_state;
    await f.generate("after-live-pickup", question);
    expect(f.frames()).toHaveLength(0);

    await f.b.onWebhook({
      id: crypto.randomUUID(),
      event_type: "call.speak.ended",
      occurred_at: new Date(f.now()).toISOString(),
      payload: {
        connection_id: f.b.env.VOICE_APP_ID,
        call_control_id: "mock-call",
        client_state: ackState,
        status: "completed",
      },
    });
    expect(f.frames()).toHaveLength(10);
    expect(f.b.context.output_audit.released_responses).toBe(1);
    expect(f.b.context.latest_task_request.playback_completed_at).toBeNull();
    expect(f.b.context.latest_task_request.recipient_answer_at).toBeNull();
    const mark = f.b.marks.byResponse.get("after-live-pickup");
    expect(f.b.marks.acknowledge(mark)).toBe(true);
    expect(f.b.context.latest_task_request.playback_completed_at).toBe(f.now());
    expect(f.b.context.latest_task_request.recipient_answer_at).toBeNull();
    await f.recipient("二名でも徒歩でご参加いただけます。");
    expect(f.b.context.latest_task_request.recipient_answer_at).toBe(f.now());

    await f.b.onVoice({
      type: "response.done",
      response: { id: "after-live-pickup", status: "completed" },
    });
    expect(f.frames()).toHaveLength(10);
    expect(actions(f, "speak")).toHaveLength(1);
    expect(actions(f, "hangup")).toHaveLength(0);
    expect(actions(f, "send_dtmf")).toHaveLength(0);
    expect(
      f.network.some(
        (call: any) => call.url === "https://api.telnyx.com/v2/calls",
      ),
    ).toBe(false);
  },
);
