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
  const summary = await buildSummary(row, conversation.messages, {
    complete: conversation.complete,
    infer: (system, input) => {
      if (Date.now() > deadline) throw failure("SummaryProcessingDeadline");
      return infer(env, system, input);
    },
  });
  return renderSummary(summary);
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
