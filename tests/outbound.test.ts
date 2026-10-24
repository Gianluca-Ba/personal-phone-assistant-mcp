import { beforeAll, afterAll, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { OutboundEnv } from "../workers/mcp/src/outbound";
const secret = "test-owner-secret-32-characters-minimum";
const harness = createTestHarness({
  workers: [
    {
      configPath: "workers/auth/wrangler.jsonc",
      secrets: { OWNER_LOGIN_SECRET: secret, OWNER_TOKEN_VERSION: "1" },
    },
    {
      configPath: "workers/mcp/wrangler.jsonc",
      vars: {
        SCHEMA_MAPPING: "",
        OUTBOUND_ENABLED: "true",
        OUTBOUND_CONTRACT_VERIFIED: "true",
        OUTBOUND_ALLOWED_DESTINATIONS: '["+819012345678"]',
      },
      secrets: {
        OUTBOUND_API_SECRET: "test-create",
        OUTBOUND_APPROVAL_SECRET: "test-approve",
      },
    },
    {
      config: {
        name: "personal-phone-assistant",
        main: "tests/mock-phone.ts",
        compatibility_date: "2026-10-01",
      },
    },
  ],
});
const mcp = harness.getWorker<OutboundEnv>("personal-phone-assistant-mcp"),
  auth = harness.getWorker("personal-phone-assistant-auth");
const issuer =
  "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
const id = "12345678-1234-4234-8234-123456789abc";
let env: OutboundEnv;
beforeAll(async () => {
  await harness.listen();
  env = await mcp.getEnv();
  await env.DB.exec(
    "CREATE TABLE outbound_requests (id TEXT PRIMARY KEY, destination TEXT, instructions TEXT, language TEXT, status TEXT);",
  );
  await env.DB.prepare("INSERT INTO outbound_requests VALUES (?,?,?,?,?)")
    .bind(id, "+819012345678", "Ask for appointment", "ja", "pending_approval")
    .run();
}, 60000);
afterAll(() => harness.close());
it("creates at most once per key, rejects changed payloads and unapproved destinations", async () => {
  const input = {
    request_key: crypto.randomUUID(),
    destination: "+819012345678",
    language: "ja",
    goal: "Dentist appointment",
    instructions: "Ask for available dates",
  };
  const gate = env.OUTBOUND_GATE.get(
    env.OUTBOUND_GATE.idFromName(`create:${input.request_key}`),
  );
  const results = await Promise.allSettled([
    gate.create(input),
    gate.create(input),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  await expect(gate.create(input)).resolves.toHaveProperty(
    "status",
    "pending_approval",
  );
  await expect(
    gate.create({ ...input, goal: "Different goal" }),
  ).rejects.toThrow();
  const bad = {
    ...input,
    request_key: crypto.randomUUID(),
    destination: "+819099999999",
  };
  await expect(
    env.OUTBOUND_GATE.get(
      env.OUTBOUND_GATE.idFromName(`create:${bad.request_key}`),
    ).create(bad),
  ).rejects.toThrow();
});
it("requires a browser owner login, displays exact details, rejects CSRF and locks paid execution against replay", async () => {
  const gate = env.OUTBOUND_GATE.get(
    env.OUTBOUND_GATE.idFromName(`approval:${id}`),
  );
  const pending = await gate.ticket(id);
  expect(pending.status).toBe("pending_approval");
  const target = new URL(pending.confirmation_url);
  const ticket = target.searchParams.get("ticket")!;
  let response = await auth.fetch(target);
  expect(response.status).toBe(200);
  let html = await response.text();
  expect(html).not.toContain("+819012345678");
  let nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const post = (nonce: string, cookies: string, origin = issuer) =>
    auth.fetch(issuer + "/confirm", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookies,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce, secret }),
      redirect: "manual",
    });
  expect(
    (await post(nonce, `confirm_nonce=${nonce}`, "https://evil.example"))
      .status,
  ).toBe(403);
  response = await post(nonce, `confirm_nonce=${nonce}`);
  expect(response.status).toBe(302);
  const session = response.headers.get("set-cookie")!.split(";")[0];
  response = await auth.fetch(target, { headers: { Cookie: session } });
  html = await response.text();
  expect(html).toContain("+819012345678");
  expect(html).toContain("Ask for appointment");
  expect(html).toContain("può generare costi");
  nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const cookies = `${session}; confirm_nonce=${nonce}`;
  const responses = await Promise.all([
    post(nonce, cookies),
    post(nonce, cookies),
  ]);
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  await expect(gate.confirm(ticket)).rejects.toThrow();
});
it("rejects request changes and non-pending calls before execution", async () => {
  const changedId = "12345678-1234-4234-8234-123456789def";
  await env.DB.prepare("INSERT INTO outbound_requests VALUES (?,?,?,?,?)")
    .bind(
      changedId,
      "+819012345678",
      "Original instructions",
      "ja",
      "pending_approval",
    )
    .run();
  const gate = env.OUTBOUND_GATE.get(
    env.OUTBOUND_GATE.idFromName(`approval:${changedId}`),
  );
  const pending = await gate.ticket(changedId);
  const ticket = new URL(pending.confirmation_url).searchParams.get("ticket")!;
  await env.DB.prepare("UPDATE outbound_requests SET instructions=? WHERE id=?")
    .bind("Changed instructions", changedId)
    .run();
  await expect(gate.confirm(ticket)).rejects.toThrow();
  await env.DB.prepare("UPDATE outbound_requests SET status=? WHERE id=?")
    .bind("completed", changedId)
    .run();
  await expect(gate.ticket(changedId)).rejects.toThrow();
});
it("a read-only OAuth token cannot prepare or approve calls, and execute scope only returns a confirmation link", async () => {
  const { login } = await import("./support");
  const resource =
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
  const tokens = await login(auth, "calls:read", secret);
  const call = async (token: string, name: string, args: unknown) => {
    const response = await mcp.fetch(resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return response.json() as Promise<any>;
  };
  const input = {
    request_key: crypto.randomUUID(),
    destination: "+819012345678",
    language: "ja",
    goal: "test",
    instructions: "test",
  };
  expect(
    (await call(tokens.access_token, "create_outbound_request", input)).result
      .isError,
  ).toBe(true);
  expect(
    (await call(tokens.access_token, "approve_outbound_request", { id })).result
      .isError,
  ).toBe(true);
  const noRead = await login(auth, "offline_access", secret);
  expect(
    (
      await mcp.fetch(resource, {
        headers: { Authorization: `Bearer ${noRead.access_token}` },
      })
    ).status,
  ).toBe(403);
  const execute = await login(auth, "calls:read calls:execute", secret);
  const result = await call(execute.access_token, "approve_outbound_request", {
    id,
  });
  expect(result.result.isError).not.toBe(true);
  expect(result.result.content[0].text).toContain("confirmation_url");
});
