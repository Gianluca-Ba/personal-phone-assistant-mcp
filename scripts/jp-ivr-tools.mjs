// Only documented native Telnyx schemas. Never mutates a shared tool definition.
import { readFileSync } from "node:fs";
export function outboundTools() {
  return [
    {
      type: "hangup",
      hangup: {
        description:
          "End an outbound call only after the assistant has completely spoken its farewell and the recipient has finished. Never end during a hold, pending question or unfinished audio.",
      },
    },
    { type: "send_dtmf", send_dtmf: {} },
  ];
}
export function outboundDelegation(base) {
  if (!base?.model) throw new Error("Existing backend model required");
  return {
    ...base,
    enabled: true,
    instructions: readFileSync(
      new URL("../voice/jp/delegation-policy.txt", import.meta.url),
      "utf8",
    ),
    speak_results: false,
  };
}
export function dtmfAttempts(events) {
  return events
    .filter(
      (e) =>
        e.type === "response.tool_call.started" &&
        /dtmf/i.test(e.tool_call?.name ?? ""),
    )
    .map((e) => {
      try {
        return JSON.parse(e.tool_call.arguments);
      } catch {
        return { invalid_arguments: true };
      }
    });
}
