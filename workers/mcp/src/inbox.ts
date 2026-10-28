import { z } from "zod";
export const inboxFilters = z
  .object({
    state: z
      .enum([
        "pending_owner",
        "approved",
        "declined",
        "needs_information",
        "all",
      ])
      .default("pending_owner"),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const inboxId = z
  .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const inboxDecision = inboxId
  .extend({
    expected_updated_at: z.number().int().nonnegative(),
    decision: z.enum(["approved", "declined", "needs_information"]),
    note: z.string().trim().min(1).max(2000),
    owner_reported_calendar_event_id: z.string().min(1).max(1000).optional(),
  })
  .strict();
export class InboundInbox {
  constructor(private db: D1Database) {}
  private publicRow(row: Record<string, unknown>): Record<string, unknown> {
    const { payload_json, owner_decision_json, ...rest } = row;
    return {
      ...rest,
      caller_data: JSON.parse(String(payload_json)),
      owner_decision: owner_decision_json
        ? JSON.parse(String(owner_decision_json))
        : null,
    };
  }
  async list(input: z.infer<typeof inboxFilters>) {
    const result = await this.db
      .prepare(
        `SELECT id,kind,payload_json,state,created_at,updated_at,owner_decision_json,notification_state,notification_error FROM inbound_requests ${input.state === "all" ? "" : "WHERE state=?"} ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(...(input.state === "all" ? [] : [input.state]), input.limit)
      .all<Record<string, unknown>>();
    return result.results.map((r) => this.publicRow(r));
  }
  async get(id: string) {
    const row = await this.db
      .prepare(
        "SELECT id,kind,payload_json,state,created_at,updated_at,owner_decision_json,notification_state,notification_error FROM inbound_requests WHERE id=?",
      )
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? this.publicRow(row) : null;
  }
  async resolve(
    input: z.infer<typeof inboxDecision>,
    principal: { userId: string; scope: string[] },
  ) {
    if (
      principal.userId !== "owner" ||
      !principal.scope.includes("calls:write") ||
      !principal.scope.includes("calls:read")
    )
      throw Error("MISSING_SCOPE");
    const decision = JSON.stringify({
      note: input.note,
      ...(input.owner_reported_calendar_event_id
        ? {
            owner_reported_calendar_event_id:
              input.owner_reported_calendar_event_id,
          }
        : {}),
    });
    const at = Math.max(Date.now(), input.expected_updated_at + 1);
    const r = await this.db
      .prepare(
        `UPDATE inbound_requests SET state=?,owner_decision_json=?,updated_at=? WHERE id=? AND updated_at=? AND state IN ('pending_owner','needs_information') RETURNING id`,
      )
      .bind(input.decision, decision, at, input.id, input.expected_updated_at)
      .first();
    if (!r) {
      const old = await this.db
        .prepare(
          "SELECT state,owner_decision_json FROM inbound_requests WHERE id=?",
        )
        .bind(input.id)
        .first<{ state: string; owner_decision_json: string }>();
      if (old?.state !== input.decision || old.owner_decision_json !== decision)
        throw Error("REQUEST_CHANGED_OR_NOT_FOUND");
    }
    return {
      request: await this.get(input.id),
      recorded_owner_decision_only: true,
      calendar_action_executed: false,
      caller_message_sent: false,
    };
  }
}
