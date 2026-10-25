import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const { buildCandidate, section } = await import(
  new URL("../scripts/jp-voice-policy.mjs", import.meta.url).href
);
const { metrics } = await import(
  new URL("../scripts/jp-voice-metrics.mjs", import.meta.url).href
);
const original = readFileSync(
  "tests/fixtures/jp/original-instructions.redacted.txt",
  "utf8",
);
it("removes fixed outbound identity rules while preserving protected inbound and authorization text", () => {
  const { instructions, validation } = buildCandidate(original);
  expect(validation.protected_sections_unchanged).toBe(4);
  expect(
    section(instructions, "INBOUND MODE\n", "3. OUTBOUND TASK EXECUTION"),
  ).toBe(section(original, "INBOUND MODE\n", "3. OUTBOUND TASK EXECUTION"));
  expect(instructions).toContain(
    "On inbound calls only, introduce yourself naturally as Example Owner's assistant",
  );
  expect(instructions).not.toContain(
    "Introduce yourself as Example Owner's assistant.",
  );
  expect(instructions).not.toContain(
    "Hello, I'm calling on behalf of Example Owner",
  );
  expect(instructions).toContain(
    "If the task forbids the name, do not mention it",
  );
  expect(instructions).toContain(
    "truthful about being an automated assistant when asked",
  );
  expect(instructions).toContain("Do not apply it to inbound calls");
  expect(instructions).toContain("Honor an exact opening supplied");
  expect(instructions.startsWith("CALL ROUTING GUARD")).toBe(true);
  expect([...instructions.matchAll(/{{outbound_task}}/g)]).toHaveLength(1);
  expect(instructions).toContain("execute the existing hangup tool");
  expect(instructions).toContain(
    "A silent recipient after this final farewell",
  );
  expect(instructions).toContain("「はい」 after your question is an answer");
  expect(instructions).toContain("「ちょっと待ってください」");
  expect(instructions).toContain("never combine 午後 with a 24-hour hour");
  expect(() => buildCandidate(instructions)).toThrow("already present");
  expect(() =>
    buildCandidate(
      original.replace("5. INBOUND CALL HANDLING", "unexpected section"),
    ),
  ).toThrow();
});
it("metrics require audio events, paired same-clock turns and manual context annotations", () => {
  const trace = {
    source: "synthetic",
    events: [
      { type: "caller_speech_end", turn_id: "a", clock: "x", at_ms: 100 },
      { type: "assistant_first_audio", turn_id: "a", clock: "x", at_ms: 700 },
      { type: "caller_speech_end", turn_id: "b", clock: "x", at_ms: 1000 },
      { type: "assistant_first_audio", turn_id: "b", clock: "x", at_ms: 1800 },
      { type: "transcript_fragment", utterance_id: "u", at_ms: 2000 },
      { type: "transcript_fragment", utterance_id: "u", at_ms: 2100 },
      { type: "assistant_playback_cut", utterance_id: "u", at_ms: 2200 },
      { type: "assistant_playback_cut", utterance_id: "q", at_ms: 2300 },
    ],
    caller_annotations: { u: "backchannel", q: "question" },
    clause_checks: [{ complete: true }, { complete: false }],
    detail_checks: [
      { expected: "18:00", observed: "18:00" },
      { expected: "16:45 unchanged", observed: "16:00" },
    ],
  };
  const result = metrics(trace);
  expect(result.response_latency).toEqual({ n: 2, p50_ms: 600, p95_ms: 800 });
  expect(result.playback_cuts).toBe(2);
  expect(result.unwanted_interruptions).toBe(1);
  expect(result.clause_completion).toBe(0.5);
  expect(result.detail_accuracy).toBe(0.5);
  expect(result.provider_performance_measured).toBe(false);
  expect(
    metrics({
      source: "observed",
      events: [{ type: "transcript_fragment", at_ms: 10 }],
    }).unwanted_interruptions,
  ).toBeNull();
  expect(
    metrics({
      source: "observed",
      events: [
        { type: "caller_speech_end", turn_id: "a", clock: "a", at_ms: 1 },
        { type: "assistant_first_audio", turn_id: "a", clock: "b", at_ms: 100 },
      ],
    }).response_latency.n,
  ).toBe(0);
});
it("simulated speakers cover listening signals, true interruptions, identity and an inbound control", () => {
  const corpus = JSON.parse(readFileSync("voice/jp/scenarios.json", "utf8"));
  expect(corpus.voices).toHaveLength(2);
  expect(corpus.scenarios).toHaveLength(15);
  expect(
    corpus.scenarios.filter((s: any) => s.expected.startsWith("yield")),
  ).toHaveLength(4);
  expect(
    corpus.scenarios.find((s: any) => s.id === "hai-answer").expected,
  ).toBe("accept_answer");
  expect(
    corpus.scenarios.find((s: any) => s.id === "inbound-control"),
  ).toBeTruthy();
});
