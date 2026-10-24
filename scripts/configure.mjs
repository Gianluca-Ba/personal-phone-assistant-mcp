import { parse as parseConfig } from "jsonc-parser";
import { readFileSync, writeFileSync } from "node:fs";
const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
    process.argv[2 + i * 2],
    process.argv[3 + i * 2],
  ]),
);
if (
  !/^[a-f0-9]{32}$/i.test(args["--kv-id"] ?? "") ||
  !/^[a-f0-9-]{32,36}$/i.test(args["--d1-id"] ?? "")
) {
  console.error(
    "Usage: npm run configure -- --kv-id EXISTING_KV_NAMESPACE_ID --d1-id EXISTING_D1_DATABASE_ID",
  );
  process.exit(1);
}
for (const [path, binding, value] of [
  ["../workers/auth/wrangler.jsonc", "kv_namespaces", args["--kv-id"]],
  ["../workers/mcp/wrangler.jsonc", "d1_databases", args["--d1-id"]],
]) {
  const url = new URL(path, import.meta.url),
    config = parseConfig(readFileSync(url, "utf8"));
  config[binding][0][binding === "kv_namespaces" ? "id" : "database_id"] =
    value;
  writeFileSync(url, JSON.stringify(config, null, 2) + "\n");
}
console.log(
  "Existing KV and D1 identifiers configured. No Cloudflare resources were created or changed.",
);
