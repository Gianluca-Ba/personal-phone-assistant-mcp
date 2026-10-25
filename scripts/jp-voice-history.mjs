// Private archived API responses -> aggregate evidence, never a transcript-based
// claim of model latency or audible interruption.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2] ?? ".wrangler/jp-voice/api-before";
const load = (name) => {
  const b = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  return b.data ?? b;
};
const a = load("assistant"),
  c = load("conversation"),
  messages = load("messages-all");
const owner =
  /^Introduce yourself naturally as (.+)'s assistant,/m.exec(
    a.instructions,
  )?.[1] ?? "";
const japanese =
  /。([^。"\n]+)のアシスタントです/.exec(a.instructions)?.[1] ?? "";
const aliases = [
  owner,
  japanese,
  ...owner.split(/\s+/),
  ...japanese.split("・"),
].filter((v) => v.length >= 3);
const sorted = [...messages].sort(
  (x, y) => Date.parse(x.sent_at) - Date.parse(y.sent_at),
);
const assistant = sorted.filter((m) => m.role === "assistant");
const points = assistant
  .flatMap((m) => [m.metadata?.live_start_ms, m.metadata?.live_end_ms])
  .filter((v) => Number.isFinite(v));
const summary = {
  source: "archived_Telnyx_API",
  configuration_matches_call: c.metadata?.assistant_version_id === a.version_id,
  call_version: c.metadata?.assistant_version_id,
  message_records: messages.length,
  assistant_records: assistant.length,
  user_records: messages.filter((m) => m.role === "user").length,
  adjacent_same_role_records: sorted
    .slice(1)
    .filter((m, i) => m.role === sorted[i].role).length,
  afternoon_24h_records: assistant.filter((m) =>
    /午後\s*(?:1[3-9]|2[0-3])時/.test(m.text ?? ""),
  ).length,
  configured_owner_name_records: assistant.filter((m) =>
    aliases.some((value) =>
      (m.text ?? "").toLocaleLowerCase().includes(value.toLocaleLowerCase()),
    ),
  ).length,
  assistant_alignment_points: points.length,
  alignment_points_on_200ms_grid: points.filter((v) => v % 200 === 0).length,
  model_latency_ms: null,
  audible_interruptions: null,
  timing_note:
    "created_at is persistence time; sent_at/live offsets are alignment metadata. No model request, first-audio or playback-cut event was archived in these responses.",
};
writeFileSync(
  join(dir, "history-summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(summary));
