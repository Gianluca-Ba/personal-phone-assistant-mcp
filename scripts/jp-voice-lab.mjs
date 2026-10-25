// Isolated Telnyx assistants for WebSocket tests. No telephony/call endpoint exists here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { buildCandidate } from "./jp-voice-policy.mjs";
const dir = ".wrangler/jp-voice";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const statePath = dir + "/lab-state.json";
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const raw = JSON.parse(
    readFileSync(dir + "/api-before/assistant.json", "utf8"),
  ),
  base = raw.data ?? raw;
async function api(path, method = "GET", body, operation) {
  if (path !== "/ai/assistants" && !path.startsWith("/ai/assistants/"))
    throw new Error("Only assistant configuration is allowed");
  const r = await fetch("https://api.telnyx.com/v2" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.TELNYX_API_KEY,
      "Content-Type": "application/json",
      ...(operation ? { "Idempotency-Key": operation } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const error = await r.json();
    writeFileSync(dir + "/lab-api-error.json", JSON.stringify(error, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        http_status: r.status,
        errors: error.errors?.map((e) => ({
          code: e.code,
          title: e.title,
          detail: String(e.detail ?? "").replaceAll(
            process.env.TELNYX_API_KEY,
            "[redacted]",
          ),
        })),
      }),
    );
    throw new Error("Assistant configuration HTTP " + r.status);
  }
  const b = await r.json();
  return b.data ?? b;
}
if (!process.env.TELNYX_API_KEY)
  throw new Error("Local TELNYX_API_KEY required");
const candidateThreshold = Number(
  process.env.JP_VOICE_LAB_THRESHOLD ??
    base.interruption_settings.interrupt_prediction_threshold,
);
if (
  !Number.isFinite(candidateThreshold) ||
  candidateThreshold < 0 ||
  candidateThreshold > 1
)
  throw new Error("Invalid lab threshold");
for (const variant of ["baseline", "candidate"]) {
  if (!state[variant]) {
    state[variant] = { clone_operation: crypto.randomUUID() };
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  if (!state[variant].id) {
    state[variant].create_operation ??= crypto.randomUUID();
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    // Clone endpoint rejects the legacy expressive_mode=true/OpenAILive pairing.
    // Create an isolated copy with this unsupported flag disabled on BOTH arms.
    const a = await api(
      "/ai/assistants",
      "POST",
      {
        name: "JP Voice Lab " + variant + " 2026-10-25",
        model: base.model,
        instructions: base.instructions,
        enabled_features: base.enabled_features,
        llm_api_key_ref: base.llm_api_key_ref,
        voice_settings: { ...base.voice_settings, expressive_mode: false },
        transcription: base.transcription,
        interruption_settings: base.interruption_settings,
        dynamic_variables: base.dynamic_variables,
        tools: [],
        greeting: base.greeting,
        delegation_settings: { enabled: false },
        insight_settings: {
          insight_group_id: null,
          use_insights_for_memory: false,
        },
        telephony_settings: {
          ...base.telephony_settings,
          default_texml_app_id: null,
          fallback_destination: null,
          recording_settings: {
            ...base.telephony_settings.recording_settings,
            enabled: false,
          },
        },
        post_conversation_settings: { enabled: false },
      },
      state[variant].create_operation,
    );
    state[variant].id = a.id;
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }
  if (state[variant].id === base.id)
    throw new Error("Production cannot be a lab assistant");
  const instructions =
    variant === "candidate"
      ? buildCandidate(base.instructions).instructions
      : base.instructions;
  const desiredThreshold =
    variant === "candidate"
      ? candidateThreshold
      : base.interruption_settings.interrupt_prediction_threshold;
  const existing = await api("/ai/assistants/" + state[variant].id);
  if (
    existing.instructions === instructions &&
    existing.interruption_settings?.interrupt_prediction_threshold ===
      desiredThreshold &&
    !existing.telephony_settings?.default_texml_app_id &&
    !existing.insight_settings?.insight_group_id &&
    !existing.tools?.length
  ) {
    writeFileSync(
      dir + "/lab-" + variant + ".json",
      JSON.stringify(existing, null, 2),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        variant,
        id: existing.id,
        unchanged: true,
        interruption_threshold: desiredThreshold,
      }),
    );
    continue;
  }
  const a = await api("/ai/assistants/" + state[variant].id, "POST", {
    name: "JP Voice Lab " + variant + " 2026-10-25",
    description: "Isolated synthetic WebSocket evaluation; no phone routing",
    instructions,
    tools: [],
    mcp_servers: [],
    integrations: [],
    post_conversation_settings: { enabled: false },
    insight_settings: {
      insight_group_id: null,
      use_insights_for_memory: false,
    },
    telephony_settings: {
      ...base.telephony_settings,
      default_texml_app_id: null,
      fallback_destination: null,
      recording_settings: {
        ...base.telephony_settings.recording_settings,
        enabled: false,
      },
    },
    dynamic_variables_webhook_url: null,
    ...(variant === "candidate"
      ? {
          interruption_settings: {
            ...base.interruption_settings,
            interrupt_prediction_threshold: candidateThreshold,
          },
        }
      : {}),
    version_name: "Synthetic lab " + variant,
    promote_to_main: true,
  });
  if (
    a.insight_settings?.insight_group_id ||
    a.telephony_settings?.default_texml_app_id ||
    a.telephony_settings?.recording_settings?.enabled ||
    a.tools?.length
  )
    throw new Error("Lab isolation verification failed");
  writeFileSync(dir + "/lab-" + variant + ".json", JSON.stringify(a, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      variant,
      id: a.id,
      model: a.model,
      interruption_threshold:
        a.interruption_settings?.interrupt_prediction_threshold,
      phone_routing: false,
      production_changed: false,
    }),
  );
}
