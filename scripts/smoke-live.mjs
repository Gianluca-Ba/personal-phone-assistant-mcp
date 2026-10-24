// Production verification: OAuth KV writes only. Phone/D1 operations are strictly read-only.
// Credentials, codes, tokens and call contents stay in memory and are never logged or saved.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const issuer =
  "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
const resource =
  "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
const report = {
  verified_at: new Date().toISOString(),
  resource,
  outbound_enabled: false,
  checks: {},
};
const request = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
const check = async () => {
  const anonymous = await request(resource);
  assert.equal(anonymous.status, 401);
  report.checks.anonymous_denied = true;
  const invalid = await request(resource, {
    headers: { Authorization: "Bearer deliberately-invalid" },
  });
  assert.equal(invalid.status, 401);
  report.checks.invalid_token_denied = true;
  const metadataURL = /resource_metadata="([^"]+)"/.exec(
    anonymous.headers.get("www-authenticate") ?? "",
  )?.[1];
  assert.ok(metadataURL);
  assert.equal(new URL(metadataURL).origin, new URL(resource).origin);
  const protectedMetadata = await (await request(metadataURL)).json();
  assert.equal(protectedMetadata.resource, resource);
  assert.deepEqual(protectedMetadata.authorization_servers, [issuer]);
  report.checks.protected_resource_discovery = true;
  const discovery = await (
    await request(issuer + "/.well-known/oauth-authorization-server")
  ).json();
  assert.equal(discovery.issuer, issuer);
  assert.ok(discovery.code_challenge_methods_supported.includes("S256"));
  for (const name of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "revocation_endpoint",
  ])
    assert.equal(new URL(discovery[name]).origin, issuer);
  report.checks.oauth_discovery = true;
  const state = randomBytes(32).toString("hex"),
    verifier = randomBytes(48).toString("base64url");
  let resolveCallback, rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(403);
      res.end("Invalid state");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Authorization failed");
      rejectCallback(new Error("Owner authorization declined"));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
    });
    res.end(
      '<!doctype html><html lang="it"><meta charset="utf-8"><title>Autorizzazione riuscita</title><p>Autorizzazione ricevuta. Puoi chiudere questa scheda e tornare alla chat. Il collaudo prosegue in sola lettura.</p></html>',
    );
    resolveCallback(code);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const expiry = setTimeout(
    () => rejectCallback(new Error("Owner authorization timed out")),
    900000,
  );
  let tokens, client;
  try {
    const registration = await request(discovery.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name:
          "Personal Phone Assistant — read-only deployment verification",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.ok(registration.ok, "Client registration failed");
    client = await registration.json();
    assert.ok(client.client_id);
    const authURL = new URL(discovery.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      scope: "calls:read offline_access",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource,
    }))
      authURL.searchParams.set(k, v);
    console.log(
      "Opening the owner authorization page. Enter your owner secret only on the Cloudflare auth page; never in this terminal or chat.",
    );
    execFile(
      process.platform === "darwin" ? "open" : "xdg-open",
      [authURL.href],
      (error) => {
        if (error)
          rejectCallback(new Error("Unable to open authorization browser"));
      },
    );
    const code = await callback;
    const response = await request(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: verifier,
        resource,
      }),
    });
    assert.ok(response.ok, "PKCE token exchange failed");
    tokens = await response.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    report.checks.owner_login_and_pkce = true;
    let sequence = 0;
    const rpc = async (method, params = {}) => {
      const response = await request(resource, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          params,
        }),
      });
      assert.equal(response.status, 200, "Authenticated MCP request failed");
      const data = await response.json();
      assert.ok(!data.error, "MCP protocol returned an error");
      return data.result;
    };
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "deployment-verification", version: "1" },
    });
    assert.equal(init.serverInfo.name, "personal-phone-assistant");
    report.checks.mcp_initialization = true;
    const tools = (await rpc("tools/list")).tools;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_call_details",
      "get_outbound_status",
      "list_calls",
      "search_calls",
    ]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    report.checks.only_four_read_only_tools = true;
    const call = async (name, args) => {
      const result = await rpc("tools/call", { name, arguments: args });
      assert.ok(!result.isError, `Read tool failed: ${name}`);
      const text = result.content.find((c) => c.type === "text").text;
      assert.ok(
        !text.includes("callback_token"),
        "Private callback field leaked",
      );
      const data = JSON.parse(text).untrusted_call_data;
      assert.ok(Array.isArray(data));
      return data;
    };
    const calls = await call("list_calls", { limit: 100 });
    report.calls_read = calls.length;
    report.checks.list_calls = true;
    if (calls.length) {
      const first = calls[0];
      const details = await call("get_call_details", { id: first.id });
      assert.equal(details[0]?.id, first.id);
      report.checks.get_call_details = true;
      const query =
        first.phone ||
        first.summary_summary?.split(/\s+/).find((v) => v.length > 2) ||
        first.id;
      const found = await call("search_calls", { query, limit: 100 });
      assert.ok(found.some((row) => row.id === first.id));
      report.checks.search_calls = true;
      assert.ok(calls.some((row) => typeof row.summary_summary === "string"));
      report.checks.real_summary_mapping = true;
      if (first.time) {
        const normalized = /Z$|[+-]\d\d:\d\d$/.test(first.time)
          ? first.time
          : first.time.replace(" ", "T") + "Z";
        const time = Date.parse(normalized);
        assert.ok(Number.isFinite(time));
        const filtered = await call("list_calls", {
          from: new Date(time - 86400000).toISOString(),
          to: new Date(time + 86400000).toISOString(),
          limit: 100,
        });
        assert.ok(filtered.some((row) => row.id === first.id));
        report.checks.date_filters = true;
      }
    }
    const outbound = await call("get_outbound_status", { limit: 100 });
    report.outbound_requests_read = outbound.length;
    report.checks.get_outbound_status = true;
    if (outbound.length)
      assert.ok(
        outbound.every((row) => typeof row.phone === "string"),
        "Destination mapping missing",
      );
    const noWrite = await rpc("tools/call", {
      name: "create_outbound_request",
      arguments: {},
    }).catch(() => null);
    assert.ok(noWrite === null || noWrite.isError);
    report.checks.outbound_unavailable = true;
    const refreshed = await request(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
        resource,
      }),
    });
    assert.ok(refreshed.ok, "Refresh failed");
    tokens = await refreshed.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    report.checks.refresh = true;
    const revoked = await request(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
        client_id: client.client_id,
      }),
    });
    assert.ok(revoked.ok, "Revocation failed");
    const afterRevocation = await request(resource, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(
      afterRevocation.status,
      401,
      "Revocation not yet visible at verification location",
    );
    report.checks.revocation = true;
    mkdirSync(new URL("../docs/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("../docs/deployment-verification.json", import.meta.url),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearTimeout(expiry);
    server.close();
    if (tokens?.refresh_token && client?.client_id)
      await request(discovery.revocation_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
          client_id: client.client_id,
        }),
      }).catch(() => {});
  }
};
try {
  await check();
} catch (error) {
  console.error(
    "Live verification failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
}
