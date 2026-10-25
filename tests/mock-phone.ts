// Local test fixture only. No test ever contacts the production phone Worker.
export default {
  async fetch(
    request: Request,
    env: {
      DB: D1Database;
      LEGACY?: { describeTicket: Function; confirmTicket: Function };
    },
  ) {
    const u = new URL(request.url);
    if (u.pathname === "/__legacy") {
      const errors: string[] = [];
      for (const name of ["describeTicket", "confirmTicket"] as const) {
        try {
          await env.LEGACY![name]("old-request", "old-ticket");
        } catch (e) {
          errors.push(e instanceof Error ? e.message : "UNKNOWN");
        }
      }
      return Response.json({ errors });
    }
    if (u.pathname === "/__stats")
      return Response.json(
        await env.DB.prepare(
          "SELECT operation,COUNT(*) AS count FROM mock_events GROUP BY operation",
        ).all(),
      );
    if (u.pathname === "/outbound/requests") {
      if (request.headers.get("Authorization") !== "Bearer test-create")
        return new Response("Forbidden", { status: 401 });
      const b = (await request.json()) as {
        destination_number: string;
        language: string;
        instructions: string;
      };
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO mock_events VALUES (?)")
        .bind("create")
        .run();
      await env.DB.prepare(
        "INSERT INTO outbound_requests (id,destination_number,instructions,language,status,created_at) VALUES (?,?,?,?,?,?)",
      )
        .bind(
          id,
          b.destination_number,
          b.instructions,
          b.language,
          "pending_approval",
          new Date().toISOString(),
        )
        .run();
      if (b.instructions.includes("SIMULATE_CREATE_UNKNOWN"))
        return new Response("Unknown", { status: 503 });
      return Response.json({ id, status: "pending_approval" });
    }
    if (u.pathname.endsWith("/approve")) {
      if (request.headers.get("Authorization") !== "Bearer test-approve")
        return new Response("Forbidden", { status: 401 });
      const id = u.pathname.split("/")[3];
      await env.DB.prepare("INSERT INTO mock_events VALUES (?)")
        .bind("approve")
        .run();
      const row = await env.DB.prepare(
        "SELECT instructions,destination_number FROM outbound_requests WHERE id=?",
      )
        .bind(id)
        .first<{ instructions: string; destination_number: string }>();
      if (row?.instructions.includes("SIMULATE_UNKNOWN"))
        return new Response("Unknown", { status: 503 });
      await env.DB.prepare(
        "UPDATE outbound_requests SET status='dialing' WHERE id=? AND status='pending_approval'",
      )
        .bind(id)
        .run();
      if (row?.instructions.includes("SIMULATE_DISPATCH_UNKNOWN")) {
        await env.DB.prepare(
          "UPDATE outbound_requests SET last_error='fetch_failed' WHERE id=?",
        )
          .bind(id)
          .run();
        return Response.json({ status: "dispatch_unknown" }, { status: 202 });
      }
      return Response.json(
        { id, status: "dialing", destination_number: row?.destination_number },
        { status: 202 },
      );
    }
    return new Response("Not found", { status: 404 });
  },
};
