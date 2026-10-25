import { isBackchannel } from "../../../scripts/jp-backchannel.mjs";
import { decodeMuLaw } from "./audio.mjs";
export class MediaActivity {
  constructor({ now, onStart, onStop }) {
    this.now = now;
    this.onStart = onStart;
    this.onStop = onStop;
    this.active = false;
    this.lastVoice = null;
  }
  observe(bytes) {
    const pcm = decodeMuLaw(bytes);
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, pcm.length / 2));
    if (rms >= 200) {
      this.lastVoice = this.now();
      if (!this.active) {
        this.active = true;
        this.onStart();
      }
    } else this.tick();
  }
  tick() {
    if (
      this.active &&
      this.lastVoice !== null &&
      this.now() - this.lastVoice >= 320
    ) {
      this.active = false;
      this.onStop();
    }
  }
}
export class SttTurns {
  constructor({ onStart, onInterim, onFinal }) {
    this.onStart = onStart;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.ended = new Set();
    this.seenFlux = false;
    this.pending = "";
  }
  accept(frame) {
    if (frame.errors) throw Error("Speech recognition error");
    if (frame.type === "TurnInfo") {
      this.seenFlux = true;
      const key = String(frame.request_id ?? "") + ":" + frame.turn_index;
      if (frame.event === "StartOfTurn") this.onStart();
      if (frame.transcript && frame.event !== "EndOfTurn")
        this.onInterim(frame.transcript);
      if (frame.event === "EndOfTurn" && !this.ended.has(key)) {
        this.ended.add(key);
        if (frame.transcript?.trim()) this.onFinal(frame.transcript.trim());
      }
      return;
    }
    if (this.seenFlux) return; // Telnyx also emits a normalized copy of each Flux final.
    if (frame.transcript && !frame.is_final) {
      this.onStart();
      this.onInterim(frame.transcript);
    }
    if (frame.is_final && frame.transcript) {
      this.pending = frame.transcript.startsWith(this.pending)
        ? frame.transcript
        : this.pending + frame.transcript;
    }
    if (frame.speech_final || frame.utterance_end) {
      if (this.pending.trim()) this.onFinal(this.pending.trim());
      this.pending = "";
    }
  }
}
export const genuineInterruption = (text) =>
  !isBackchannel(text) &&
  /待って|待ちください|ちょっと|違い|違う|ではなく|質問|何時|いつ|もう一度|聞こえ|すみません/.test(
    text,
  );
