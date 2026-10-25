// Configuration-only snapshot/apply/rollback. Never calls phone or test-call APIs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { outboundTools, outboundDelegation } from "./jp-ivr-tools.mjs";
import { buildCandidate, hash } from "./jp-voice-policy.mjs";
const dir = ".wrangler/jp-voice/api-before";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const assistantId = "assistant-a5173c59-af95-4f56-b1f1-ddeb5e6c07d5";
const load = (name) => {
  const b = JSON.parse(readFileSync(dir + "/" + name + ".json", "utf8"));
  return b.data ?? b;
};
const save = (name, data) =>
  writeFileSync(
    dir + "/" + name + ".json",
    JSON.stringify(data, null, 2) + "\n",
    { mode: 0o600 },
  );
const stable = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
async function api(path, method = "GET", payload) {
  if (!path.startsWith("/ai/assistants/" + assistantId))
    throw new Error("Only this assistant configuration is permitted");
  const r = await fetch("https://api.telnyx.com/v2" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.TELNYX_API_KEY,
      "Content-Type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    save("configuration-api-error", await r.json());
    throw new Error(
      "Configuration API HTTP " + r.status + "; details saved privately",
    );
  }
  const body = await r.json();
  return body.data ?? body;
}
if (!process.env.TELNYX_API_KEY)
  throw new Error("Local TELNYX_API_KEY required");
const action = process.argv[2] ?? "plan";
if (action === "snapshot") {
  if (existsSync(dir + "/assistant.json"))
    throw new Error("Original snapshot already exists; refusing overwrite");
  const a = await api("/ai/assistants/" + assistantId),
    versions = await api("/ai/assistants/" + assistantId + "/versions");
  save("assistant", a);
  save("versions", { data: versions });
  console.log(
    JSON.stringify({
      snapshot_saved: true,
      version: a.version_id,
      versions: versions.length,
    }),
  );
} else {
  const before = load("assistant");
  if (action === "plan") {
    const candidate = buildCandidate(before.instructions);
    save("planned-patch", {
      instructions: candidate.instructions,
      model: before.model,
      tool_ids: [],
      tools: outboundTools(),
      delegation_settings: outboundDelegation(before.delegation_settings),
      voice_settings: { ...before.voice_settings, expressive_mode: false },
      version_name: "JP outbound IVR and end-call candidate",
      promote_to_main: true,
    });
    console.log(
      JSON.stringify({
        validation: candidate.validation,
        changed_fields: [
          "instructions",
          "voice_settings.expressive_mode",
          "tools",
          "delegation_settings",
        ],
        audio_thresholds_changed: false,
      }),
    );
  } else if (action === "rollback" || action === "verify-rollback-route") {
    if (action === "verify-rollback-route") {
      const current = await api("/ai/assistants/" + assistantId);
      if (current.version_id !== before.version_id)
        throw new Error(
          "No-op rollback verification only allowed before production changes",
        );
    }
    const currently = await api("/ai/assistants/" + assistantId);
    if (currently.version_id === before.version_id) {
      if (currently.instructions !== before.instructions)
        throw new Error("Snapshot mismatch");
      console.log(
        JSON.stringify({
          rollback_target_available: true,
          version: before.version_id,
          no_op: true,
        }),
      );
      process.exit(0);
    }
    await api(
      "/ai/assistants/" +
        assistantId +
        "/versions/" +
        encodeURIComponent(before.version_id) +
        "/promote",
      "POST",
    );
    const restored = await api("/ai/assistants/" + assistantId);
    save("rollback-result", restored);
    if (
      restored.version_id !== before.version_id ||
      restored.instructions !== before.instructions ||
      stable(restored.voice_settings) !== stable(before.voice_settings)
    )
      throw new Error("Rollback readback mismatch");
    console.log(
      JSON.stringify({
        rollback_verified: true,
        version: restored.version_id,
        no_op: action === "verify-rollback-route",
      }),
    );
  } else if (action === "apply") {
    // Fail closed: configuration acceptance alone is not functional validation.
    const releaseFile = ".wrangler/jp-voice/release-validation.json";
    if (!existsSync(releaseFile))
      throw new Error(
        "Production release blocked: IVR, completed farewell playback and inbound validation are not complete",
      );
    const release = JSON.parse(readFileSync(releaseFile, "utf8"));
    if (
      release.candidate_sha256 !==
        hash(buildCandidate(before.instructions).instructions) ||
      release.baseline_version !== before.version_id ||
      release.ivr_action_verified !== true ||
      release.farewell_playback_verified !== true ||
      release.inbound_regression_verified !== true
    )
      throw new Error(
        "Production release blocked by incomplete behavioral validation",
      );
    const current = await api("/ai/assistants/" + assistantId);
    if (
      current.version_id !== before.version_id ||
      hash(current.instructions) !== hash(before.instructions)
    )
      throw new Error("Assistant changed since snapshot; refusing overwrite");
    const patch = load("planned-patch");
    const intended = buildCandidate(before.instructions);
    if (
      patch.instructions !== intended.instructions ||
      stable(patch.tools) !== stable(outboundTools()) ||
      stable(patch.delegation_settings) !==
        stable(outboundDelegation(before.delegation_settings)) ||
      patch.model !== before.model ||
      patch.voice_settings.expressive_mode !== false
    )
      throw new Error("Patch differs from reviewed candidate");
    await api("/ai/assistants/" + assistantId, "POST", patch);
    const after = await api("/ai/assistants/" + assistantId);
    save("published-after", after);
    const allowed = new Set([
      "instructions",
      "tools",
      "tool_ids",
      "delegation_settings",
      "voice_settings",
      "version_name",
      "version_id",
      "version_created_at",
      "updated_at",
    ]);
    const unexpected = Object.keys(before).filter(
      (k) => !allowed.has(k) && stable(before[k]) !== stable(after[k]),
    );
    const expectedVoice = { ...before.voice_settings, expressive_mode: false };
    if (
      stable(after.delegation_settings) !== stable(patch.delegation_settings) ||
      stable(
        after.tools.map((t) => ({ type: t.type, [t.type]: t[t.type] })),
      ) !== stable(patch.tools) ||
      after.instructions !== patch.instructions ||
      stable(after.voice_settings) !== stable(expectedVoice) ||
      unexpected.length
    ) {
      save("unexpected-change", { fields: unexpected });
      await api(
        "/ai/assistants/" +
          assistantId +
          "/versions/" +
          encodeURIComponent(before.version_id) +
          "/promote",
        "POST",
      );
      throw new Error("Readback mismatch; original version restored");
    }
    save("publish-verification", {
      version: after.version_id,
      previous_version: before.version_id,
      unexpected_fields: unexpected,
      changed_fields: [
        "instructions",
        "voice_settings.expressive_mode",
        "tools",
        "delegation_settings",
      ],
      interruption_settings_unchanged:
        stable(before.interruption_settings) ===
        stable(after.interruption_settings),
    });
    console.log(
      JSON.stringify({
        published: true,
        version: after.version_id,
        model: after.model,
        voice: after.voice_settings.voice,
        interruption_settings_unchanged: true,
        unexpected_changes: 0,
      }),
    );
  } else
    throw new Error(
      "Use snapshot, plan, verify-rollback-route, apply, rollback",
    );
}
