// The phone entry is an operator-owned private snapshot. Only change the
// initial outbound summary operand; inbound and webhook idempotency stay intact.
export const provisionalSummary =
  "Esito in verifica. Il riepilogo della chiamata outbound non è ancora stato validato sulle risposte del destinatario. Nessuna disponibilità o prenotazione può essere considerata confermata in questa fase.";
const original = ").bind(crypto.randomUUID(), callId, summary));";
const replacement =
  ").bind(crypto.randomUUID(), callId, resolved.direction === 'outbound' && env.CALL_SUMMARY_FORMAT === 'v2' ? " +
  JSON.stringify(provisionalSummary) +
  " : summary)); // OUTBOUND_PROVISIONAL_SUMMARY";
export function patchOutboundSummaryProvisional(source) {
  if (
    source.split(original).length !== 2 ||
    source.includes("OUTBOUND_PROVISIONAL_SUMMARY")
  )
    throw Error("Unrecognized or already patched summary insertion");
  return source.replace(original, replacement);
}
export function restoreOutboundSummaryProvisional(source) {
  if (source.split(replacement).length !== 2)
    throw Error("Unrecognized provisional summary patch");
  return source.replace(replacement, original);
}
