// Build from operator-owned private snapshots; never fetch or print secrets.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { patchPhoneSummary } from "./patch-phone-summary.mjs";
import { patchAppsScript } from "./patch-apps-script-summary.mjs";
const [
  phoneSource,
  gasSource,
  phoneConfig,
  outDir = ".wrangler/summary-release",
] = process.argv.slice(2);
if (!phoneSource || !gasSource || !phoneConfig)
  throw Error(
    "Usage: prepare-summary-release.mjs PHONE_SOURCE GAS_SOURCE PHONE_CONFIG [PRIVATE_OUTPUT_DIR]",
  );
const config = JSON.parse(readFileSync(phoneConfig, "utf8"));
if (config.name !== "personal-phone-assistant" || !config.keep_vars)
  throw Error("Expected existing phone Worker with keep_vars");
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const p = patchPhoneSummary(
  readFileSync(phoneSource, "utf8"),
  resolve("workers/notifications/src/provider.mjs"),
);
const write = (name, value) =>
  writeFileSync(resolve(outDir, name), value, { mode: 0o600 });
write("phone.mjs", p.source);
write("notifications.gs", patchAppsScript(readFileSync(gasSource, "utf8")));
config.main = resolve(outDir, "phone.mjs");
// Do not let Wrangler implicitly expose version-preview URLs.
config.preview_urls ??= false;
config.vars = {
  ...config.vars,
  CALL_SUMMARY_FORMAT: "v2",
  SUMMARY_MODEL: "meta-llama/Llama-3.3-70B-Instruct",
};
write("wrangler.json", JSON.stringify(config, null, 2));
write("validation.json", JSON.stringify(p.validation, null, 2));
console.log(
  "Notification-only release prepared in private output directory. Verify existing cron and Apps Script v2 capability before deploying.",
);
