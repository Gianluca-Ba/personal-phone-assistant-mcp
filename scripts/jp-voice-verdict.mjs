// Evaluate real tool/audio evidence, never the model's claim of success.
export function evaluateRun(run, scenario) {
  const issues = [],
    events = run.events ?? [],
    summary = run.summary ?? {};
  const started = events.filter((e) => e.type === "response.tool_call.started");
  const completed = events.filter(
    (e) => e.type === "response.tool_call.completed",
  );
  const digits = [];
  if (!summary.session_started) issues.push("session_not_started");
  for (const e of started) {
    const { name, id } = e.tool_call ?? {};
    let args;
    try {
      args = JSON.parse(e.tool_call.arguments);
    } catch {
      issues.push("invalid_tool_json");
      continue;
    }
    if (
      name === "hangup" &&
      (!args || Array.isArray(args) || Object.keys(args).length)
    )
      issues.push("hangup_arguments_mismatch");
    if (name === "send_dtmf") {
      if (
        !args ||
        Object.keys(args).length !== 1 ||
        typeof args.digits !== "string" ||
        !/^[0-9*#]$/.test(args.digits)
      )
        issues.push("dtmf_arguments_mismatch");
      digits.push(args?.digits);
    }
    if (!["send_dtmf", "hangup"].includes(name)) issues.push("unexpected_tool");
    if (
      !completed.some(
        (c) =>
          c.tool_call?.id === id &&
          c.tool_call?.name === name &&
          c.status === "success",
      )
    )
      issues.push("tool_not_completed");
  }
  const expected =
    scenario.expected_digits == null ? [] : [scenario.expected_digits].flat();
  if (JSON.stringify(digits) !== JSON.stringify(expected))
    issues.push("dtmf_sequence_mismatch");
  if ((summary.unplayed_followup_menus ?? 0) > 0)
    issues.push("menu_sequence_incomplete");
  const hangs = started.filter((e) => e.tool_call?.name === "hangup");
  if (!scenario.terminal && hangs.length) issues.push("nonterminal_hangup");
  if (scenario.terminal) {
    if (hangs.length !== 1 || !summary.closed_by_server)
      issues.push("terminal_not_closed_once");
    if (!summary.caller_finished_before_close)
      issues.push("recipient_audio_cut");
    if (!summary.farewell_in_output) issues.push("farewell_not_established");
    if (!summary.virtual_audio_drained_before_close)
      issues.push("assistant_audio_queue_not_drained");
    const closeAt = hangs[0]?.at_ms;
    const finalResponse = (run.responses ?? [])
      .filter(
        (r) =>
          r.status === "completed" && /失礼(?:いた)?します/.test(r.text ?? ""),
      )
      .at(-1);
    if (
      !finalResponse ||
      !Number.isFinite(finalResponse.done_ms) ||
      !(closeAt >= finalResponse.done_ms)
    )
      issues.push("hangup_before_completed_farewell_response");
  }
  const errors = events.filter(
    (e) =>
      e.type === "connection_error" ||
      (e.type === "error" &&
        !(scenario.terminal && e.error?.code === "conversation_ended")),
  );
  if (errors.length) issues.push("session_error");
  return {
    scenario: scenario.id,
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    dtmf_digits: digits,
    hangup_attempts: hangs.length,
    real_calls: 0,
  };
}

export function evaluateGuardedRun(run, scenario) {
  const events = run.events ?? [],
    s = run.summary ?? {},
    issues = [];
  const digits = events
    .filter((e) => e.type === "controller.virtual_dtmf")
    .map((e) => e.digits);
  const expected =
    scenario.expected_digits == null ? [] : [scenario.expected_digits].flat();
  if (!s.session_started) issues.push("session_not_started");
  if (JSON.stringify(digits) !== JSON.stringify(expected))
    issues.push("dtmf_sequence_mismatch");
  if ((s.unplayed_followup_menus ?? 0) > 0)
    issues.push("menu_sequence_incomplete");
  if (
    events.some(
      (e) =>
        e.type === "response.tool_call.started" &&
        ["hangup", "send_dtmf"].includes(e.tool_call?.name),
    )
  )
    issues.push("unguarded_native_action");
  const close = events.filter((e) => e.type === "controller.virtual_close");
  if (scenario.terminal) {
    if (close.length !== 1 || !s.closed_by_controller)
      issues.push("terminal_not_closed_once");
    if (!s.caller_finished_before_close) issues.push("recipient_audio_cut");
    if (!s.virtual_audio_drained_before_close)
      issues.push("assistant_audio_queue_not_drained");
    const r = (run.responses ?? [])
      .filter(
        (r) =>
          r.status === "completed" && /失礼(?:いた)?します/.test(r.text ?? ""),
      )
      .at(-1);
    if (!r || !(close[0]?.at_ms >= r.done_ms + 250))
      issues.push("completed_farewell_not_established");
  } else if (close.length || s.closed_by_server)
    issues.push("nonterminal_close");
  if (
    events.some(
      (e) =>
        e.type === "connection_error" ||
        e.type === "controller_error" ||
        e.type === "error",
    )
  )
    issues.push("session_error");
  return {
    scenario: scenario.id,
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    dtmf_digits: digits,
    transport: "virtual_adapter_only",
    production_ready: false,
    real_calls: 0,
  };
}
