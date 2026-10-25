import {
  isBackchannel,
  normalizeJapaneseTurn,
  isHoldRequest,
  isHoldReturn,
} from "../../../scripts/jp-backchannel.mjs";
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
// Bounded per-connection transcript assembly. Repeated words are not an event
// identity: identical answers on distinct turns must reach the conversation.
export class SttTurns {
  constructor({
    onStart,
    onInterim,
    onFinal,
    onEnd = (_event) => {},
    maxTracked = 512,
    maxChars = 16384,
  }) {
    this.onStart = onStart;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onEnd = onEnd;
    this.maxTracked = maxTracked;
    this.maxChars = maxChars;
    this.reset();
  }
  reset() {
    this.ended = new Set();
    this.started = new Set();
    this.legacyCommitted = new Set();
    this.seenFlux = false;
    this.pending = "";
    this.segments = [];
    this.pendingKeys = new Set();
    this.legacyOpen = false;
    this.anonymous = 0;
    this.anonymousOpen = null;
    this.closed = false;
  }
  close() {
    this.reset();
    this.closed = true;
  }
  remember(set, key) {
    set.add(key);
    while (set.size > this.maxTracked) set.delete(set.values().next().value);
  }
  legacyKey(frame) {
    if (typeof frame.segment_id === "string" && frame.segment_id)
      return "segment:" + frame.segment_id;
    if (Number.isFinite(frame.start))
      return (
        "audio:" +
        frame.start +
        ":" +
        (Number.isFinite(frame.duration) ? frame.duration : "")
      );
    return null;
  }
  startLegacy() {
    if (!this.legacyOpen) {
      this.legacyOpen = true;
      this.onStart();
    }
  }
  mergeLegacy(text, key) {
    if (key !== null) {
      this.remember(this.pendingKeys, key);
      const index = this.segments.findIndex((segment) => segment.key === key);
      if (index >= 0) this.segments[index].text = text;
      else this.segments.push({ key, text });
      // Distinct source ranges can legitimately contain identical words.
      let assembled = "";
      for (const part of this.segments)
        assembled = appendSegment(assembled, part.text);
      this.pending = assembled;
    } else {
      const merged = mergeUnidentified(this.pending, text);
      // Keep identified segment slots when the provider also emits a
      // cumulative alias; a later corrected final for that slot must replace it.
      if (merged.startsWith(this.pending)) {
        const suffix = merged.slice(this.pending.length);
        if (suffix) this.segments.push({ key: null, text: suffix });
      } else this.segments = [{ key: null, text: merged }];
      this.pending = merged;
    }
    if (
      this.pending.length > this.maxChars ||
      this.segments.length > this.maxTracked
    )
      throw Error("Speech recognition buffer limit");
  }
  accept(frame) {
    if (this.closed) return;
    if (frame.errors) throw Error("Speech recognition error");
    const text =
      typeof frame.transcript === "string" ? frame.transcript.trim() : "";
    if (text.length > this.maxChars)
      throw Error("Speech recognition buffer limit");
    if (frame.type === "TurnInfo") {
      this.seenFlux = true;
      const indexed =
        Number.isInteger(frame.turn_index) ||
        (typeof frame.turn_index === "string" && frame.turn_index.length > 0);
      let key;
      if (indexed)
        key = String(frame.request_id ?? "") + ":" + frame.turn_index;
      else {
        if (this.anonymousOpen === null) this.anonymousOpen = ++this.anonymous;
        key = "anonymous:" + this.anonymousOpen;
      }
      if (this.ended.has(key)) return;
      if (!this.started.has(key)) {
        this.remember(this.started, key);
        this.onStart();
      }
      if (text && frame.event !== "EndOfTurn") this.onInterim(text);
      if (frame.event === "EndOfTurn") {
        this.remember(this.ended, key);
        if (!indexed) this.anonymousOpen = null;
        if (text) this.onFinal(text);
        this.onEnd({ hasTranscript: Boolean(text) });
      }
      return;
    }
    // This provider emits both Flux events and their normalized copies on one
    // connection. Do not treat those copies as additional human turns. reset()
    // must be used when replacing/reconnecting the recognition connection.
    if (this.seenFlux) return;
    const key = this.legacyKey(frame);
    if (frame.is_final && key !== null && this.legacyCommitted.has(key)) return;
    if (text) this.startLegacy();
    if (text && !frame.is_final) this.onInterim(text);
    if (frame.is_final && text) this.mergeLegacy(text, key);
    if (frame.speech_final || frame.utterance_end) {
      const final = this.pending.trim();
      const wasOpen = this.legacyOpen;
      for (const key of this.pendingKeys)
        this.remember(this.legacyCommitted, key);
      this.pending = "";
      this.segments = [];
      this.pendingKeys.clear();
      this.legacyOpen = false;
      if (final) this.onFinal(final);
      if (wasOpen || final) this.onEnd({ hasTranscript: Boolean(final) });
    }
  }
}

function appendSegment(previous, next) {
  if (!previous) return next;
  const space =
    /[A-Za-z0-9.!?]$/.test(previous) && /^[A-Za-z0-9]/.test(next) ? " " : "";
  return previous + space + next;
}
function mergeUnidentified(previous, next) {
  if (!previous || next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  // Some normalized finals are overlapping chunks rather than cumulative text.
  // Do not remove a single repeated character, which may be a genuine word.
  for (let n = Math.min(previous.length, next.length, 512); n >= 2; n--)
    if (previous.endsWith(next.slice(0, n))) return previous + next.slice(n);
  return appendSegment(previous, next);
}

// These are semantic cues, not a replacement for the provider's acoustic VAD.
// A request to wait must yield the floor; a return from hold must be heard.
const interruption =
  /待って|ちょっと|違い|違う|違います|違って|ではなく|じゃなく|訂正|変更|やめて|止めて|質問|何時|いつ|どちら|どういう|どなた|お名前|ご用件|もう一度|繰り返|聞こえ|聞き取れ|すみません|もしもし|いいえ|いや[、。]|いえ[、。]|[?？]/;

export function classifyRecipientTurn(text, { overlapped = false } = {}) {
  const value = normalizeJapaneseTurn(text);
  if (isHoldRequest(value)) return { kind: "hold_request", interrupt: true };
  if (isHoldReturn(value)) return { kind: "hold_return", interrupt: true };
  if (isBackchannel(value))
    return { kind: overlapped ? "backchannel" : "speech", interrupt: false };
  if (interruption.test(value))
    return { kind: "interruption", interrupt: true };
  return { kind: "speech", interrupt: false };
}
export const genuineInterruption = (text) =>
  classifyRecipientTurn(text).interrupt;
