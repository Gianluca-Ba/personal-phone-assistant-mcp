import { expect, it } from "vitest";
const { SttTurns, genuineInterruption } = await import(
  new URL("../workers/voice/src/turns.mjs", import.meta.url).href
);
it("commits each Flux turn once and ignores normalized duplicate finals", () => {
  const final: string[] = [];
  let starts = 0;
  const t = new SttTurns({
    onStart: () => starts++,
    onInterim: () => {},
    onFinal: (s: string) => final.push(s),
  });
  const f = {
    type: "TurnInfo",
    request_id: "isolated",
    turn_index: 1,
    transcript: "二番を押してください。",
  };
  t.accept({ ...f, event: "StartOfTurn" });
  t.accept({ ...f, event: "EndOfTurn" });
  t.accept({ ...f, event: "EndOfTurn" });
  t.accept({ transcript: f.transcript, is_final: true, speech_final: true });
  expect(starts).toBe(1);
  expect(final).toEqual([f.transcript]);
  t.accept({ ...f, turn_index: 2, event: "EndOfTurn" });
  expect(final).toHaveLength(2);
});
it("distinguishes aizuchi from actual Japanese interruption requests", () => {
  for (const s of ["はい。", "ええ", "そうですね"])
    expect(genuineInterruption(s)).toBe(false);
  for (const s of ["ちょっと待ってください。", "何時ですか。", "違います。"])
    expect(genuineInterruption(s)).toBe(true);
});
