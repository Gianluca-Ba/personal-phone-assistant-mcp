import { z } from "zod";
const iso = z.string().datetime({ offset: true });
export const filters = z
  .object({
    from: iso.optional(),
    to: iso.optional(),
    direction: z.enum(["inbound", "outbound"]).optional(),
    priority: z.string().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    "Invalid date interval",
  );
export const searchInput = z
  .object({
    query: z.string().min(1).max(200),
    from: iso.optional(),
    to: iso.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    "Invalid date interval",
  );
export const detailsInput = z
  .object({ id: z.string().min(1).max(200) })
  .strict();
export const statusInput = z
  .object({
    id: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
type Table = "calls" | "call_summaries" | "outbound_requests";
type Mapping = Record<string, string>;
const candidates: Record<Table, Record<string, string[]>> = {
  calls: {
    id: ["id", "call_id"],
    phone: ["from_number", "caller_number", "caller", "from"],
    destination: ["destination_number", "to_number", "destination", "to"],
    caller_name: ["caller_name"],
    language: ["language"],
    status: ["status"],
    direction: ["direction"],
    time: ["started_at", "created_at", "start_time"],
    end: ["ended_at", "completed_at"],
    duration: ["duration_seconds"],
    conversation: ["conversation_id"],
    telnyx: ["telnyx_call_id", "call_control_id"],
  },
  call_summaries: {
    call: ["call_id"],
    summary: ["summary_it", "summary", "summary_text"],
    priority: ["priority"],
    outcome: ["outcome"],
    actions: [
      "action_required",
      "action_items",
      "required_actions",
      "actions_required",
    ],
    conversation: ["conversation_id"],
  },
  outbound_requests: {
    id: ["id"],
    phone: ["destination_number", "destination"],
    instructions: ["instructions"],
    language: ["language"],
    status: ["status"],
    time: ["started_at", "created_at", "authorized_at"],
    end: ["completed_at"],
    duration: ["duration_seconds"],
    error: ["last_error"],
    telnyx: ["telnyx_call_id"],
    conversation: ["conversation_id"],
  },
};
export const quote = (v: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))
    throw new Error("Invalid schema identifier");
  return `"${v}"`;
};
export class CallData {
  constructor(
    private db: D1Database,
    private config?: string,
  ) {}
  async mapping(table: Table): Promise<Mapping> {
    const info = await this.db
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all<{ name: string }>();
    const columns = new Set(info.results.map((c) => c.name));
    if (!columns.size) throw new Error(`Schema unavailable: ${table}`);
    const overrides = this.config ? (JSON.parse(this.config)[table] ?? {}) : {};
    const mapping: Mapping = {};
    for (const [field, names] of Object.entries(candidates[table])) {
      const selected = overrides[field] ?? names.find((n) => columns.has(n));
      if (selected) {
        quote(selected);
        if (!columns.has(selected))
          throw new Error("Configured column missing");
        mapping[field] = selected;
      }
    }
    return mapping;
  }
  require(m: Mapping, ...fields: string[]) {
    for (const f of fields)
      if (!m[f]) throw new Error(`Configure schema field: ${f}`);
  }
  timestamp(table: Table, column: string) {
    const format = this.config
      ? JSON.parse(this.config)[table]?.time_format
      : undefined;
    if (format === undefined || format === "iso") return `julianday(${column})`;
    if (format === "unix_seconds") return `julianday(${column}, 'unixepoch')`;
    if (format === "unix_milliseconds")
      return `julianday(${column}/1000.0, 'unixepoch')`;
    throw new Error("Unsupported timestamp format");
  }
  projection(m: Mapping, alias: string, prefix = "") {
    return Object.entries(m)
      .map(([k, v]) => `${alias}.${quote(v)} AS ${quote(prefix + k)}`)
      .join(", ");
  }
  async calls(input: z.infer<typeof filters>, query?: string, id?: string) {
    const c = await this.mapping("calls"),
      s = await this.mapping("call_summaries");
    this.require(c, "id", "time");
    let join = "";
    let projection = this.projection(c, "c");
    if (s.call)
      join = ` LEFT JOIN call_summaries s ON s.${quote(s.call)}=c.${quote(c.id)}`;
    else if (s.conversation && c.conversation)
      join = ` LEFT JOIN call_summaries s ON s.${quote(s.conversation)}=c.${quote(c.conversation)}`;
    if (join) projection += ", " + this.projection(s, "s", "summary_");
    const where: string[] = [],
      values: unknown[] = [];
    if (id) {
      where.push(`c.${quote(c.id)}=?`);
      values.push(id);
    }
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<="],
    ] as const)
      if (input[key]) {
        where.push(
          `${this.timestamp("calls", `c.${quote(c.time)}`)} ${op} julianday(?)`,
        );
        values.push(input[key]);
      }
    if (input.direction) {
      this.require(c, "direction");
      where.push(`c.${quote(c.direction)}=?`);
      values.push(input.direction);
    }
    if (input.priority) {
      if (!join) throw new Error("Summary join unavailable");
      this.require(s, "priority");
      where.push(`s.${quote(s.priority)}=?`);
      values.push(input.priority);
    }
    if (query) {
      const fields = [
        c.phone && `c.${quote(c.phone)}`,
        c.destination && `c.${quote(c.destination)}`,
        join && s.summary && `s.${quote(s.summary)}`,
      ].filter(Boolean) as string[];
      if (!fields.length) throw new Error("No searchable fields");
      where.push(
        "(" + fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(" OR ") + ")",
      );
      const term = "%" + query.replace(/[\\%_]/g, "\\$&") + "%";
      fields.forEach(() => values.push(term));
    }
    const sql = `SELECT ${projection} FROM calls c${join}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY ${this.timestamp("calls", `c.${quote(c.time)}`)} DESC, c.${quote(c.id)} DESC LIMIT ?`;
    return (
      await this.db
        .prepare(sql)
        .bind(...values, input.limit)
        .all()
    ).results;
  }
  async outbound(input: z.infer<typeof statusInput>) {
    const m = await this.mapping("outbound_requests");
    this.require(m, "id", "time");
    // Only allowlisted fields are selected: callback_token and webhook credentials never leave D1.
    return (
      await this.db
        .prepare(
          `SELECT ${this.projection(m, "o")} FROM outbound_requests o${input.id ? ` WHERE o.${quote(m.id)}=?` : ""} ORDER BY ${this.timestamp("outbound_requests", `o.${quote(m.time)}`)} DESC LIMIT ?`,
        )
        .bind(...(input.id ? [input.id] : []), input.limit)
        .all()
    ).results;
  }
}
