// Offline macOS speech fixtures only; does not connect to Telnyx or place calls.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const corpus = JSON.parse(
  readFileSync(new URL("../voice/jp/scenarios.json", import.meta.url), "utf8"),
);
const out = resolve(process.argv[2] ?? ".wrangler/jp-voice/audio");
mkdirSync(out, { recursive: true, mode: 0o700 });
const results = [];
for (const [speaker, voice] of corpus.voices.entries())
  for (const s of corpus.scenarios) {
    const base = join(out, `${speaker}-${s.id}`),
      aiff = base + ".aiff",
      wav = base + ".wav";
    execFileSync(
      "/usr/bin/say",
      ["-v", voice, "-r", speaker === 0 ? "165" : "180", "-o", aiff, s.text],
      { stdio: "pipe" },
    );
    execFileSync(
      "/usr/bin/afconvert",
      ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav],
      { stdio: "pipe" },
    );
    rmSync(aiff);
    const b = readFileSync(wav);
    let bytes = 0,
      rate = 0,
      channels = 0,
      bits = 0;
    for (let p = 12; p + 8 <= b.length;) {
      const id = b.toString("ascii", p, p + 4),
        size = b.readUInt32LE(p + 4);
      if (id === "fmt ") {
        channels = b.readUInt16LE(p + 10);
        rate = b.readUInt32LE(p + 12);
        bits = b.readUInt16LE(p + 22);
      }
      if (id === "data") bytes = size;
      p += 8 + size + (size % 2);
    }
    if (rate !== 16000 || channels !== 1 || bits !== 16 || !bytes)
      throw new Error("Unexpected PCM format");
    results.push({
      speaker,
      voice,
      scenario: s.id,
      file: wav.split("/").at(-1),
      duration_ms: (bytes / ((rate * channels * bits) / 8)) * 1000,
      sha256: createHash("sha256").update(b).digest("hex"),
      context: s.context,
      expected: s.expected,
      trigger: s.context.startsWith("during_")
        ? "assistant_audio_started"
        : "caller_turn",
      offset_ms: s.offset_ms,
    });
  }
const manifest = {
  source: "offline_synthetic_speech",
  provider_run: false,
  sample_rate: 16000,
  channels: 1,
  clips: results,
};
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    clips: results.length,
    total_audio_seconds: results.reduce((n, r) => n + r.duration_ms, 0) / 1000,
    provider_run: false,
    real_calls: 0,
  }),
);
