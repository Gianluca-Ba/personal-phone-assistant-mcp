import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { parse } from "jsonc-parser";
import { readFileSync } from "node:fs";
import type {
  OutboundEnv,
  Principal,
  Snapshot,
} from "../workers/mcp/src/outbound";
import type { OutboundGate as FixtureGate } from "./mcp-consent-fixture";
import { login } from "./support";
const secret = "test-owner-secret-32-characters-minimum";
const base = parse(readFileSync("workers/mcp/wrangler.jsonc", "utf8"));
const ownerKey = generateKeyPairSync("ed25519");
const ownerPublicKey = ownerKey.publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("base64url");
const vars = {
  ...base.vars,
  SCHEMA_MAPPING: "",
  OUTBOUND_ENABLED: "true",
  OUTBOUND_EXECUTION_ENABLED: "true",
  OUTBOUND_CONTRACT_VERIFIED: "true",
  OUTBOUND_ALLOWED_DESTINATIONS: '["+819012345678"]',
  OUTBOUND_RATE_LIMIT_PER_HOUR: "100",
  OUTBOUND_CONSENT_PUBLIC_KEY: ownerPublicKey,
  OUTBOUND_API_SECRET: "test-create",
  OUTBOUND_APPROVAL_SECRET: "test-approve",
};
const harness = createTestHarness({
  workers: [
    {
      configPath: "workers/auth/wrangler.jsonc",
      secrets: { OWNER_LOGIN_SECRET: secret, OWNER_TOKEN_VERSION: "1" },
    },
    { config: { ...base, main: "tests/mcp-consent-fixture.ts", vars } },
    {
      config: {
        ...base,
        name: "production-gate",
        main: "workers/mcp/src/index.ts",
        vars,
      },
    },
    {
      config: {
        ...base,
        name: "creation-only",
        main: "tests/mcp-consent-fixture.ts",
        vars: {
          ...vars,
          OUTBOUND_EXECUTION_ENABLED: "false",
          OUTBOUND_APPROVAL_SECRET: "",
          OUTBOUND_ALLOWED_DESTINATIONS: "[]",
          OUTBOUND_ALLOWED_DESTINATIONS_SECRET: '["+819012345678"]',
        },
      },
    },
    {
      config: {
        name: "gate-driver",
        main: "tests/gate-driver.ts",
        compatibility_date: "2026-10-01",
        durable_objects: {
          bindings: [
            {
              name: "FIXTURE",
              class_name: "OutboundGate",
              script_name: "personal-phone-assistant-mcp",
            },
            {
              name: "CREATION",
              class_name: "OutboundGate",
              script_name: "creation-only",
            },
            {
              name: "REAL",
              class_name: "OutboundGate",
              script_name: "production-gate",
            },
          ],
        },
      },
    },
    {
      config: {
        name: "personal-phone-assistant",
        main: "tests/mock-phone.ts",
        compatibility_date: "2026-10-01",
        d1_databases: base.d1_databases,
        services: [
          {
            binding: "LEGACY",
            service: "production-gate",
            entrypoint: "ApprovalServer",
          },
        ],
      },
    },
  ],
});
const mcp = harness.getWorker<
  Omit<OutboundEnv, "OUTBOUND_GATE"> & {
    OUTBOUND_GATE: DurableObjectNamespace<FixtureGate>;
  }
>("personal-phone-assistant-mcp");
const real = harness.getWorker<OutboundEnv>("production-gate"),
  auth = harness.getWorker("personal-phone-assistant-auth"),
  phone = harness.getWorker("personal-phone-assistant");
const actor: Principal = {
  userId: "owner",
  clientId: "test-client",
  tokenVersion: "1",
  scope: ["calls:read", "calls:write", "calls:execute"],
};
let env: Awaited<ReturnType<typeof mcp.getEnv>>, realEnv: OutboundEnv;
const driver = harness.getWorker("gate-driver");
function stub(
  name: string,
  target: "fixture" | "real" | "create-only" = "fixture",
) {
  return new Proxy(
    {},
    {
      get:
        (_o, method: string) =>
        async (...args: unknown[]) => {
          const response = await driver.fetch("https://driver.example/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, name, method, args }),
          });
          const body = (await response.json()) as {
            ok: boolean;
            value: unknown;
            error: string;
          };
          if (!body.ok) throw new Error(body.error);
          return body.value;
        },
    },
  ) as any;
}
const gate = (id: string) => stub(`approval:${id}`);
const input = () => ({
  request_key: crypto.randomUUID(),
  destination: "+819012345678",
  language: "ja",
  goal: "Appointment",
  instructions: "Ask available dates",
});
const approve = (s: Snapshot) => ({
  id: s.id,
  destination: s.destination,
  language: s.language,
  instructions: s.instructions,
  request_digest: s.request_digest,
  approval_nonce: s.approval_nonce,
});
async function create(p = actor, details = input()) {
  return stub(`create:${p.userId}:${p.clientId}:${details.request_key}`).create(
    details,
    p,
  ) as Promise<Snapshot>;
}
async function stats() {
  const body = (await (
    await phone.fetch("https://mock.example/__stats")
  ).json()) as { results: { operation: string; count: number }[] };
  return Object.fromEntries(body.results.map((r) => [r.operation, r.count]));
}
beforeAll(async () => {
  await harness.listen();
  env = await mcp.getEnv();
  realEnv = await real.getEnv();
  // Test-only secrets: no real API is reachable from this harness.
  // Inline config secret values are vars here and stay exclusively in this local runtime.
  await env.DB.exec(
    "CREATE TABLE outbound_requests (id TEXT PRIMARY KEY,destination_number TEXT,instructions TEXT,language TEXT,status TEXT,created_at TEXT,authorized_at TEXT,telnyx_call_id TEXT,answered_at TEXT,completed_at TEXT,duration_seconds INTEGER,last_error TEXT); CREATE TABLE mock_events (operation TEXT);",
  );
}, 60000);
afterAll(() => harness.close());
it("duplicates reserve one creation and bind exact immutable details without URLs", async () => {
  const details = input();
  const g = stub(`create:owner:test-client:${details.request_key}`);
  const before = await stats();
  const results = await Promise.allSettled([
    g.create(details, actor),
    g.create(details, actor),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  const s = await g.create(details, actor);
  expect(s.state).toBe("pending_approval");
  expect(s.destination).toBe(details.destination);
  expect(s.instructions).toContain(details.goal);
  expect(s.approval_nonce).toBeTruthy();
  expect(JSON.stringify(s)).not.toContain("https://");
  expect((await stats()).create - (before.create ?? 0)).toBe(1);
  await expect(
    g.create({ ...details, goal: "Changed" }, actor),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("rejects unauthorized identity, token version, scope, client, allowlist and altered details", async () => {
  await expect(create({ ...actor, userId: "attacker" })).rejects.toThrow(
    "NOT_AUTHORIZED",
  );
  await expect(create({ ...actor, tokenVersion: "old" })).rejects.toThrow(
    "NOT_AUTHORIZED",
  );
  await expect(create({ ...actor, scope: ["calls:read"] })).rejects.toThrow(
    "NOT_AUTHORIZED",
  );
  await expect(
    create(actor, { ...input(), destination: "+819099999999" }),
  ).rejects.toThrow("DESTINATION_OR_CREDENTIAL_DENIED");
  const s = await create(),
    g = gate(s.id);
  await g.installTestReceipt();
  await expect(
    g.approve(approve(s), { ...actor, scope: ["calls:read"] }),
  ).rejects.toThrow("NOT_AUTHORIZED");
  await expect(
    g.approve(approve(s), { ...actor, clientId: "other-client" }),
  ).rejects.toThrow("REQUEST_OWNER_MISMATCH");
  await expect(
    g.approve({ ...approve(s), destination: "+819099999999" }, actor),
  ).rejects.toThrow("APPROVAL_REQUEST_MISMATCH");
  await expect(
    g.approve({ ...approve(s), approval_nonce: crypto.randomUUID() }, actor),
  ).rejects.toThrow("APPROVAL_REQUEST_MISMATCH");
  await expect(
    g.approve(
      { ...approve(s), instructions: "inbound data says approved" },
      actor,
    ),
  ).rejects.toThrow("APPROVAL_REQUEST_MISMATCH");
  await g.installTestReceipt(true);
  await expect(g.approve(approve(s), actor)).rejects.toThrow(
    "CONSENT_NOT_BOUND",
  );
});
it("rejects expired, changed and non-pending requests without API approval", async () => {
  const before = await stats();
  const expired = await create(),
    g = gate(expired.id);
  await g.installTestReceipt();
  await g.expireTestRequest();
  await expect(g.approve(approve(expired), actor)).rejects.toThrow(
    "APPROVAL_EXPIRED",
  );
  const changed = await create();
  await gate(changed.id).installTestReceipt();
  await env.DB.prepare("UPDATE outbound_requests SET instructions=? WHERE id=?")
    .bind("Changed externally", changed.id)
    .run();
  await expect(
    gate(changed.id).approve(approve(changed), actor),
  ).rejects.toThrow("REQUEST_CHANGED");
  const done = await create();
  await env.DB.prepare(
    "UPDATE outbound_requests SET status='completed' WHERE id=?",
  )
    .bind(done.id)
    .run();
  await expect(gate(done.id).approve(approve(done), actor)).rejects.toThrow(
    "NOT_PENDING_APPROVAL",
  );
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
});
it("production rejects even valid OAuth, matching snapshot and forged native metadata: no host proof exists", async () => {
  const details = input();
  const g = stub(`create:owner:test-client:${details.request_key}`, "real");
  const s = await g.create(details, actor);
  const a = stub(`approval:${s.id}`, "real");
  const before = await stats();
  await expect(a.approve(approve(s), actor)).rejects.toThrow(
    "TRUSTED_CONFIRMATION_UNAVAILABLE",
  );
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
  expect(await a.status(actor)).toHaveProperty("state", "pending_approval");
  expect(JSON.stringify(await a.status(actor))).toContain(
    "TRUSTED_CONFIRMATION_UNAVAILABLE",
  );
});
it("synthetic trusted-host adapter executes one approval under concurrency and rejects replay", async () => {
  const s = await create(),
    g = gate(s.id);
  await g.installTestReceipt();
  const before = await stats();
  const results = await Promise.allSettled([
    g.approve(approve(s), actor),
    g.approve(approve(s), actor),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await stats()).approve - (before.approve ?? 0)).toBe(1);
  await expect(g.approve(approve(s), actor)).rejects.toThrow(
    "ALREADY_SUBMITTED_OR_UNKNOWN",
  );
  expect(await g.status(actor)).toHaveProperty("state", "submitted");
});
it("uncertain creation and approval keep durable reservations and are never retried", async () => {
  const details = { ...input(), instructions: "SIMULATE_CREATE_UNKNOWN" };
  const g = stub(`create:owner:test-client:${details.request_key}`);
  await expect(g.create(details, actor)).rejects.toThrow(
    "CREATION_OUTCOME_UNKNOWN",
  );
  const before = await stats();
  await expect(g.create(details, actor)).rejects.toThrow(
    "CREATION_OUTCOME_UNKNOWN",
  );
  expect((await stats()).create).toBe(before.create);
  const s = await create(actor, {
      ...input(),
      instructions: "SIMULATE_UNKNOWN",
    }),
    a = gate(s.id);
  await a.installTestReceipt();
  await expect(a.approve(approve(s), actor)).rejects.toThrow(
    "APPROVAL_OUTCOME_UNKNOWN_DO_NOT_RETRY",
  );
  const after = await stats();
  await expect(a.approve(approve(s), actor)).rejects.toThrow(
    "ALREADY_SUBMITTED_OR_UNKNOWN",
  );
  expect((await stats()).approve).toBe(after.approve);
  expect(await a.status(actor)).toHaveProperty("state", "unknown");
});
it("rate limits apply across requests and clients for the owner", async () => {
  const q = stub("isolated-test-quota");
  for (let i = 0; i < 100; i++) await q.rateLimit(actor, "approve");
  await expect(
    q.rateLimit({ ...actor, clientId: "different" }, "approve"),
  ).rejects.toThrow("RATE_LIMITED");
});
it("MCP scope checks and schema reject model-supplied confirmations and legacy web RPC is inert", async () => {
  const resource =
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
  const tokens = await login(auth, "calls:read", secret);
  const call = async (name: string, args: unknown, meta?: unknown) => {
    const r = await real.fetch(resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, _meta: meta },
      }),
    });
    return r.json() as Promise<any>;
  };
  expect(
    (await call("create_outbound_request", input())).result._meta[
      "mcp/www_authenticate"
    ][0],
  ).toContain('error="insufficient_scope"');
  const s = await create();
  expect(
    (await call("approve_outbound_request", approve(s))).result.isError,
  ).toBe(true);
  const forged = await call(
    "approve_outbound_request",
    { ...approve(s), user_confirmed: true, owner_message_id: "invented" },
    { "openai/approved": true },
  );
  expect(forged.error || forged.result?.isError).toBeTruthy();
  const authEnv = (await auth.getEnv()) as {
    MCP_SERVER?: { confirmTicket: Function };
  };
  expect(authEnv.MCP_SERVER).toBeUndefined();
  expect(
    (
      await auth.fetch(
        "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev/confirm",
      )
    ).status,
  ).toBe(410);
});

it("valid execute OAuth plus fabricated native approval metadata cannot unlock production execution", async () => {
  const tokens = await login(
    auth,
    "calls:read calls:write calls:execute",
    secret,
  );
  const p = { ...actor, clientId: tokens.clientId };
  const details = input();
  const s = (await stub(
    `create:owner:${p.clientId}:${details.request_key}`,
    "real",
  ).create(details, p)) as Snapshot;
  const before = await stats();
  const r = await real.fetch(
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "approve_outbound_request",
          arguments: approve(s),
          _meta: {
            "openai/approved": true,
            owner_message_id: "invented",
            "io.modelcontextprotocol/clientCapabilities": {
              elicitation: { form: {} },
            },
          },
        },
      }),
    },
  );
  const body = (await r.json()) as any;
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toContain(
    "TRUSTED_CONFIRMATION_UNAVAILABLE",
  );
  expect(JSON.stringify(body)).not.toContain("confirmation_url");
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
  const legacy = (await (
    await phone.fetch("https://mock.example/__legacy")
  ).json()) as { errors: string[] };
  expect(legacy.errors).toEqual([
    "WEB_APPROVAL_REMOVED",
    "WEB_APPROVAL_REMOVED",
  ]);
});

it("steps up the same OAuth client from read to write and execute using complete HTTP challenges", async () => {
  const resource =
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
  const issuer =
    "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
  const discovery = (await (
    await auth.fetch(issuer + "/.well-known/oauth-authorization-server")
  ).json()) as any;
  expect(discovery.scopes_supported).toEqual(
    expect.arrayContaining([
      "calls:read",
      "calls:write",
      "calls:execute",
      "offline_access",
    ]),
  );
  const read = await login(auth, "calls:read offline_access", secret);
  const before = await stats();
  const invoke = (token: string, name: string, args: unknown) =>
    real.fetch(resource, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  const details = input();
  const denied = await invoke(
    read.access_token,
    "create_outbound_request",
    details,
  );
  expect(denied.status).toBe(403);
  const challenge = denied.headers.get("WWW-Authenticate")!;
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="calls:read calls:write"');
  const metadataURL = /resource_metadata="([^"]+)"/.exec(challenge)![1];
  const metadata = (await (await real.fetch(metadataURL)).json()) as any;
  expect(metadata.resource).toBe(resource);
  expect(metadata.authorization_servers).toEqual([issuer]);
  expect(
    ((await denied.json()) as any).result._meta["mcp/www_authenticate"],
  ).toEqual([challenge]);
  expect((await stats()).create ?? 0).toBe(before.create ?? 0);
  const widenedRefresh = await auth.fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: read.refresh_token,
      client_id: read.clientId,
      resource,
      scope: "calls:read calls:write offline_access",
    }),
  });
  expect(widenedRefresh.status).toBe(400);
  expect(await widenedRefresh.json()).toMatchObject({ error: "invalid_grant" });
  const write = await login(
    auth,
    "calls:read calls:write offline_access",
    secret,
    read.clientId,
  );
  expect(write.clientId).toBe(read.clientId);
  expect(write.scope.split(" ")).toContain("calls:write");
  const allowed = await invoke(
    write.access_token,
    "create_outbound_request",
    details,
  );
  expect(allowed.status).toBe(200);
  const created = (await allowed.json()) as any;
  expect(created.result.isError).not.toBe(true);
  const s = JSON.parse(created.result.content[0].text).request as Snapshot;
  expect(s.state).toBe("pending_approval");
  expect((await stats()).create - (before.create ?? 0)).toBe(1);
  // The original read token is not silently upgraded by the new consent.
  expect([401, 403]).toContain(
    (await invoke(read.access_token, "create_outbound_request", details))
      .status,
  );
  const deniedApproval = await invoke(
    write.access_token,
    "approve_outbound_request",
    approve(s),
  );
  expect(deniedApproval.status).toBe(403);
  expect(deniedApproval.headers.get("WWW-Authenticate")).toContain(
    'scope="calls:read calls:execute"',
  );
  const execute = await login(
    auth,
    "calls:read calls:execute offline_access",
    secret,
    read.clientId,
  );
  expect(execute.scope.split(" ")).toContain("calls:execute");
  const reachedGuard = await invoke(
    execute.access_token,
    "approve_outbound_request",
    approve(s),
  );
  expect(reachedGuard.status).toBe(200);
  const blocked = (await reachedGuard.json()) as any;
  expect(blocked.result.isError).toBe(true);
  expect(blocked.result.content[0].text).toContain(
    "TRUSTED_CONFIRMATION_UNAVAILABLE",
  );
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
  const descriptors = await real.fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${execute.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 18, method: "tools/list" }),
  });
  const tools = ((await descriptors.json()) as any).result.tools;
  expect(
    tools.find((t: any) => t.name === "create_outbound_request")
      .securitySchemes,
  ).toEqual([{ type: "oauth2", scopes: ["calls:read", "calls:write"] }]);
  expect(
    tools.find((t: any) => t.name === "create_outbound_request")._meta
      .securitySchemes,
  ).toEqual([{ type: "oauth2", scopes: ["calls:read", "calls:write"] }]);
  expect(
    tools.find((t: any) => t.name === "approve_outbound_request")._meta
      .securitySchemes,
  ).toEqual([{ type: "oauth2", scopes: ["calls:read", "calls:execute"] }]);
  // Baseline is included even if the token has the operation scope alone.
  const writeOnly = await login(auth, "calls:write", secret);
  const needRead = await invoke(
    writeOnly.access_token,
    "create_outbound_request",
    details,
  );
  expect(needRead.status).toBe(403);
  expect(needRead.headers.get("WWW-Authenticate")).toContain(
    'scope="calls:read calls:write"',
  );
});

it("official SDK opens fresh PKCE consent instead of looping on a read-only refresh", async () => {
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const issuer =
    "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
  const resource =
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
  const read = await login(auth, "calls:read offline_access", secret);
  let savedTokens: any = { ...read, issuer };
  let redirectURL: URL | undefined;
  let verifier = "";
  const provider: any = {
    redirectUrl: "https://client.example/callback",
    clientMetadata: {
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: () => ({
      client_id: read.clientId,
      token_endpoint_auth_method: "none",
      issuer,
    }),
    saveClientInformation: () => {},
    tokens: () => savedTokens,
    saveTokens: (v: any) => {
      savedTokens = v;
    },
    codeVerifier: () => verifier,
    saveCodeVerifier: (v: string) => {
      verifier = v;
    },
    redirectToAuthorization: (u: URL) => {
      redirectURL = u;
    },
    invalidateCredentials: () => {
      savedTokens = undefined;
    },
  };
  const exchanges: { path: string; status: number }[] = [];
  const fetchFn: any = async (url: any, init: any) => {
    const u = new URL(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    );
    const r = await (u.origin === issuer ? auth : real).fetch(url, init);
    exchanges.push({ path: u.pathname, status: r.status });
    return r;
  };
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    authProvider: provider,
    fetch: fetchFn,
  });
  const other = await login(auth, "calls:read offline_access", secret);
  const messages: any[] = [];
  transport.onmessage = (m: any) => messages.push(m);
  await transport.start();
  const request = {
    jsonrpc: "2.0" as const,
    id: 40,
    method: "tools/call",
    params: { name: "create_outbound_request", arguments: input() },
  };
  await expect(transport.send(request)).rejects.toThrow("Unauthorized");
  expect(exchanges).toContainEqual({ path: "/oauth/token", status: 400 });
  const otherRefresh = await auth.fetch(issuer + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: other.refresh_token,
      client_id: other.clientId,
      resource,
    }),
  });
  expect(otherRefresh.status).toBe(200);
  expect(((await otherRefresh.json()) as any).scope.split(" ")).not.toContain(
    "calls:write",
  );
  expect(redirectURL).toBeDefined();
  expect(redirectURL!.searchParams.get("scope")).toBe("calls:read calls:write");
  expect(redirectURL!.searchParams.get("code_challenge_method")).toBe("S256");
  const consent = await auth.fetch(redirectURL!);
  expect(consent.status).toBe(200);
  const html = await consent.text(),
    nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const approved = await auth.fetch(issuer + "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: issuer,
      "CF-Connecting-IP": "192.0.2.220",
      Cookie: consent.headers.get("set-cookie")!.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ nonce, secret }),
  });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location")!);
  expect(callback.searchParams.get("iss")).toBe(issuer);
  await transport.finishAuth(callback.searchParams.get("code")!);
  expect(savedTokens.scope.split(" ")).toContain("calls:write");
  await transport.send(request);
  expect(messages.at(-1)?.result.isError).not.toBe(true);
  expect(JSON.parse(messages.at(-1).result.content[0].text).request.state).toBe(
    "pending_approval",
  );
  await transport.close();
});

it("creation-only mode reaches pending_approval and never approves even with a synthetic valid receipt", async () => {
  const details = {
    ...input(),
    goal: "  Creation only test  ",
    instructions: "  Prepare a request without originating a call.  ",
  };
  const c = stub(
    `create:owner:test-client:${details.request_key}`,
    "create-only",
  );
  const before = await stats();
  const s = (await c.create(details, actor)) as Snapshot;
  expect(s.state).toBe("pending_approval");
  expect(s.instructions).toBe(
    "Goal: Creation only test\n\nPrepare a request without originating a call.",
  );
  expect(await c.create(details, actor)).toMatchObject({
    id: s.id,
    state: "pending_approval",
  });
  const g = stub(`approval:${s.id}`, "create-only");
  await g.installTestReceipt();
  await expect(g.approve(approve(s), actor)).rejects.toThrow(
    "OUTBOUND_APPROVAL_DISABLED",
  );
  const row = await env.DB.prepare(
    "SELECT status,authorized_at,telnyx_call_id FROM outbound_requests WHERE id=?",
  )
    .bind(s.id)
    .first();
  expect(row).toEqual({
    status: "pending_approval",
    authorized_at: null,
    telnyx_call_id: null,
  });
  const after = await stats();
  expect(after.create - (before.create ?? 0)).toBe(1);
  expect(after.approve ?? 0).toBe(before.approve ?? 0);
});

it("validates verified upstream languages, instruction length and UTF-8 byte limit before creating", async () => {
  const before = await stats();
  await expect(create(actor, { ...input(), language: "fr" })).rejects.toThrow();
  await expect(
    create(actor, { ...input(), instructions: "x".repeat(3000) }),
  ).rejects.toThrow();
  await expect(
    create(actor, { ...input(), instructions: "あ".repeat(2800) }),
  ).rejects.toThrow();
  expect((await stats()).create ?? 0).toBe(before.create ?? 0);
});

it("a known pre-insert 401 can be corrected and retried with the SAME key without duplicates", async () => {
  const details = input(),
    g = stub(`create:owner:test-client:${details.request_key}`, "create-only");
  const before = await stats();
  await g.setCreationTestSecret("test-wrong-creation-secret");
  await expect(g.create(details, actor)).rejects.toThrow(
    "CREATION_CREDENTIAL_REJECTED",
  );
  expect((await stats()).create ?? 0).toBe(before.create ?? 0);
  await g.setCreationTestSecret("test-create");
  const s = (await g.create(details, actor)) as Snapshot;
  expect(s.state).toBe("pending_approval");
  expect(await g.create(details, actor)).toMatchObject({ id: s.id });
  expect((await stats()).create - (before.create ?? 0)).toBe(1);
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
});

// Production verifier, with a throwaway local key. No trusted-host fixture override.
async function realRequest() {
  const details = input();
  const s = (await stub(
    `create:owner:test-client:${details.request_key}`,
    "real",
  ).create(details, actor)) as Snapshot;
  return { s, g: stub(`approval:${s.id}`, "real") };
}
async function ownerReceipt(s: Snapshot) {
  // Use the exact owner-operated helper, not a test copy of serialization.
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {consentPayload} from './scripts/owner-consent.mjs'; process.stdout.write(consentPayload(JSON.parse(process.argv[1])));",
      JSON.stringify(s),
    ],
    { encoding: "utf8" },
  );
  expect(out.status).toBe(0);
  return (
    "ppa1." +
    sign(null, Buffer.from(out.stdout), ownerKey.privateKey).toString(
      "base64url",
    )
  );
}
it("production owner signature submits exactly once under concurrency and rejects replay", async () => {
  const { s, g } = await realRequest();
  const signature = await ownerReceipt(s);
  const before = await stats();
  const attempts = await Promise.allSettled([
    g.approve({ ...approve(s), consent_signature: signature }, actor),
    g.approve({ ...approve(s), consent_signature: signature }, actor),
  ]);
  expect(attempts.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect((await stats()).approve - (before.approve ?? 0)).toBe(1);
  await expect(
    g.approve({ ...approve(s), consent_signature: signature }, actor),
  ).rejects.toThrow("ALREADY_SUBMITTED_OR_UNKNOWN");
});
it("owner signatures reject altered payloads, another request, foreign keys and unsupported model claims", async () => {
  const { s, g } = await realRequest();
  const before = await stats();
  for (const modified of [
    { ...s, destination: "+819099999999" },
    { ...s, instructions: s.instructions + " changed" },
    { ...s, language: "it" as const },
    { ...s, approval_nonce: crypto.randomUUID() },
    { ...s, request_digest: "0".repeat(64) },
    { ...s, expires_at: s.expires_at + 1 },
    { ...s, clientId: "other" },
    { ...s, owner: "other" },
    { ...s, id: crypto.randomUUID() },
  ]) {
    await expect(
      g.approve(
        { ...approve(s), consent_signature: await ownerReceipt(modified) },
        actor,
      ),
    ).rejects.toThrow("TRUSTED_CONFIRMATION_UNAVAILABLE");
  }
  const other = await realRequest();
  await expect(
    other.g.approve(
      { ...approve(other.s), consent_signature: await ownerReceipt(s) },
      actor,
    ),
  ).rejects.toThrow("TRUSTED_CONFIRMATION_UNAVAILABLE");
  const foreign = generateKeyPairSync("ed25519");
  const bad =
    "ppa1." +
    sign(null, Buffer.from("forged consent"), foreign.privateKey).toString(
      "base64url",
    );
  await expect(
    g.approve({ ...approve(s), consent_signature: bad }, actor),
  ).rejects.toThrow("TRUSTED_CONFIRMATION_UNAVAILABLE");
  expect((await stats()).approve ?? 0).toBe(before.approve ?? 0);
});
it("status reconciles submitted, calling and terminal states from D1 without exposing callback credentials", async () => {
  const { s, g } = await realRequest();
  await g.approve(
    { ...approve(s), consent_signature: await ownerReceipt(s) },
    actor,
  );
  await env.DB.prepare(
    "UPDATE outbound_requests SET status='dialing',telnyx_call_id=NULL WHERE id=?",
  )
    .bind(s.id)
    .run();
  expect(await g.status(actor)).toMatchObject({
    state: "submitted",
    phone_state: "dialing",
    control_state: "submitted",
  });
  await env.DB.prepare(
    "UPDATE outbound_requests SET telnyx_call_id='local-test',answered_at=CURRENT_TIMESTAMP WHERE id=?",
  )
    .bind(s.id)
    .run();
  expect(await g.status(actor)).toMatchObject({ state: "calling" });
  for (const terminal of ["completed", "failed"]) {
    await env.DB.prepare(
      "UPDATE outbound_requests SET status=?,duration_seconds=12,completed_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(terminal, s.id)
      .run();
    const status = await g.status(actor);
    expect(status).toMatchObject({ state: terminal, duration_seconds: 12 });
    expect(JSON.stringify(status)).not.toMatch(
      /callback_token|consent_signature/,
    );
  }
});

it("a 202 dispatch_unknown response stays unknown and cannot be resubmitted", async () => {
  const details = {
    ...input(),
    instructions: "SIMULATE_DISPATCH_UNKNOWN: test only",
  };
  const s = (await stub(
    `create:owner:test-client:${details.request_key}`,
    "real",
  ).create(details, actor)) as Snapshot;
  const g = stub(`approval:${s.id}`, "real"),
    before = await stats();
  await expect(
    g.approve(
      { ...approve(s), consent_signature: await ownerReceipt(s) },
      actor,
    ),
  ).rejects.toThrow("APPROVAL_OUTCOME_UNKNOWN_DO_NOT_RETRY");
  expect(await g.status(actor)).toMatchObject({
    state: "unknown",
    phone_state: "dialing",
  });
  await expect(
    g.approve(
      { ...approve(s), consent_signature: await ownerReceipt(s) },
      actor,
    ),
  ).rejects.toThrow("ALREADY_SUBMITTED_OR_UNKNOWN");
  expect((await stats()).approve - (before.approve ?? 0)).toBe(1);
});
