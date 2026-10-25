// Sanitized evidence review. Nonzero exit means no production release.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { evaluateRun, evaluateGuardedRun } from "./jp-voice-verdict.mjs";
const directories = process.argv.slice(2);
if (!directories.length)
  throw new Error("Supply private virtual-run directories");
const cases = [
  ...JSON.parse(readFileSync("voice/jp/ivr-scenarios.json")).scenarios,
  ...JSON.parse(readFileSync("voice/jp/end-call-scenarios.json")).scenarios,
];
const results = [];
for (const directory of directories)
  for (const file of readdirSync(directory).filter((n) =>
    n.endsWith(".json"),
  )) {
    const raw = readFileSync(join(directory, file));
    const run = JSON.parse(raw);
    const scenario = cases.find((s) => s.id === run.summary?.scenario);
    if (!scenario) continue;
    results.push({
      ...(run.summary.configured_tools?.every((t) => t === "client_side_tool")
        ? evaluateGuardedRun(run, scenario)
        : evaluateRun(run, scenario)),
      source_sha256: createHash("sha256").update(raw).digest("hex"),
      assistant_version: run.summary.assistant_version ?? null,
      backend_model: run.summary.backend_model ?? null,
    });
  }
const missing = cases
  .filter((s) => !results.some((r) => r.scenario === s.id))
  .map((s) => s.id);
const report = {
  production_ready: false,
  provenance: "Actual Telnyx virtual audio session evidence; no PSTN",
  real_calls: 0,
  passed:
    results.length > 0 &&
    results.every((r) => r.passed) &&
    missing.length === 0,
  missing_scenarios: missing,
  results,
};
if (process.env.JP_VOICE_REPORT)
  writeFileSync(
    process.env.JP_VOICE_REPORT,
    JSON.stringify(report, null, 2) + "\n",
  );
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
