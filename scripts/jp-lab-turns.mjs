import { isBackchannel } from "./jp-backchannel.mjs";

// Forward only a real provider transcript; an activity event or overlapping
// aizuchi is not an answer. Kept pure so offline tests never run the provider lab.
export function forwardLabRecipientEvent(
  controller,
  event,
  { overlapped = false, answerWindow = false } = {},
) {
  controller.event(event);
  if (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.transcript === "string" &&
    event.transcript.trim() &&
    !(overlapped && !answerWindow && isBackchannel(event.transcript))
  )
    controller.event({ type: "recipient_answer" });
}
