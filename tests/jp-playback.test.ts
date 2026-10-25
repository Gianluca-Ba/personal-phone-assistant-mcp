import { expect, it } from "vitest";
const { PlaybackClock } = await import(
  new URL("../scripts/jp-playback-clock.mjs", import.meta.url).href
);
it("tracks queued audio and clears cancelled PCM rather than attributing it to the farewell", () => {
  const p = new PlaybackClock();
  p.append(32000, 16000, 100);
  p.append(16000, 16000, 200);
  expect(p.remaining(500)).toBe(1100);
  p.clear(500);
  expect(p.remaining(500)).toBe(0);
  p.append(3200, 16000, 600);
  expect(p.remaining(650)).toBe(50);
  expect(p.remaining(700)).toBe(0);
  expect(() => p.append(1, 0, 700)).toThrow();
});
