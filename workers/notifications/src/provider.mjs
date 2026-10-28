import { buildSummary, infer, renderSummary } from "./summary.mjs";
function failure(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

export async function fetchConversation(env, callId, fetcher = fetch) {
  if (!/^[a-f0-9-]{36}$/i.test(callId)) throw failure("InvalidConversationId");
  const messages = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.telnyx.com/v2/ai/conversations/${encodeURIComponent(callId)}/messages?page%5Bnumber%5D=${page}&page%5Bsize%5D=100`;
    const r = await fetcher(url, {
      headers: { authorization: `Bearer ${env.TELNYX_API_KEY}` },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    if (r.status === 404) return { messages: [], complete: false };
    if (!r.ok) throw failure("TranscriptLookupHTTPFailure");
    const b = await r.json();
    if (!Array.isArray(b.data)) throw failure("TranscriptLookupFormatFailure");
    messages.push(...b.data);
    const total = Number(b.meta?.total_pages);
    if (Number.isFinite(total) && total >= 0 && page >= total)
      return { messages, complete: true };
    // Without pagination metadata the provider's completeness is not provable.
    if (!Number.isFinite(total) && b.data.length < 100)
      return { messages, complete: false };
  }
  return { messages, complete: false };
}
export async function prepareNotification(env, row) {
  const deadline = Date.now() + 8 * 60 * 1000;
  const conversation = await fetchConversation(env, row.call_id);
  const voiceEvidence =
    row.direction === "outbound" ? await fetchVoiceEvidence(env, row) : null;
  const summary = await buildSummary(row, conversation.messages, {
    complete: conversation.complete,
    voiceEvidence,
    infer: (system, input) => {
      if (Date.now() > deadline) throw failure("SummaryProcessingDeadline");
      return infer(env, system, input);
    },
  });
  await persistOutboundSummary(env, row, summary);
  return renderSummary(summary);
}
export async function persistOutboundSummary(env, row, summary) {
  // Only the already-claimed pending notification may replace its unvalidated
  // provider summary. Do not rewrite sent history or touch inbound notes.
  if (
    row.direction !== "outbound" ||
    !row.outbound_request_id ||
    !row.id ||
    !env["phone-assistant-db"]
  )
    return;
  const result = await env["phone-assistant-db"]
    .prepare(
      `
    UPDATE call_summaries SET summary_it = ?
    WHERE id = ? AND call_id = ? AND summary_it = ?
      AND notification_status = 'sending'
      AND EXISTS (SELECT 1 FROM outbound_requests
        WHERE id = ? AND conversation_id = ?)
  `,
    )
    .bind(
      `${summary.title_it}. ${summary.summary_it}`,
      row.id,
      row.call_id,
      row.summary_it,
      row.outbound_request_id,
      row.call_id,
    )
    .run();
  if (result.meta?.changes !== 1) throw failure("SummaryPersistenceConflict");
}
export async function fetchVoiceEvidence(env, row, fetcher = fetch) {
  const unknown = { state: "unavailable" };
  if (
    row.direction !== "outbound" ||
    !row.outbound_request_id ||
    !/^[a-f0-9-]{36}$/i.test(row.call_id)
  )
    return unknown;
  try {
    const r = await fetcher(
      `https://api.telnyx.com/v2/ai/conversations/${encodeURIComponent(row.call_id)}`,
      {
        headers: { authorization: `Bearer ${env.TELNYX_API_KEY}` },
        signal: AbortSignal.timeout(10000),
        redirect: "manual",
      },
    );
    if (!r.ok) return unknown;
    const raw = await r.json(),
      c = raw.data ?? raw,
      m = c.metadata;
    if (
      c.id !== row.call_id ||
      m?.outbound_request_id !== row.outbound_request_id ||
      m.direction !== "outbound" ||
      m.voice_output_audit_final !== "true"
    )
      return unknown;
    const audit =
      typeof m.voice_output_audit === "string"
        ? JSON.parse(m.voice_output_audit)
        : m.voice_output_audit;
    if (
      !audit ||
      !Number.isSafeInteger(audit.released_pcm_bytes) ||
      audit.released_pcm_bytes < 0 ||
      !Number.isSafeInteger(audit.released_responses) ||
      audit.released_responses < 0 ||
      (audit.released_pcm_bytes === 0) !== (audit.released_responses === 0)
    )
      return unknown;
    return {
      state:
        audit.released_pcm_bytes === 0
          ? "no_model_audio"
          : "model_audio_released",
    };
  } catch {
    // Missing telemetry is uncertainty, never proof of transmission or silence.
    return unknown;
  }
}
export function validateAcknowledgement(result, callId) {
  if (result?.error === "delivery_outcome_unknown")
    throw failure("SummaryDeliveryOutcomeUnknown");
  if (
    result?.ok !== true ||
    result?.version !== 2 ||
    result?.call_id !== callId
  )
    throw failure("SummaryDeliveryContractMismatch");
}
