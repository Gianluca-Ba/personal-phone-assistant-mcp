import { expect, it } from "vitest";
const { SilenceWatchdog } = await import(
  new URL("../workers/voice/src/silence.mjs", import.meta.url).href
);
it("leaves explicit silent hold alone, checks ordinary dead air once, closes only after completed check", () => {
  let t = 0;
  const w = new SilenceWatchdog({ now: () => t });
  const state = {
    live: true,
    quiet: true,
    held: false,
    terminal: false,
    outputPending: false,
    awaitingAnswer: true,
    heardRecipient: true,
  };
  t = 20000;
  expect(w.next({ ...state, held: true })).toBeNull();
  expect(w.next({ ...state, quiet: false })).toBeNull();
  expect(w.next({ ...state, outputPending: true })).toBeNull();
  expect(w.next(state)).toBe("check");
  t = 90000;
  expect(w.next(state)).toBeNull();
  w.checkCompleted();
  t += 14999;
  expect(w.next(state)).toBeNull();
  t++;
  expect(w.next(state)).toBe("close");
});
it("respects actual recipient return and does not turn an aizuchi into another check", () => {
  let t = 0;
  const w = new SilenceWatchdog({ now: () => t });
  const s = {
    live: true,
    quiet: true,
    held: false,
    terminal: false,
    outputPending: false,
    heardRecipient: false,
  };
  t = 24999;
  expect(w.next(s)).toBeNull();
  t++;
  expect(w.next(s)).toBe("check");
  w.checkCompleted();
  t += 10000;
  w.activity();
  t += 10000;
  expect(w.next(s)).toBeNull();
  t += 5000;
  expect(w.next({ ...s, terminal: true })).toBeNull();
  expect(w.next(s)).toBe("close");
  expect(w.checkedOnce).toBe(true);
});
