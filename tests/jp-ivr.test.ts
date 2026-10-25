import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const { buildCandidate } = await import(
  new URL("../scripts/jp-voice-policy.mjs", import.meta.url).href
);
const original = readFileSync(
  "tests/fixtures/jp/original-instructions.redacted.txt",
  "utf8",
);
it("includes outbound-only IVR rules without introducing new task inputs or changing protected inbound rules", () => {
  const { instructions, validation } = buildCandidate(original);
  expect(validation.protected_sections_unchanged).toBe(4);
  expect(instructions).toContain("13. OUTBOUND IVR / DTMF");
  expect(instructions).toContain("Delegate send_dtmf");
  expect(instructions).toContain("saying the digits aloud is not DTMF");
  expect(instructions).toContain("not independently enforced server counters");
  expect(instructions).toContain(
    "Do not send account identifiers, PINs, passwords, one-time codes, payment details",
  );
  expect(instructions).toContain("no more than five menu selections");
});
it("covers a correct routing choice and forbidden sensitive or unrelated menu options", () => {
  const { scenarios } = JSON.parse(
    readFileSync("voice/jp/ivr-scenarios.json", "utf8"),
  );
  expect(
    scenarios.find((s: any) => s.id === "ivr-change").expected_digits,
  ).toBe("2");
  expect(
    scenarios.find((s: any) => s.id === "ivr-no-option").expected_digits,
  ).toBeNull();
  expect(
    scenarios.find((s: any) => s.id === "ivr-sensitive").expected_digits,
  ).toBeNull();
});
it("builds separate native tools without copying shared identifiers or changing the backend model", async () => {
  const { outboundTools, outboundDelegation, dtmfAttempts } = await import(
    new URL("../scripts/jp-ivr-tools.mjs", import.meta.url).href
  );
  const first = outboundTools();
  expect(first.map((t: any) => t.type)).toEqual(["hangup", "send_dtmf"]);
  expect(first[1]).toEqual({ type: "send_dtmf", send_dtmf: {} });
  first[1].send_dtmf.unwanted = true;
  expect(outboundTools()[1].send_dtmf).toEqual({});
  const base = { model: "existing-model", enabled: false, mode: "telnyx" };
  const backend = outboundDelegation(base);
  expect(backend.model).toBe(base.model);
  expect(backend.enabled).toBe(true);
  expect(backend.speak_results).toBe(false);
  expect(base.enabled).toBe(false);
  expect(() => outboundDelegation({})).toThrow();
  expect(
    dtmfAttempts([
      {
        type: "response.tool_call.started",
        tool_call: { name: "send_dtmf", arguments: '{"digits":"2"}' },
      },
    ]),
  ).toEqual([{ digits: "2" }]);
  expect(
    dtmfAttempts([
      {
        type: "response.tool_call.started",
        tool_call: { name: "skip_turn", arguments: "{}" },
      },
    ]),
  ).toEqual([]);
});
