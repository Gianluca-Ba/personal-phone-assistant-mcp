import { sha256 } from "./security.mjs";
export function dialPayload(context, env) {
  if (
    !/^\d+$/.test(env.VOICE_APP_ID ?? "") ||
    !env.VOICE_ORIGIN?.startsWith("https://")
  )
    throw new Error("Voice configuration unavailable");
  return {
    connection_id: env.VOICE_APP_ID,
    from: context.from,
    to: context.destination,
    command_id: context.request_id,
    timeout_secs: 30,
    time_limit_secs: 300,
    record: "record-from-answer",
    record_channels: "dual",
    record_format: "mp3",
    record_track: "both",
    stream_url: context.stream_url,
    stream_track: "inbound_track",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
    stream_bidirectional_sampling_rate: 8000,
    stream_bidirectional_target_legs: "self",
    webhook_url: env.VOICE_ORIGIN + "/webhooks/telnyx",
    webhook_url_method: "POST",
    client_state: Buffer.from(
      JSON.stringify({ request_id: context.request_id, nonce: context.nonce }),
    ).toString("base64"),
  };
}
export function taskFingerprint(row) {
  return sha256(
    JSON.stringify({
      destination: row.destination_number,
      instructions: row.instructions,
      language: row.language ?? "auto",
      callback: row.callback_token,
    }),
  );
}
export function statusForEnd(payload, answered) {
  if (answered) return "completed";
  const cause = payload.hangup_cause ?? "";
  if (/busy/i.test(cause)) return "busy";
  if (/no_answer|timeout/i.test(cause)) return "no-answer";
  if (/cancel/i.test(cause)) return "canceled";
  return "failed";
}
