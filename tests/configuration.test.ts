import { parse as parseConfig } from "jsonc-parser";
import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("configuration scripts accept JSONC, reject placeholders, and never target the phone Worker", () => {
  mkdirSync(resolve(".wrangler"), { recursive: true });
  const temp = mkdtempSync(resolve(".wrangler/config-test-"));
  try {
    for (const path of ["scripts", "workers/auth", "workers/mcp"])
      mkdirSync(join(temp, path), { recursive: true });
    for (const file of [
      "scripts/preflight.mjs",
      "scripts/configure.mjs",
      "workers/auth/wrangler.jsonc",
      "workers/mcp/wrangler.jsonc",
    ])
      copyFileSync(file, join(temp, file));
    const authPath = join(temp, "workers/auth/wrangler.jsonc");
    const authConfig = parseConfig(readFileSync(authPath, "utf8"));
    authConfig.kv_namespaces[0].id = "REPLACE_WITH_EXISTING_OAUTH_KV_ID";
    writeFileSync(authPath, JSON.stringify(authConfig));
    const run = (script: string, args: string[] = []) =>
      spawnSync(process.execPath, [join(temp, "scripts", script), ...args], {
        encoding: "utf8",
      });
    expect(run("preflight.mjs").status).toBe(1);
    expect(
      run("configure.mjs", [
        "--kv-id",
        "a".repeat(32),
        "--d1-id",
        "b".repeat(32),
      ]).status,
    ).toBe(0);
    expect(run("preflight.mjs").status).toBe(0);
    const configured = JSON.parse(
      readFileSync(join(temp, "workers/mcp/wrangler.jsonc"), "utf8"),
    );
    expect(configured.name).toBe("personal-phone-assistant-mcp");
    expect(configured.d1_databases[0].database_id).toBe("b".repeat(32));
    configured.vars.OUTBOUND_EXECUTION_ENABLED = "true";
    configured.vars.OUTBOUND_CONFIRMATION_POLICY = "model-confirmed";
    writeFileSync(
      join(temp, "workers/mcp/wrangler.jsonc"),
      JSON.stringify(configured),
    );
    expect(run("preflight.mjs").status).toBe(1);
    configured.vars.OUTBOUND_CONFIRMATION_POLICY = "conversation-policy-v1";
    writeFileSync(
      join(temp, "workers/mcp/wrangler.jsonc"),
      JSON.stringify(configured),
    );
    expect(run("preflight.mjs").status).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
