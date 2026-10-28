import { createHash } from "node:crypto";
export function patchPhoneInbound(source, modulePath) {
  if (source.includes("INBOUND_INTAKE_V1"))
    throw Error("Inbound patch already applied");
  const route = "    const db = env['phone-assistant-db'];";
  const scheduled = "  async scheduled(controller, env, ctx) {";
  // Ignore any same local variable in other functions: replace only fetch entry.
  const start = source.indexOf(
    "export default {\n  async fetch(request, env, ctx) {",
  );
  const at = source.indexOf(route, start);
  if (
    start < 0 ||
    at < 0 ||
    source.split(scheduled).length !== 2 ||
    source.indexOf("async function verifyTelnyx(") < 0
  )
    throw Error("Unexpected production phone source");
  const routePatch = `\n    // INBOUND_INTAKE_V1 — no outbound or call-control modifications.\n    if (url.pathname === '/inbound/intake') return handleInboundIntake(request, env, ctx, verifyTelnyx);\n`;
  const withRoute =
    source.slice(0, at + route.length) +
    routePatch +
    source.slice(at + route.length);
  const withCron = withRoute.replace(
    scheduled,
    scheduled +
      "\n    ctx.waitUntil(deliverInboundRequests(env).catch(() => console.error('INBOUND_DELIVERY_UNAVAILABLE')));",
  );
  const prefix = `import { handleInboundIntake, deliverInboundRequests } from ${JSON.stringify(modulePath)};\n`;
  const output = prefix + withCron;
  // Removing only the two added regions/import must recover EVERY original byte.
  const recovered = output
    .slice(prefix.length)
    .replace(routePatch, "")
    .replace(
      "\n    ctx.waitUntil(deliverInboundRequests(env).catch(() => console.error('INBOUND_DELIVERY_UNAVAILABLE')));",
      "",
    );
  if (recovered !== source) throw Error("Protected production code changed");
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  return {
    source: output,
    validation: {
      original_sha256: hash(source),
      protected_source_sha256: hash(recovered),
      outbound_and_existing_handlers_byte_identical: true,
    },
  };
}
