import { expect, it } from "vitest";
const { evaluateRun } = await import(
  new URL("../scripts/jp-voice-verdict.mjs", import.meta.url).href
);
const tool = (name: string, args: object, id = "a") => [
  {
    type: "response.tool_call.started",
    at_ms: 300,
    tool_call: { name, arguments: JSON.stringify(args), id },
  },
  {
    type: "response.tool_call.completed",
    at_ms: 301,
    status: "success",
    tool_call: { name, id },
  },
];
it("rejects the observed hangup-with-digits anomaly despite a successful provider result", () => {
  const result = evaluateRun(
    {
      summary: { session_started: true, unplayed_followup_menus: 0 },
      events: tool("hangup", { digits: "2" }),
    },
    { id: "menu", terminal: false, expected_digits: "2" },
  );
  expect(result.passed).toBe(false);
  expect(result.issues).toContain("hangup_arguments_mismatch");
  expect(result.issues).toContain("nonterminal_hangup");
  expect(result.issues).toContain("dtmf_sequence_mismatch");
});
it("requires ordered actual DTMF results and full menu progression", () => {
  const scenario = { id: "menu", terminal: false, expected_digits: ["2", "3"] };
  const good = {
    summary: { session_started: true, unplayed_followup_menus: 0 },
    events: [
      ...tool("send_dtmf", { digits: "2" }),
      ...tool("send_dtmf", { digits: "3" }, "b"),
    ],
  };
  expect(evaluateRun(good, scenario).passed).toBe(true);
  expect(
    evaluateRun(
      { ...good, summary: { ...good.summary, unplayed_followup_menus: 1 } },
      scenario,
    ).passed,
  ).toBe(false);
  expect(
    evaluateRun({ ...good, events: good.events.slice().reverse() }, scenario)
      .passed,
  ).toBe(false);
});
it("rejects early closure and preserves hold controls, while allowing a fully completed closing trace", () => {
  const summary = {
    session_started: true,
    closed_by_server: true,
    caller_finished_before_close: true,
    farewell_in_output: true,
    virtual_audio_drained_before_close: true,
  };
  const run = {
    summary,
    events: tool("hangup", {}),
    responses: [
      {
        status: "completed",
        text: "ありがとうございます。失礼いたします。",
        done_ms: 250,
      },
    ],
  };
  const terminal = { id: "close", terminal: true };
  expect(evaluateRun(run, terminal).passed).toBe(true);
  expect(
    evaluateRun(
      { ...run, summary: { ...summary, caller_finished_before_close: false } },
      terminal,
    ).issues,
  ).toContain("recipient_audio_cut");
  expect(
    evaluateRun(
      { ...run, responses: [{ ...run.responses[0], done_ms: 350 }] },
      terminal,
    ).passed,
  ).toBe(false);
  expect(evaluateRun(run, { id: "hold", terminal: false }).passed).toBe(false);
});
