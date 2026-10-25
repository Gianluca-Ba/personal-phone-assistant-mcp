import { parse as parseConfig } from "jsonc-parser";
import { readFileSync } from "node:fs";
const auth = parseConfig(
  readFileSync(
    new URL("../workers/auth/wrangler.jsonc", import.meta.url),
    "utf8",
  ),
);
const mcp = parseConfig(
  readFileSync(
    new URL("../workers/mcp/wrangler.jsonc", import.meta.url),
    "utf8",
  ),
);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (
  auth.name !== "personal-phone-assistant-auth" ||
  mcp.name !== "personal-phone-assistant-mcp"
)
  fail("Only the two integration Workers may be deployed.");
if (auth.main !== "src/index.ts" || mcp.main !== "src/index.ts")
  fail(
    "Only production entrypoints may be deployed; test fixtures are prohibited.",
  );
if (
  auth.kv_namespaces[0].id.includes("REPLACE") ||
  mcp.d1_databases[0].database_id.includes("REPLACE")
)
  fail(
    "Configure the existing KV and D1 IDs first: npm run configure -- --kv-id ... --d1-id ...",
  );
if (auth.vars.OWNER_TOKEN_VERSION !== mcp.vars.OWNER_TOKEN_VERSION)
  fail("OWNER_TOKEN_VERSION must match in both Worker configs.");
if (
  !["false", "true"].includes(mcp.vars.OUTBOUND_EXECUTION_ENABLED) ||
  (mcp.vars.OUTBOUND_EXECUTION_ENABLED === "true" &&
    mcp.vars.OUTBOUND_CONFIRMATION_POLICY !== "conversation-policy-v1")
)
  fail(
    "Execution requires the explicit conversation-policy-v1 operational policy.",
  );
const policy = mcp.vars.OUTBOUND_DESTINATION_POLICY ?? "allowlist";
if (!["allowlist", "all_standard"].includes(policy))
  fail("Unknown outbound destination policy.");
if (mcp.vars.OUTBOUND_ENABLED === "true") {
  if (mcp.vars.OUTBOUND_CONTRACT_VERIFIED !== "true")
    fail("Outbound requires a verified upstream contract.");
  if (
    policy === "allowlist" &&
    !JSON.parse(mcp.vars.OUTBOUND_ALLOWED_DESTINATIONS ?? "[]").length &&
    mcp.vars.OUTBOUND_PRIVATE_ALLOWLIST_CONFIGURED !== "true"
  )
    fail("Allowlist mode requires a destination allowlist.");
  if (policy === "all_standard") {
    const knownTypes = [
      "MOBILE",
      "FIXED_LINE",
      "FIXED_LINE_OR_MOBILE",
      "VOIP",
      "PREMIUM_RATE",
      "TOLL_FREE",
      "SHARED_COST",
      "PERSONAL_NUMBER",
      "PAGER",
      "UAN",
      "VOICEMAIL",
    ];
    for (const [name, valid] of [
      ["OUTBOUND_BLOCKED_PREFIXES", (value) => /^\+[1-9]\d{0,14}$/.test(value)],
      [
        "OUTBOUND_BLOCKED_DESTINATIONS",
        (value) => /^\+[1-9]\d{1,14}$/.test(value),
      ],
      ["OUTBOUND_BLOCKED_NUMBER_TYPES", (value) => knownTypes.includes(value)],
    ]) {
      try {
        const values = JSON.parse(mcp.vars[name] ?? "[]");
        if (
          !Array.isArray(values) ||
          values.length > 1000 ||
          !values.every((value) => typeof value === "string" && valid(value))
        )
          throw new Error();
      } catch {
        fail("Invalid destination restriction configuration: " + name);
      }
    }
  }
}
console.log("Integration Worker configuration verified.");
