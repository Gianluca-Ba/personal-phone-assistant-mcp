// Offline-only verification of the existing phone Worker. Never deploy this fixture.
// Requires a private, read-only source download; production code is not copied into Git.
import { createTestHarness } from "wrangler";
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const source = process.argv[2];
const guarded = process.argv.includes("--guarded");
if (!source)
  throw new Error(
    "Usage: node scripts/test-phone-contract.mjs /private/path/worker.js",
  );
mkdirSync(".wrangler", { recursive: true });
const temp = mkdtempSync(resolve(".wrangler/phone-contract-"));
// A lexical fetch override prevents ALL external network access by the source under test.
const guard = `const fetch = async (url, options) => {
 if (new URL(url).hostname !== 'api.telnyx.com') throw new Error('NETWORK_DISABLED');
 if (options?.method !== 'POST') throw new Error('NETWORK_DISABLED');
 if(new URL(url).pathname === '/v2/calls') {const payload=JSON.parse(options.body);if(!payload.connection_id||payload.time_limit_secs!==300)throw new Error('INVALID_GUARDED_PAYLOAD');return Response.json({data:{call_control_id:'local-test-call'}})}
 return Response.json({call_sid:'local-test-call'});
};\n`;
writeFileSync(
  join(temp, "phone.mjs"),
  guard + readFileSync(resolve(source), "utf8"),
  { mode: 0o600 },
);
writeFileSync(
  join(temp, "voice.mjs"),
  `export default {async fetch(request){const b=await request.json();if(b.destination==="+819099999999")return Response.json({error:"unavailable"},{status:503});return Response.json({endpoint:"https://api.telnyx.com/v2/calls",payload:{from:b.from,to:b.destination,command_id:b.request_id,time_limit_secs:300,connection_id:"local-app",stream_url:"wss://local.invalid"}})}}`,
);
const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "offline-voice-controller",
        main: join(temp, "voice.mjs"),
      },
    },
    {
      config: {
        name: "offline-phone-contract",
        main: join(temp, "phone.mjs"),
        compatibility_date: "2026-10-01",
        d1_databases: [
          {
            binding: "phone-assistant-db",
            database_name: "offline-contract",
            database_id: "00000000-0000-4000-8000-000000000001",
          },
        ],
        services: [
          { binding: "VOICE_CONTROL", service: "offline-voice-controller" },
        ],
        vars: {
          OUTBOUND_VOICE_MODE: guarded ? "guarded_jp" : "legacy",
          OUTBOUND_VOICE_APP_ID: "local-app",
          OUTBOUND_VOICE_ORIGIN: "https://local.invalid",
          VOICE_CONTROL_API_SECRET: "local-voice-control-secret-32-characters",
          OUTBOUND_API_SECRET: "test-only-creation-secret-32-characters",
          OUTBOUND_APPROVAL_SECRET: "test-only-approval-secret-32-characters",
          TELNYX_API_KEY: "test-only-provider-key",
          TELNYX_TEXML_APP_ID: "123456",
          TELNYX_OUTBOUND_FROM: "+819011111111",
          TELNYX_ASSISTANT_ID: "test-only-assistant",
        },
      },
    },
  ],
});
try {
  await harness.listen();
  const phone = harness.getWorker("offline-phone-contract"),
    env = await phone.getEnv();
  await env["phone-assistant-db"].exec(
    "CREATE TABLE outbound_requests (id TEXT PRIMARY KEY,destination_number TEXT NOT NULL,instructions TEXT NOT NULL,language TEXT,status TEXT NOT NULL,authorized_at TEXT,telnyx_call_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,started_at TEXT,last_error TEXT,completed_at TEXT,duration_seconds INTEGER,answered_at TEXT,callback_token TEXT,conversation_id TEXT)",
  );
  const call = (path, body, auth) =>
    phone.fetch("https://offline.example" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + auth } : {}),
      },
      body: JSON.stringify(body),
    });
  let checks = 0;
  const eq = (a, b) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const create = async (destination = "+819012345678") => {
    const r = await call(
      "/outbound/requests",
      {
        destination_number: destination,
        language: guarded ? "ja" : "it",
        instructions: "Offline contract test: never contact any real provider.",
      },
      "test-only-creation-secret-32-characters",
    );
    eq(r.status, 201);
    const s = await r.json();
    eq(s.status, "pending_approval");
    return s.id;
  };
  const row = (id) =>
    env["phone-assistant-db"]
      .prepare("SELECT * FROM outbound_requests WHERE id=?")
      .bind(id)
      .first();
  const id = await create();
  eq(
    (await call("/outbound/requests/" + id + "/approve", {}, "wrong")).status,
    401,
  );
  eq((await row(id)).status, "pending_approval");
  eq(
    (
      await call(
        "/outbound/requests/" + id + "/approve",
        {},
        "test-only-approval-secret-32-characters",
      )
    ).status,
    202,
  );
  let state = await row(id);
  eq(state.status, "dialing");
  eq(state.telnyx_call_id, "local-test-call");
  assert.ok(state.authorized_at);
  checks++;
  eq(
    (
      await call(
        "/outbound/requests/" + id + "/approve",
        {},
        "test-only-approval-secret-32-characters",
      )
    ).status,
    409,
  );
  const callback = (token, fields) =>
    call("/webhooks/outbound-status/" + id + "/" + token, fields);
  eq(
    (
      await callback(crypto.randomUUID(), {
        CallSid: "local-test-call",
        CallStatus: "completed",
      })
    ).status,
    401,
  );
  eq(
    (
      await callback(state.callback_token, {
        CallSid: "wrong-call",
        CallStatus: "completed",
      })
    ).status,
    409,
  );
  eq(
    (
      await callback(state.callback_token, {
        CallSid: "local-test-call",
        CallStatus: "answered",
      })
    ).status,
    200,
  );
  assert.ok((await row(id)).answered_at);
  checks++;
  eq(
    (
      await callback(state.callback_token, {
        CallSid: "local-test-call",
        CallStatus: "completed",
        CallDuration: 12,
      })
    ).status,
    200,
  );
  state = await row(id);
  eq(state.status, "completed");
  eq(state.duration_seconds, 12);
  // Replayed/late callbacks cannot regress a terminal result.
  await callback(state.callback_token, {
    CallSid: "local-test-call",
    CallStatus: "failed",
    CallDuration: 999,
  });
  await callback(state.callback_token, {
    CallSid: "local-test-call",
    CallStatus: "answered",
  });
  eq((await row(id)).status, "completed");
  eq((await row(id)).duration_seconds, 12);
  const second = await create();
  eq(
    (
      await call(
        "/outbound/requests/" + second + "/approve",
        {},
        "test-only-approval-secret-32-characters",
      )
    ).status,
    202,
  );
  const failed = await row(second);
  eq(
    (
      await call(
        "/webhooks/outbound-status/" + second + "/" + failed.callback_token,
        { CallSid: "local-test-call", CallStatus: "busy", CallDuration: 0 },
      )
    ).status,
    200,
  );
  eq((await row(second)).status, "failed");
  eq((await row(second)).last_error, "busy");
  if (guarded) {
    const rejected = await create("+819099999999");
    const result = await call(
      "/outbound/requests/" + rejected + "/approve",
      {},
      "test-only-approval-secret-32-characters",
    );
    eq(result.status, 503);
    eq((await row(rejected)).status, "failed");
    eq((await row(rejected)).last_error, "voice_controller_unavailable");
  }
  console.log(
    JSON.stringify({
      checks,
      passed: true,
      guarded_route: guarded,
      network: "blocked; Telnyx transport replaced with local response",
      production_writes: 0,
    }),
  );
} finally {
  await harness.close();
  rmSync(temp, { recursive: true, force: true });
}
