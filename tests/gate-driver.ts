// Local-only driver: catch remote RPC failures inside workerd before returning to Node.
// This avoids Miniflare's Node RPC rejection bridge losing error messages.
export default {
  async fetch(
    request: Request,
    env: {
      FIXTURE: DurableObjectNamespace;
      REAL: DurableObjectNamespace;
      CREATION: DurableObjectNamespace;
    },
  ) {
    const input = (await request.json()) as {
      target: "fixture" | "real" | "create-only";
      name: string;
      method: string;
      args: unknown[];
    };
    const allowed = [
      "create",
      "setCreationTestSecret",
      "register",
      "approve",
      "status",
      "rateLimit",
      "expireTestRequest",
    ];
    if (!allowed.includes(input.method))
      return new Response("Invalid method", { status: 400 });
    const ns =
      input.target === "create-only"
        ? env.CREATION
        : input.target === "real"
          ? env.REAL
          : env.FIXTURE;
    const stub = ns.get(ns.idFromName(input.name)) as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    try {
      return Response.json({
        ok: true,
        value: await stub[input.method](...input.args),
      });
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : "UNKNOWN",
      });
    }
  },
};
