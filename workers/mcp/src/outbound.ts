import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
export const createInput = z
  .object({
    request_key: z.string().uuid(),
    destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    goal: z.string().min(1).max(1000),
    instructions: z.string().min(1).max(8000),
  })
  .strict();
export const approveInput = z.object({ id: z.string().uuid() }).strict();
export interface OutboundEnv {
  DB: D1Database;
  PHONE_API: Fetcher;
  OUTBOUND_GATE: DurableObjectNamespace<OutboundGate>;
  OUTBOUND_ENABLED?: string;
  OUTBOUND_CONTRACT_VERIFIED?: string;
  OUTBOUND_API_SECRET?: string;
  OUTBOUND_APPROVAL_SECRET?: string;
  OUTBOUND_ALLOWED_DESTINATIONS?: string;
}
const production =
  "https://personal-phone-assistant.barsaglini-gianluca.workers.dev";
export function enabled(env: OutboundEnv) {
  return (
    env.OUTBOUND_ENABLED === "true" && env.OUTBOUND_CONTRACT_VERIFIED === "true"
  );
}
function destinationAllowed(env: OutboundEnv, destination: string) {
  const list = JSON.parse(env.OUTBOUND_ALLOWED_DESTINATIONS ?? "[]");
  return (
    Array.isArray(list) &&
    list.every((v) => typeof v === "string") &&
    list.includes(destination)
  );
}
type Ticket = {
  id: string;
  destination: string;
  instructions: string;
  language: string;
  expires: number;
  used: boolean;
};
export class OutboundGate extends DurableObject<OutboundEnv> {
  async create(input: z.infer<typeof createInput>) {
    input = createInput.parse(input);
    if (
      !enabled(this.env) ||
      !this.env.OUTBOUND_API_SECRET ||
      !destinationAllowed(this.env, input.destination)
    )
      throw new Error("Outbound disabled or destination not allowed");
    const fingerprint = JSON.stringify(input);
    const previous = await this.ctx.storage.transaction(async (storage) => {
      const old = await storage.get<{ fingerprint: string; result?: unknown }>(
        "creation",
      );
      if (old) return old;
      await storage.put("creation", { fingerprint });
      return null;
    });
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("Idempotency conflict");
      if (previous.result) return previous.result;
      throw new Error(
        "Creation in progress or outcome unknown; do not retry with a new key",
      );
    }
    // Reservation is durable before sending. Network uncertainty never triggers an automatic retry.
    const response = await this.env.PHONE_API.fetch(
      production + "/outbound/requests",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.env.OUTBOUND_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          destination: input.destination,
          language: input.language,
          instructions: `Goal: ${input.goal}\n\n${input.instructions}`,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new Error(
        "Upstream creation failed; inspect existing requests before retrying",
      );
    const payload = (await response.json()) as { id?: string; status?: string };
    if (
      !z.string().uuid().safeParse(payload.id).success ||
      payload.status !== "pending_approval"
    )
      throw new Error("Unexpected upstream contract; outcome unknown");
    const result = {
      id: payload.id,
      destination: input.destination,
      language: input.language,
      status: "pending_approval",
    };
    await this.ctx.storage.put("creation", { fingerprint, result });
    return result;
  }
  async ticket(id: string) {
    approveInput.parse({ id });
    if (!enabled(this.env)) throw new Error("Outbound disabled");
    const row = await this.pending(id);
    const ticket = crypto.randomUUID() + crypto.randomUUID();
    await this.ctx.storage.put(`ticket:${ticket}`, {
      id,
      destination: row.destination,
      instructions: row.instructions,
      language: row.language,
      expires: Date.now() + 600000,
      used: false,
    } satisfies Ticket);
    return {
      id,
      status: "pending_approval",
      confirmation_url: `https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev/confirm?id=${id}&ticket=${ticket}`,
      message:
        "The owner must open this URL and confirm the exact destination and instructions. No call has been started.",
    };
  }
  private async pending(id: string) {
    const row = await this.env.DB.prepare(
      "SELECT id,destination,instructions,language,status FROM outbound_requests WHERE id=?",
    )
      .bind(id)
      .first<{
        id: string;
        destination: string;
        instructions: string;
        language: string;
        status: string;
      }>();
    if (
      !row ||
      row.status !== "pending_approval" ||
      !destinationAllowed(this.env, row.destination)
    )
      throw new Error("Request is not pending or destination not allowed");
    return row;
  }
  async describe(ticket: string) {
    if (!enabled(this.env)) throw new Error("Outbound disabled");
    const t = await this.ctx.storage.get<Ticket>(`ticket:${ticket}`);
    if (!t || t.used || t.expires < Date.now())
      throw new Error("Expired confirmation");
    return {
      id: t.id,
      destination: t.destination,
      instructions: t.instructions,
      language: t.language,
    };
  }
  async confirm(ticket: string) {
    if (!enabled(this.env) || !this.env.OUTBOUND_APPROVAL_SECRET)
      throw new Error("Outbound disabled");
    const t = await this.ctx.storage.get<Ticket>(`ticket:${ticket}`);
    if (!t || t.used || t.expires < Date.now())
      throw new Error("Expired confirmation");
    const row = await this.pending(t.id);
    if (
      row.destination !== t.destination ||
      row.instructions !== t.instructions ||
      row.language !== t.language
    )
      throw new Error("Request changed; obtain a new confirmation");
    await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get("execution"))
        throw new Error("Already submitted or outcome unknown; never resubmit");
      const current = await storage.get<Ticket>(`ticket:${ticket}`);
      if (!current || current.used) throw new Error("Already confirmed");
      await storage.put("execution", { id: t.id, status: "submitting" });
      await storage.put(`ticket:${ticket}`, { ...t, used: true });
    });
    const response = await this.env.PHONE_API.fetch(
      `${production}/outbound/requests/${t.id}/approve`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.env.OUTBOUND_APPROVAL_SECRET}`,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    // Even failures keep the durable reservation: exactly-once cannot be guaranteed across an external API.
    const status = response.ok ? "submitted" : "unknown";
    await this.ctx.storage.put("execution", { id: t.id, status });
    if (!response.ok)
      throw new Error(
        "Approval outcome unknown. Check status; do not resubmit.",
      );
    return { id: t.id, status };
  }
}
