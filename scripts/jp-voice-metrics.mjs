// Normalized analysis format, NOT undocumented native Telnyx event names.
// A transcription fragment is never counted as an audio interruption.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};
export function metrics(trace) {
  if (
    !["synthetic", "observed"].includes(trace.source) ||
    !Array.isArray(trace.events)
  )
    throw new Error("Explicit provenance and events required");
  const events = trace.events;
  for (const e of events)
    if (!Number.isFinite(e.at_ms) || e.at_ms < 0 || !e.type)
      throw new Error("Invalid timestamp/event");
  const paired = (start, end) =>
    events
      .filter(
        (e) =>
          e.type === start &&
          typeof e.turn_id === "string" &&
          typeof e.clock === "string",
      )
      .flatMap((a) => {
        const b = events.find(
          (e) =>
            e.type === end &&
            e.turn_id === a.turn_id &&
            e.clock === a.clock &&
            e.at_ms >= a.at_ms,
        );
        return b ? [b.at_ms - a.at_ms] : [];
      });
  const response = paired("caller_speech_end", "assistant_first_audio");
  const model = paired("model_request_sent", "model_first_audio");
  const cuts = events.filter((e) => e.type === "assistant_playback_cut");
  const annotations = trace.caller_annotations ?? {};
  const known = cuts.filter((e) => annotations[e.utterance_id]);
  const unwanted = known.filter(
    (e) => annotations[e.utterance_id] === "backchannel",
  ).length;
  const clauses =
    trace.clause_checks?.filter((c) => typeof c.complete === "boolean") ?? [];
  const details =
    trace.detail_checks?.filter(
      (c) =>
        c.status !== "unknown" &&
        Object.hasOwn(c, "expected") &&
        Object.hasOwn(c, "observed"),
    ) ?? [];
  const duration = (start, end) => {
    const a = events.find((e) => e.type === start),
      b = events.find((e) => e.type === end);
    return a && b && a.clock === b.clock && b.at_ms >= a.at_ms
      ? b.at_ms - a.at_ms
      : null;
  };
  return {
    source: trace.source,
    provider_performance_measured:
      trace.source === "observed" && response.length > 0,
    response_latency: {
      n: response.length,
      p50_ms: percentile(response, 0.5),
      p95_ms: percentile(response, 0.95),
    },
    model_first_audio_latency: {
      n: model.length,
      p50_ms: percentile(model, 0.5),
      p95_ms: percentile(model, 0.95),
    },
    playback_cuts: cuts.length,
    unwanted_interruptions: known.length ? unwanted : null,
    unclassified_cuts: cuts.length - known.length,
    clause_completion: clauses.length
      ? clauses.filter((c) => c.complete).length / clauses.length
      : null,
    detail_accuracy: details.length
      ? details.filter(
          (c) => JSON.stringify(c.expected) === JSON.stringify(c.observed),
        ).length / details.length
      : null,
    transport_setup: {
      answer_to_rtp_ms: duration("call_answered", "rtp_streaming_start"),
      answer_to_conversation_ms: duration(
        "call_answered",
        "conversation_created",
      ),
      answer_to_playback_engine_ms: duration("call_answered", "playback_start"),
      answer_to_stream_ms: duration("call_answered", "stream_start"),
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(
        metrics(JSON.parse(readFileSync(process.argv[2], "utf8"))),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
