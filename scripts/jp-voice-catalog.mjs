// Read-only provider catalog snapshot for reproducible lab voice selection.
import { mkdirSync, writeFileSync } from "node:fs";
if (!process.env.TELNYX_API_KEY)
  throw new Error("Local Telnyx credential required");
const r = await fetch("https://api.telnyx.com/v2/text-to-speech/voices", {
  headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY },
  redirect: "error",
  signal: AbortSignal.timeout(30000),
});
if (!r.ok) throw new Error("Voice catalog HTTP " + r.status);
const body = await r.json();
if (!Array.isArray(body.voices))
  throw new Error("Unexpected voice catalog shape");
mkdirSync(".wrangler/jp-voice", { recursive: true, mode: 0o700 });
writeFileSync(".wrangler/jp-voice/voices.json", JSON.stringify(body, null, 2), {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    snapshot_saved: true,
    eligible_japanese_hosted_voices: body.voices.filter(
      (v) => v.hosted && !v.deprecated && /^ja/.test(v.language),
    ).length,
  }),
);
