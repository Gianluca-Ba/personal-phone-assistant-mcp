// Surgical notification-only patch. Never commit the private phone snapshot.
import { createHash } from "node:crypto";
export function patchPhoneSummary(source, modulePath) {
  if (source.includes("CALL_SUMMARY_V2"))
    throw new Error("Summary patch already applied");
  const start = source.indexOf("async function sendOne("),
    end = source.indexOf("async function getEligible(", start);
  if (start < 0 || end < 0)
    throw new Error("Notification source not recognized");
  let region = source.slice(start, end);
  const once = (a, b) => {
    if (region.split(a).length !== 2)
      throw new Error("Notification source changed");
    region = region.replace(a, b);
  };
  const payloadStart = region.indexOf("  // Existing Apps Script"),
    payloadEnd = region.indexOf("\n  try {", payloadStart);
  if (payloadStart < 0 || payloadEnd < 0)
    throw new Error("Legacy email composition not recognized");
  // Preserve the legacy sender while downstream v2 support is being verified.
  once(
    "notification_next_attempt_at=datetime('now','+5 minutes')",
    "notification_next_attempt_at=datetime('now','+10 minutes')",
  );
  once(
    "    const response = await fetch(endpoint.toString(), {",
    `    const v2 = env.CALL_SUMMARY_FORMAT === 'v2' ? await prepareNotification(env, row) : null; // CALL_SUMMARY_V2\n    const response = await fetch(endpoint.toString(), {`,
  );
  once(
    "      body: JSON.stringify({\n        token: env.NOTIFICATION_SECRET,",
    "      body: JSON.stringify({\n        ...(v2 || {}),\n        token: env.NOTIFICATION_SECRET,",
  );
  once(
    "        summary: emailSummary,",
    "        summary: v2 ? v2.text : emailSummary,",
  );
  once(
    "    if (result?.ok !== true) {",
    "    if (v2) validateAcknowledgement(result, row.call_id);\n    if (result?.ok !== true) {",
  );
  // Modules cannot change dial/DTMF/auth paths. Only sendOne and selected data change.
  const before = source.slice(0, start),
    after = source.slice(end);
  const sqlOld =
    "s.id, s.call_id, s.summary_it, c.created_at,\n      c.direction, o.id AS outbound_request_id,";
  const sqlNew =
    "s.id, s.call_id, s.summary_it, c.created_at, c.started_at, c.ended_at, c.status,\n      c.direction, o.id AS outbound_request_id,";
  if (after.split(sqlOld).length !== 2)
    throw new Error("Notification query changed");
  let output =
    `import { prepareNotification, validateAcknowledgement } from ${JSON.stringify(modulePath)};\n` +
    before +
    region +
    after.replace(sqlOld, sqlNew);
  // Extraction/translation can exceed the 30-second post-response lifetime.
  // Keep durable pending rows and let the EXISTING cron run them (15-minute
  // scheduled lifetime); do not change the webhook acknowledgement or voice.
  const background = "if (outcome.summaryPresent) {";
  if (output.split(background).length !== 2)
    throw new Error("Insight dispatch changed");
  output = output.replace(
    background,
    "if (outcome.summaryPresent && env.CALL_SUMMARY_FORMAT !== 'v2') {",
  );
  output = output.replace(
    "const rows = await getEligible(db, limit);",
    "const rows = await getEligible(db, env.CALL_SUMMARY_FORMAT === 'v2' ? 1 : limit);",
  );
  return {
    source: output,
    validation: {
      notification_only: true,
      original_sha256: createHash("sha256").update(source).digest("hex"),
      protected_prefix_sha256: createHash("sha256")
        .update(before)
        .digest("hex"),
      protected_suffix_sha256: createHash("sha256")
        .update(after.replace(sqlOld, sqlNew))
        .digest("hex"),
    },
  };
}
