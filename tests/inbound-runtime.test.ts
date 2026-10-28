import { beforeAll, afterAll, it, expect } from "vitest";
import { createTestHarness } from "wrangler";
import { readFileSync } from "node:fs";
const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "inbound-local-runtime",
        main: "tests/inbound-runtime-worker.mjs",
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "phone-assistant-db",
            database_name: "inbound-runtime-fixture",
            database_id: "00000000-0000-4000-8000-000000000777",
          },
        ],
      },
    },
  ],
});
const worker = harness.getWorker("inbound-local-runtime");
beforeAll(async () => {
  await harness.listen();
  const env = (await worker.getEnv()) as { ["phone-assistant-db"]: D1Database };
  await env["phone-assistant-db"].exec(
    readFileSync("schema/inbound-requests.sql", "utf8")
      .replace(/--[^\n]*/g, "")
      .replace(/\n/g, " "),
  );
}, 60000);
afterAll(() => harness.close());
it("reads the Google receipt in actual workerd without unsupported redirect modes or credential forwarding", async () => {
  const d = (await (
    await worker.fetch("https://local.test/?mode=success")
  ).json()) as any;
  expect(d.row.notification_state).toBe("sent");
  expect(d.requests).toEqual([
    {
      host: "script.google.com",
      method: "POST",
      redirect: "manual",
      has_authorization: false,
    },
    {
      host: "script.googleusercontent.com",
      method: "GET",
      redirect: "manual",
      has_authorization: false,
    },
  ]);
  expect(d.external_network_requests).toBe(0);
  expect(d.real_calls).toBe(0);
});
it.each(["foreign", "chain"])(
  "refuses %s Google redirects without following them",
  async (mode) => {
    const d = (await (
      await worker.fetch("https://local.test/?mode=" + mode)
    ).json()) as any;
    expect(d.row.notification_state).toBe("pending");
    expect(d.requests.some((r: any) => r.host === "attacker.example")).toBe(
      false,
    );
    expect(d.requests.length).toBe(mode === "foreign" ? 1 : 2);
  },
);
