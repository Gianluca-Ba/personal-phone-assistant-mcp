import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
const number = z.string().regex(/^\+[1-9]\d{7,14}$/);
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
export const createInput = z
  .object({
    request_key: z.string().uuid(),
    destination: number,
    language,
    goal: z.string().min(1).max(1000),
    instructions: z.string().min(1).max(8000),
  })
  .strict();
export const approveInput = z
  .object({
    id: z.string().uuid(),
    destination: number,
    language,
    instructions: z.string().min(1).max(10020),
    request_digest: z.string().regex(/^[a-f0-9]{64}$/),
    approval_nonce: z.string().uuid(),
  })
  .strict();
export interface Principal {
  userId: string;
  clientId: string;
  tokenVersion: string;
  scope: string[];
}
export interface OutboundEnv {
  DB: D1Database;
  PHONE_API: Fetcher;
  OUTBOUND_GATE: DurableObjectNamespace<OutboundGate>;
  OWNER_TOKEN_VERSION: string;
  OUTBOUND_ENABLED?: string;
  OUTBOUND_CONTRACT_VERIFIED?: string;
  OUTBOUND_API_SECRET?: string;
  OUTBOUND_APPROVAL_SECRET?: string;
  OUTBOUND_ALLOWED_DESTINATIONS?: string;
  OUTBOUND_RATE_LIMIT_PER_HOUR?: string;
}
export type Snapshot = z.infer<typeof approveInput> & {
  owner: string;
  clientId: string;
  created_at: number;
  expires_at: number;
  state: string;
  attempted_at?: number;
};
// This is an INTERNAL adapter boundary, never an MCP argument or client-supplied _meta field.
// No production adapter can currently attest ChatGPT's per-call human consent.
export interface VerifiedConsent {
  owner: string;
  clientId: string;
  request_digest: string;
  approval_nonce: string;
  expires_at: number;
}
const production =
  "https://personal-phone-assistant.barsaglini-gianluca.workers.dev";
export const enabled = (env: OutboundEnv) =>
  env.OUTBOUND_ENABLED === "true" && env.OUTBOUND_CONTRACT_VERIFIED === "true";
function fail(code: string): never {
  throw new Error(code);
}
export class OutboundGate extends DurableObject<OutboundEnv> {
  private authorize(p: Principal, scope: string) {
    if (
      !p ||
      p.userId !== "owner" ||
      !p.clientId ||
      p.tokenVersion !== this.env.OWNER_TOKEN_VERSION ||
      !p.scope?.includes(scope)
    )
      fail("NOT_AUTHORIZED");
  }
  private allowed(destination: string) {
    const list = JSON.parse(this.env.OUTBOUND_ALLOWED_DESTINATIONS ?? "[]");
    return (
      Array.isArray(list) &&
      list.every((v) => typeof v === "string") &&
      list.includes(destination)
    );
  }
  private configured() {
    if (!enabled(this.env)) fail("OUTBOUND_DISABLED");
  }
  private async audit(code: string) {
    await this.ctx.storage.transaction(async (s) => {
      const log = (await s.get<{ at: number; code: string }[]>("audit")) ?? [];
      await s.put("audit", [...log.slice(-49), { at: Date.now(), code }]);
    });
  }
  async rateLimit(p: Principal, operation: "create" | "approve") {
    this.authorize(p, operation === "create" ? "calls:write" : "calls:execute");
    const limit = Number(this.env.OUTBOUND_RATE_LIMIT_PER_HOUR ?? "5");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_RATE_LIMIT");
    await this.ctx.storage.transaction(async (s) => {
      const hour = Math.floor(Date.now() / 3600000),
        key = `rate:${operation}`;
      const old = await s.get<{ hour: number; count: number }>(key);
      const count = old?.hour === hour ? old.count : 0;
      if (count >= limit) fail("RATE_LIMITED");
      await s.put(key, { hour, count: count + 1 });
    });
  }
  private quota(p: Principal, operation: "create" | "approve") {
    return this.env.OUTBOUND_GATE.get(
      this.env.OUTBOUND_GATE.idFromName(`quota:${p.userId}`),
    ).rateLimit(p, operation);
  }
  async create(raw: z.infer<typeof createInput>, p: Principal) {
    const input = createInput.parse(raw);
    this.authorize(p, "calls:write");
    this.configured();
    if (!this.env.OUTBOUND_API_SECRET || !this.allowed(input.destination))
      fail("DESTINATION_OR_CREDENTIAL_DENIED");
    const fingerprint = JSON.stringify({
      input,
      owner: p.userId,
      clientId: p.clientId,
    });
    const old = await this.ctx.storage.transaction(async (s) => {
      const old = await s.get<{ fingerprint: string; result?: Snapshot }>(
        "creation",
      );
      if (old) return old;
      await s.put("creation", { fingerprint });
      return null;
    });
    if (old) {
      if (old.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
      if (old.result) return old.result;
      fail("CREATION_OUTCOME_UNKNOWN");
    }
    try {
      await this.quota(p, "create");
      const instructions = `Goal: ${input.goal}\n\n${input.instructions}`;
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
            destination_number: input.destination,
            language: input.language,
            instructions,
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) fail("CREATION_OUTCOME_UNKNOWN");
      const payload = z
        .object({
          id: z.string().uuid(),
          status: z.literal("pending_approval"),
        })
        .parse(await response.json());
      const result = await this.env.OUTBOUND_GATE.get(
        this.env.OUTBOUND_GATE.idFromName(`approval:${payload.id}`),
      ).register(
        {
          id: payload.id,
          destination: input.destination,
          language: input.language,
          instructions,
        },
        p,
      );
      await this.ctx.storage.put("creation", { fingerprint, result });
      await this.audit("CREATED_PENDING_APPROVAL");
      return result;
    } catch (e) {
      await this.audit("CREATION_FAILED_OR_UNKNOWN");
      throw e;
    }
  }
  async register(
    input: Pick<Snapshot, "id" | "destination" | "language" | "instructions">,
    p: Principal,
  ) {
    this.authorize(p, "calls:write");
    this.configured();
    z.object({
      id: z.string().uuid(),
      destination: number,
      language,
      instructions: z.string().min(1).max(10020),
    })
      .strict()
      .parse(input);
    const row = await this.pending(input.id);
    if (
      row.destination !== input.destination ||
      row.language !== input.language ||
      row.instructions !== input.instructions
    )
      fail("UPSTREAM_REQUEST_MISMATCH");
    const stored = await this.ctx.storage.get<Snapshot>("snapshot");
    if (stored) {
      if (
        stored.owner !== p.userId ||
        stored.clientId !== p.clientId ||
        stored.destination !== input.destination ||
        stored.language !== input.language ||
        stored.instructions !== input.instructions
      )
        fail("REQUEST_ALREADY_BOUND");
      return stored;
    }
    const created_at = Date.now(),
      expires_at = created_at + 600000,
      approval_nonce = crypto.randomUUID();
    const canonical = JSON.stringify({
      id: input.id,
      destination: input.destination,
      language: input.language,
      instructions: input.instructions,
      owner: p.userId,
      clientId: p.clientId,
      created_at,
      expires_at,
      approval_nonce,
    });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const request_digest = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const snapshot: Snapshot = {
      ...input,
      owner: p.userId,
      clientId: p.clientId,
      created_at,
      expires_at,
      approval_nonce,
      request_digest,
      state: "pending_approval",
    };
    return this.ctx.storage.transaction(async (s) => {
      if (await s.get("snapshot")) fail("REQUEST_ALREADY_BOUND");
      await s.put("snapshot", snapshot);
      await s.put("audit", [{ at: Date.now(), code: "REQUEST_BOUND" }]);
      return snapshot;
    });
  }
  private async pending(id: string) {
    const row = await this.env.DB.withSession("first-primary")
      .prepare(
        "SELECT id,destination_number AS destination,instructions,language,status FROM outbound_requests WHERE id=?",
      )
      .bind(id)
      .first<{
        id: string;
        destination: string;
        instructions: string;
        language: string;
        status: string;
      }>();
    if (!row || row.status !== "pending_approval") fail("NOT_PENDING_APPROVAL");
    if (!this.allowed(row!.destination)) fail("DESTINATION_NOT_ALLOWED");
    return row!;
  }
  // Deliberately fail closed. OAuth, annotations, model arguments, a message id,
  // an elicitation capability claim or _meta.approved are NOT consent receipts.
  // Enabling real execution requires a separately reviewed, trusted host adapter.
  protected async verifiedNativeConsent(
    _snapshot: Snapshot,
    _p: Principal,
  ): Promise<VerifiedConsent | null> {
    return null;
  }
  async approve(raw: z.infer<typeof approveInput>, p: Principal) {
    const input = approveInput.parse(raw);
    this.authorize(p, "calls:execute");
    this.configured();
    const snapshot = await this.ctx.storage.get<Snapshot>("snapshot");
    if (!snapshot) fail("REQUEST_NOT_BOUND");
    const s = snapshot!;
    if (s.owner !== p.userId || s.clientId !== p.clientId)
      fail("REQUEST_OWNER_MISMATCH");
    if (s.expires_at <= Date.now()) fail("APPROVAL_EXPIRED");
    if (
      s.state !== "pending_approval" ||
      (await this.ctx.storage.get("execution"))
    )
      fail("ALREADY_SUBMITTED_OR_UNKNOWN");
    for (const key of [
      "id",
      "destination",
      "language",
      "instructions",
      "request_digest",
      "approval_nonce",
    ] as const)
      if (input[key] !== s[key]) fail("APPROVAL_REQUEST_MISMATCH");
    const row = await this.pending(s.id);
    if (
      row.destination !== s.destination ||
      row.language !== s.language ||
      row.instructions !== s.instructions
    )
      fail("REQUEST_CHANGED");
    await this.quota(p, "approve");
    const consent = await this.verifiedNativeConsent(s, p);
    if (!consent) {
      await this.audit("TRUSTED_CONFIRMATION_UNAVAILABLE");
      fail("TRUSTED_CONFIRMATION_UNAVAILABLE");
    }
    if (
      consent!.owner !== s.owner ||
      consent!.clientId !== s.clientId ||
      consent!.request_digest !== s.request_digest ||
      consent!.approval_nonce !== s.approval_nonce ||
      consent!.expires_at <= Date.now()
    )
      fail("CONSENT_NOT_BOUND");
    if (
      !this.env.OUTBOUND_APPROVAL_SECRET ||
      this.env.OUTBOUND_APPROVAL_SECRET === this.env.OUTBOUND_API_SECRET
    )
      fail("SEPARATE_APPROVAL_CREDENTIAL_REQUIRED");
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<Snapshot>("snapshot");
      if (
        !current ||
        current.state !== "pending_approval" ||
        (await storage.get("execution"))
      )
        fail("ALREADY_SUBMITTED_OR_UNKNOWN");
      if (current.expires_at <= Date.now()) fail("APPROVAL_EXPIRED");
      await storage.put("execution", { id: s.id, state: "submitting" });
      await storage.put("snapshot", {
        ...current,
        state: "submitting",
        attempted_at: Date.now(),
      });
    });
    await this.audit("SUBMITTING");
    try {
      const response = await this.env.PHONE_API.fetch(
        `${production}/outbound/requests/${s.id}/approve`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${this.env.OUTBOUND_APPROVAL_SECRET}`,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("upstream");
      await this.ctx.storage.put("execution", { id: s.id, state: "submitted" });
      await this.ctx.storage.put("snapshot", {
        ...s,
        state: "submitted",
        attempted_at: Date.now(),
      });
      await this.audit("SUBMITTED");
      return {
        id: s.id,
        state: "submitted",
        message:
          "Approval submitted. Read get_outbound_status for the actual call outcome.",
      };
    } catch {
      await this.ctx.storage.put("execution", { id: s.id, state: "unknown" });
      await this.ctx.storage.put("snapshot", {
        ...s,
        state: "unknown",
        attempted_at: Date.now(),
      });
      await this.audit("OUTCOME_UNKNOWN");
      fail("APPROVAL_OUTCOME_UNKNOWN_DO_NOT_RETRY");
    }
  }
  async status(p: Principal) {
    this.authorize(p, "calls:read");
    const s = await this.ctx.storage.get<Snapshot>("snapshot");
    if (!s) return { state: "unmanaged" };
    if (s.owner !== p.userId || s.clientId !== p.clientId)
      fail("REQUEST_OWNER_MISMATCH");
    return {
      id: s.id,
      state: s.state,
      created_at: s.created_at,
      expires_at: s.expires_at,
      attempted_at: s.attempted_at,
      audit: (await this.ctx.storage.get("audit")) ?? [],
    };
  }
}
