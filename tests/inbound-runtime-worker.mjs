// Test-only Worker: real workerd/D1, simulated Google transport, no external I/O.
import {
  saveIntake,
  deliverInboundRequests,
} from "../workers/inbound/src/intake.mjs";
export default {
  async fetch(request, env) {
    const mode = new URL(request.url).searchParams.get("mode") ?? "success";
    const db = env["phone-assistant-db"];
    const saved = await saveIntake(
      db,
      "local-runtime-" + mode,
      {
        request_key: "runtime-1",
        kind: "note",
        message: "Synthetic local runtime verification",
        language: "en",
      },
      100,
    );
    const requests = [];
    let callId;
    const fetcher = async (url, init) => {
      // Construct a real workerd Request, which rejects unsupported redirect modes.
      const r = new Request(url, init);
      requests.push({
        host: new URL(url).hostname,
        method: r.method,
        redirect: r.redirect,
        has_authorization: r.headers.has("authorization"),
      });
      if (init.method === "POST") {
        callId = JSON.parse(init.body).call_id;
        return new Response(null, {
          status: 302,
          headers: {
            location:
              mode === "foreign"
                ? "https://attacker.example/receipt"
                : "https://script.googleusercontent.com/macros/echo?fixture=only",
          },
        });
      }
      if (mode === "chain")
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/receipt" },
        });
      return Response.json({
        ok: true,
        version: 2,
        call_id: callId,
        duplicate: true,
      });
    };
    let externalAttempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      externalAttempts++;
      throw Error("External network forbidden in runtime fixture");
    };
    try {
      await deliverInboundRequests(
        {
          ...env,
          APPS_SCRIPT_URL:
            "https://script.google.com/macros/s/local-fixture/exec",
          NOTIFICATION_SECRET: "LOCAL-FIXTURE-ONLY",
        },
        { now: () => 100, fetcher },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    const row = await db
      .prepare(
        "SELECT notification_state,notification_attempts FROM inbound_requests WHERE id=?",
      )
      .bind(saved.id)
      .first();
    return Response.json({
      row,
      requests,
      external_network_requests: externalAttempts,
      real_calls: 0,
    });
  },
};
