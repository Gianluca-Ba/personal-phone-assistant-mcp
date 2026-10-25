// Aggregate only; raw transcripts/audio remain in the private run directory.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2] ?? ".wrangler/jp-voice/virtual-final-screening";
const records = readdirSync(dir)
  .filter((n) => n.endsWith(".json"))
  .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")))
  .filter((r) => r.summary);
const q = (a, p) =>
  a.length
    ? [...a].sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)]
    : null;
const groups = {};
for (const variant of ["baseline", "candidate"]) {
  const r = records.filter((r) => r.summary.variant === variant),
    s = r.map((r) => r.summary);
  const back = r.filter(
    (r) =>
      r.summary.scenario.startsWith("aizuchi-") &&
      r.summary.generation_active_at_target &&
      r.summary.overlap_playback &&
      r.summary.target_finished,
  );
  const actual = r.filter(
    (r) =>
      ["hai-objection", "stop-request", "automation-identity"].includes(
        r.summary.scenario,
      ) &&
      r.summary.generation_active_at_target &&
      r.summary.overlap_playback &&
      r.summary.target_finished,
  );
  const latency = s
    .map((r) => r.caller_end_to_next_audio_ms)
    .filter((v) => Number.isFinite(v));
  const render = (record) => record.responses.map((r) => r.text).join("\n");
  const restarts = back.filter((r) => {
    const first = r.responses[0]?.text ?? "";
    return (
      first.length >= 8 &&
      r.responses
        .slice(1)
        .some((next) => (next.text ?? "").startsWith(first.slice(0, 8)))
    );
  }).length;
  groups[variant] = {
    sessions: s.length,
    errors: s.filter((v) => v.errors.length).length,
    backchannel_overlap_trials: back.length,
    backchannel_trials_with_server_cancel: back.filter(
      (r) => r.summary.server_cancelled_responses > 0,
    ).length,
    first_response_completed_despite_backchannel: back.filter(
      (r) => r.summary.first_response_complete,
    ).length,
    true_request_overlap_trials: actual.length,
    true_request_trials_with_server_cancel: actual.filter(
      (r) => r.summary.server_cancelled_responses > 0,
    ).length,
    outbound_sessions_with_owner_name: s.filter(
      (r) => r.scenario !== "inbound-control" && r.owner_name_leaked,
    ).length,
    outbound_session_count: s.filter((r) => r.scenario !== "inbound-control")
      .length,
    afternoon_24h_sessions: s.filter((r) => r.afternoon24h).length,
    latency: {
      kind: "client-observed caller PCM-end to next response first-audio; not model-only or PSTN",
      samples: latency.length,
      p50_ms: q(latency, 0.5),
      p95_ms: q(latency, 0.95),
    },
    repeated_prefix_after_backchannel: restarts,
    inbound_controls: s.filter((r) => r.scenario === "inbound-control").length,
    real_calls: 0,
  };
}
const result = {
  provenance:
    "real Telnyx WebSocket sessions with offline synthetic Japanese speakers; isolated assistants",
  groups,
  limitations: [
    "Small sample; no PSTN calls",
    "Server cancellation is not a measured audible PSTN playback cut",
    "Text restart and owner-name checks use returned output transcripts",
    "No upstream model-request timestamps; no model-only latency",
    "Threshold experiment changes both prompt and threshold; do not attribute latency differences causally",
  ],
};
if (process.argv[3])
  writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
console.log(JSON.stringify(result, null, 2));
