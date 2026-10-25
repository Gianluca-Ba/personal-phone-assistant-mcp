// Patches only the authorized outbound approval function in a private snapshot.
// Original source/credentials/owner data are never committed by this script.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function patchPhone(original) {
  const start = original.indexOf("async function approveOutboundRequest("),
    end = original.indexOf("async function handleOutboundStatus(", start);
  if (start < 0 || end < 0 || original.includes("GUARDED_OUTBOUND_VOICE_V1"))
    throw new Error("Unexpected source; no patch applied");
  let region = original.slice(start, end);
  function replaceOnce(a, b) {
    if (region.split(a).length !== 2)
      throw Error("Outbound source changed; no patch applied");
    region = region.replace(a, b);
  }
  replaceOnce("  const endpoint =", "  let endpoint =");
  replaceOnce("  const telnyxPayload = {", "  let telnyxPayload = {");
  replaceOnce(
    "  let response;",
    `  // GUARDED_OUTBOUND_VOICE_V1 — inbound code and legacy languages unchanged.
  if (env.OUTBOUND_VOICE_MODE === "guarded_jp" && row.language === "ja") {
    try {
      if (!env.VOICE_CONTROL || !env.VOICE_CONTROL_API_SECRET) throw new Error("Voice configuration missing");
      const registered = await env.VOICE_CONTROL.fetch("https://voice.internal/register", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.VOICE_CONTROL_API_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({request_id: row.id, callback_token: callbackToken, destination: row.destination_number, from: env.TELNYX_OUTBOUND_FROM})
      });
      if (!registered.ok) throw new Error("Voice controller unavailable");
      const dispatch = await registered.json();
      if (dispatch.endpoint !== "https://api.telnyx.com/v2/calls" || dispatch.payload?.to !== row.destination_number || dispatch.payload?.from !== env.TELNYX_OUTBOUND_FROM || dispatch.payload?.command_id !== requestId || dispatch.payload?.time_limit_secs !== OUTBOUND_MAX_SECONDS || dispatch.payload?.connection_id !== env.OUTBOUND_VOICE_APP_ID || new URL(dispatch.payload?.stream_url).origin !== env.OUTBOUND_VOICE_ORIGIN.replace(/^https:/, "wss:")) throw new Error("Voice contract mismatch");
      endpoint = dispatch.endpoint;
      telnyxPayload = dispatch.payload;
    } catch {
      await db.prepare("UPDATE outbound_requests SET status = 'failed', last_error = 'voice_controller_unavailable', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'dialing'").bind(requestId).run();
      return reply({error:"Guarded outbound voice unavailable"}, 503);
    }
  }

  let response;`,
  );
  replaceOnce(
    "      : null;\n\n  await db.prepare(`\n    UPDATE outbound_requests\n    SET telnyx_call_id = ?",
    `      : (env.OUTBOUND_VOICE_MODE === "guarded_jp" && row.language === "ja" && typeof result.data?.call_control_id === "string" ? result.data.call_control_id : null);

  await db.prepare(\`\n    UPDATE outbound_requests\n    SET telnyx_call_id = ?`,
  );
  replaceOnce(
    "SET telnyx_call_id = ?",
    "SET telnyx_call_id = COALESCE(?, telnyx_call_id)",
  );
  const source = original.slice(0, start) + region + original.slice(end);
  if (
    source.slice(0, start) !== original.slice(0, start) ||
    source.slice(source.indexOf("async function handleOutboundStatus(")) !==
      original.slice(end)
  )
    throw Error("Protected code changed");
  return {
    source,
    validation: {
      original_sha256: hash(original),
      patched_sha256: hash(source),
      protected_prefix_sha256: hash(original.slice(0, start)),
      protected_suffix_sha256: hash(original.slice(end)),
      inbound_byte_identical: true,
      authorization_guard_unchanged:
        region.slice(0, region.indexOf("  let endpoint =")) ===
        original
          .slice(start, end)
          .slice(0, original.slice(start, end).indexOf("  const endpoint =")),
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error("Supply private original and output paths");
  const result = patchPhone(readFileSync(input, "utf8"));
  writeFileSync(output, result.source, { mode: 0o600 });
  console.log(JSON.stringify(result.validation));
}
