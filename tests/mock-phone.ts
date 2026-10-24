// Local test fixture only. No test ever contacts the production phone Worker.
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/outbound/requests") {
      if (request.headers.get("Authorization") !== "Bearer test-create")
        return new Response("Forbidden", { status: 403 });
      return Response.json({
        id: "12345678-1234-4234-8234-123456789abc",
        status: "pending_approval",
      });
    }
    if (url.pathname.endsWith("/approve")) {
      if (request.headers.get("Authorization") !== "Bearer test-approve")
        return new Response("Forbidden", { status: 403 });
      return Response.json({ status: "initiated" });
    }
    return new Response("Not found", { status: 404 });
  },
};
