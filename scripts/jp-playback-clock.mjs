// A client-side PCM queue estimate, not proof of carrier playback.
export class PlaybackClock {
  end = 0;
  lastClear = null;
  append(bytes, sampleRate, at) {
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      !Number.isFinite(sampleRate) ||
      sampleRate <= 0 ||
      !Number.isFinite(at)
    )
      throw new Error("Invalid PCM clock input");
    this.end = Math.max(this.end, at) + (bytes / (sampleRate * 2)) * 1000;
  }
  clear(at) {
    this.end = at;
    this.lastClear = at;
  }
  remaining(at) {
    return Math.max(0, this.end - at);
  }
}
