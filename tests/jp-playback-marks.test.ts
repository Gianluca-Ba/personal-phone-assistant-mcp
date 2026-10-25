import { expect, it } from "vitest";
const { PlaybackMarks } = await import(
  new URL("../scripts/jp-playback-marks.mjs", import.meta.url).href
);
const { CallController } = await import(
  new URL("../scripts/jp-call-controller.mjs", import.meta.url).href
);
it("ignores forged, duplicate and clear-echoed marks, including synchronous clear acknowledgement", () => {
  let n = 0;
  const sent: any[] = [],
    played: string[] = [];
  const marks = new PlaybackMarks({
    sendMark: (x: any) => sent.push(x),
    onPlayed: (id: string) => played.push(id),
    token: () => `mark-${++n}`,
  });
  expect(marks.commit("empty", false)).toBeNull();
  const a = marks.commit("farewell", true);
  expect(marks.acknowledge("wrong")).toBe(false);
  marks.clear(() => {
    expect(marks.acknowledge(a)).toBe(false);
  });
  const b = marks.commit("new-farewell", true);
  expect(marks.acknowledge(b)).toBe(true);
  expect(marks.acknowledge(b)).toBe(false);
  expect(played).toEqual(["new-farewell"]);
  expect(sent).toHaveLength(2);
});
it("defaults to requiring an actual current-response playback acknowledgement before closure", async () => {
  let at = 0,
    closed = 0;
  const c = new CallController({
    now: () => at,
    sendDigit: async () => ({ ok: true }),
    close: async () => {
      closed++;
    },
  });
  c.event({ type: "input_audio_buffer.speech_stopped" });
  c.event({ type: "response.created", response: { id: "farewell" } });
  c.event({
    type: "assistant_completed",
    text: "ありがとうございます。失礼いたします。",
  });
  await c.command("close", "finish_call_after_goodbye", {
    outcome: "confirmed",
  });
  at = 10000;
  expect(await c.tick()).toBe(false);
  c.event({ type: "playback_confirmed", responseId: "stale" });
  expect(await c.tick()).toBe(false);
  c.event({ type: "playback_confirmed", responseId: "farewell" });
  expect(await c.tick()).toBe(true);
  expect(closed).toBe(1);
});
