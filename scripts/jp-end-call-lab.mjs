// Configures a virtual-only hangup test target. No PSTN routing or call API.
import { outboundTools, outboundDelegation } from "./jp-ivr-tools.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildCandidate } from "./jp-voice-policy.mjs";
const root = ".wrangler/jp-voice",
  stateFile = root + "/end-call-lab-state.json";
const load = (file) => {
  const b = JSON.parse(readFileSync(file, "utf8"));
  return b.data ?? b;
};
const base = load(root + "/api-before/assistant.json"),
  state = existsSync(stateFile)
    ? load(stateFile)
    : { operation: crypto.randomUUID() };
async function api(path, method = "GET", body) {
  if (path !== "/ai/assistants" && !path.startsWith("/ai/assistants/"))
    throw new Error("Assistant configuration only");
  const r = await fetch("https://api.telnyx.com/v2" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.TELNYX_API_KEY,
      "Content-Type": "application/json",
      ...(method === "POST" && path === "/ai/assistants"
        ? { "Idempotency-Key": state.operation }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const b = await r.json();
  if (!r.ok) {
    writeFileSync(
      root + "/end-call-api-error.json",
      JSON.stringify(b, null, 2),
      { mode: 0o600 },
    );
    throw new Error("End-call configuration HTTP " + r.status);
  }
  return b.data ?? b;
}
const candidate = buildCandidate(base.instructions).instructions;
const payload = {
  name: "JP Voice Lab end-call 2026-10-25",
  description: "Virtual-only goodbye/hangup evaluation; no phone numbers",
  model: base.model,
  instructions: candidate,
  llm_api_key_ref: base.llm_api_key_ref,
  enabled_features: base.enabled_features,
  greeting: base.greeting,
  voice_settings: { ...base.voice_settings, expressive_mode: false },
  transcription: base.transcription,
  interruption_settings: base.interruption_settings,
  dynamic_variables: base.dynamic_variables,
  tool_ids: [],
  tools: outboundTools(),
  delegation_settings: outboundDelegation(base.delegation_settings),
  telephony_settings: {
    ...base.telephony_settings,
    default_texml_app_id: null,
    fallback_destination: null,
    recording_settings: {
      ...base.telephony_settings.recording_settings,
      enabled: false,
    },
  },
  insight_settings: { insight_group_id: null, use_insights_for_memory: false },
  post_conversation_settings: { enabled: false },
  promote_to_main: true,
};
writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
if (!state.id) {
  const a = await api("/ai/assistants", "POST", payload);
  state.id = a.id;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
if (state.id === base.id) throw new Error("Production cannot be a lab");
const a = await api("/ai/assistants/" + state.id, "POST", payload);
if (
  a.tools.some((t) => !["hangup", "send_dtmf", "skip_turn"].includes(t.type)) ||
  a.telephony_settings.default_texml_app_id ||
  a.insight_settings.insight_group_id
)
  throw new Error("Lab isolation failed");
writeFileSync(root + "/lab-endcall.json", JSON.stringify(a, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    id: a.id,
    delegation_enabled: a.delegation_settings.enabled,
    delegation_model: a.delegation_settings.model,
    tools: a.tools.map((t) => t.type),
    phone_routing: false,
    real_calls: 0,
  }),
);
