import { parse as parseConfig } from "jsonc-parser";
import "./preflight.mjs";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const config = parseConfig(
  readFileSync(
    new URL("../workers/auth/wrangler.jsonc", import.meta.url),
    "utf8",
  ),
);
// First publish AuthServer without the reverse approval binding. Nothing touches the phone Worker.
config.services = [];
config.main = fileURLToPath(
  new URL("../workers/auth/src/index.ts", import.meta.url),
);
const temporary = mkdtempSync(join(tmpdir(), "phone-auth-bootstrap-"));
try {
  const path = join(temporary, "wrangler.json");
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
      "deploy",
      "--config",
      path,
    ],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
