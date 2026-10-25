// Configures a virtual-only hangup test target. No PSTN routing or call API.
import { guardedTools, guardedInstructions } from "./jp-guarded-tools.mjs";
import { outboundTools, outboundDelegation } from "./jp-ivr-tools.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildCandidate } from "./jp-voice-policy.mjs";
const variant = process.env.JP_LAB_VARIANT ?? "endcall";
if (!/^[a-z0-9-]+$/.test(variant)) throw new Error("Invalid lab variant");
const root = ".wrangler/jp-voice",
  stateFile =
    root +
    "/" +
    (variant === "endcall" ? "end-call" : variant) +
    "-lab-state.json";
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
const dtmfOnly = process.env.JP_LAB_TOOLS === "dtmf-only";
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
  tools: dtmfOnly ? [{ type: "send_dtmf", send_dtmf: {} }] : outboundTools(),
  delegation_settings: outboundDelegation({
    ...base.delegation_settings,
    model: process.env.JP_LAB_BACKEND ?? base.delegation_settings.model,
  }),
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
if (dtmfOnly)
  payload.delegation_settings.instructions =
    "Only send_dtmf is available. Never call hangup. If asked to close, return CLOSING_UNAVAILABLE silently, without a tool. " +
    payload.delegation_settings.instructions;
if (process.env.JP_LAB_TOOLS === "client-guarded") {
  payload.tools = guardedTools();
  payload.instructions =
    "For menu navigation, delegate read_current_menu then press_ivr_digit with the current token. For closure delegate finish_call_after_goodbye, finish one farewell then stay silent. " +
    payload.instructions
      .replace(/\bhangup\b/g, "finish_call_after_goodbye")
      .replace(/send_dtmf/g, "press_ivr_digit");
  payload.delegation_settings.instructions = guardedInstructions;
}
if (process.env.JP_LAB_JA_STT === "1")
  payload.transcription = { ...payload.transcription, language: "ja" };
if (process.env.JP_LAB_LOCAL_INTERRUPTS === "1")
  payload.interruption_settings = {
    ...payload.interruption_settings,
    enable: false,
  };
if (process.env.JP_LAB_SHORT === "1") {
  if (process.env.JP_LAB_TOOLS !== "client-guarded")
    throw new Error("Dedicated prompt requires guarded tools");
  payload.instructions = readFileSync(
    "voice/jp/guarded-outbound-prompt.txt",
    "utf8",
  );
}
if (process.env.JP_LAB_CHAINED === "1") {
  const catalog = load(root + "/voices.json");
  const voice = catalog.voices.find(
    (v) =>
      v.id === "Telnyx.Ultra.049de96c-781a-4728-8365-82899c178a43" &&
      v.language === "ja" &&
      !v.deprecated,
  );
  if (!voice) throw new Error("Verified Japanese voice unavailable");
  payload.model = "openai/gpt-4.1";
  payload.voice_settings = {
    ...payload.voice_settings,
    voice: voice.id,
    language_boost: "Japanese",
    expressive_mode: false,
  };
  payload.delegation_settings = {
    ...payload.delegation_settings,
    enabled: false,
  };
  payload.greeting = "";
}
writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
if (!state.id) {
  const a = await api("/ai/assistants", "POST", payload);
  state.id = a.id;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
if (state.id === base.id) throw new Error("Production cannot be a lab");
const a = await api("/ai/assistants/" + state.id, "POST", payload);
if (
  a.tools.some(
    (t) =>
      !["hangup", "send_dtmf", "skip_turn", "client_side_tool"].includes(
        t.type,
      ),
  ) ||
  a.telephony_settings.default_texml_app_id ||
  a.insight_settings.insight_group_id
)
  throw new Error("Lab isolation failed");
writeFileSync(root + "/lab-" + variant + ".json", JSON.stringify(a, null, 2), {
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
