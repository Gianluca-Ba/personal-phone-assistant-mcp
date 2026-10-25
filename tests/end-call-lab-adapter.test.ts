import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const { CallController } = await import(
  new URL("../scripts/jp-call-controller.mjs", import.meta.url).href
);
const { forwardLabRecipientEvent: forward } = await import(
  new URL("../scripts/jp-lab-turns.mjs", import.meta.url).href
);
const source = readFileSync("scripts/jp-end-call-simulate.mjs", "utf8");
const transcript = (text: string) => ({
  type: "conversation.item.input_audio_transcription.completed",
  transcript: text,
});
function controller() {
  const c = new CallController({
    now: () => 1000,
    sendDigit: async () => ({ ok: true }),
    close: async () => {},
  });
  c.event({
    type: "assistant_completed",
    text: "18時でよろしいですか。",
    no_audio: false,
  });
  return c;
}
it("clears the lab's pending question only for a real non-overlapping answer", () => {
  const c = controller();
  expect(c.assistantQuestionPending).toBe(true);
  forward(c, { type: "input_audio_buffer.speech_stopped" });
  expect(c.assistantQuestionPending).toBe(true);
  forward(c, transcript("  "));
  expect(c.assistantQuestionPending).toBe(true);
  forward(c, transcript("はい。"), { overlapped: false });
  expect(c.assistantQuestionPending).toBe(false);
});
it("preserves an unanswered question on overlapping aizuchi but accepts a genuine correction", () => {
  const c = controller();
  forward(c, transcript("ええ。"), { overlapped: true });
  expect(c.assistantQuestionPending).toBe(true);
  forward(c, transcript("いいえ、17時です。"), { overlapped: true });
  expect(c.assistantQuestionPending).toBe(false);
});
it("accepts a prompt answer near the end of question playback without fabricating a transcript", () => {
  const events: any[] = [];
  const c = { event: (event: any) => events.push(event) };
  const actual = transcript("はい。");
  forward(c, actual, { overlapped: true, answerWindow: true });
  expect(events).toEqual([actual, { type: "recipient_answer" }]);
  expect(
    events.filter((event) => typeof event.transcript === "string"),
  ).toHaveLength(1);
  expect(events[0]).toBe(actual);
});
it("captures overlap before clearing playback and rejects an incompatible system-farewell lab", () => {
  expect(source.indexOf("recipientOverlapped = remaining > 0")).toBeLessThan(
    source.indexOf("playback.clear(now())"),
  );
  expect(source).toContain(
    "System-controlled farewell requires the bridge lab",
  );
});
