// Telnyx media-stream marks acknowledge queued audio. Clear also echoes marks:
// invalidate first, otherwise a barge-in could be mistaken for playback completion.
import { randomUUID } from "node:crypto";
export class PlaybackMarks {
  constructor({ sendMark, onPlayed, token = randomUUID }) {
    this.sendMark = sendMark;
    this.onPlayed = onPlayed;
    this.token = token;
    this.pending = new Map();
    this.byResponse = new Map();
    this.generation = 0;
  }
  commit(responseId, hasAudio) {
    if (!hasAudio) return null;
    if (this.byResponse.has(responseId)) return this.byResponse.get(responseId);
    const name = this.token();
    this.byResponse.set(responseId, name);
    this.pending.set(name, { responseId, generation: this.generation });
    this.sendMark({ event: "mark", mark: { name } });
    return name;
  }
  acknowledge(name) {
    const entry = this.pending.get(name);
    if (!entry) return false;
    this.pending.delete(name);
    if (entry.generation !== this.generation) return false;
    this.onPlayed(entry.responseId);
    return true;
  }
  clear(sendClear) {
    this.generation++;
    this.pending.clear();
    this.byResponse.clear();
    sendClear({ event: "clear" });
  }
}
